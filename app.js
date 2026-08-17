/* ============================================================
   МОЗГИ ПРИЛОЖЕНИЯ
   Здесь происходит всё: сохранение операций, подсчёт баланса,
   отрисовка экрана. Читается сверху вниз.
   ============================================================ */

// --- 1. Подключаемся к Telegram (если приложение открыто внутри Telegram) ---

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (tg) {
  tg.ready();                                              // сообщаем Telegram: приложение загрузилось
  tg.expand();                                             // разворачиваем на весь экран
  if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); // чтобы свайпом случайно не закрыть
}

// Приложение реально открыто внутри Telegram (а не просто в браузере)?
// Проверяем по initData: он не пустой только внутри настоящего Telegram.
const inTelegram = !!(tg && tg.initData);

// Короткая вибрация при нажатии — работает только внутри Telegram
function buzz(style) {
  if (inTelegram && tg.HapticFeedback) {
    try { tg.HapticFeedback.impactOccurred(style || 'light'); } catch (e) {}
  }
}


// --- 2. Данные приложения ---

const STORAGE_KEY = 'sotka-budget-v1';   // под этим именем данные лежат в памяти телефона

const DEFAULT_CATEGORIES = ['Еда', 'Транспорт', 'Жильё', 'Развлечения', 'Здоровье', 'Подписки', 'Прочее'];

// state — это всё, что приложение про тебя знает
let state = {
  transactions: [],                        // список операций
  categories: DEFAULT_CATEGORIES.slice(),  // список категорий
  updatedAt: 0                             // когда в последний раз что-то менялось
};

let selectedCategory = '';   // пустая строка = «Без категории» (вариант по умолчанию)

// Всё, что мы храним, одной строкой — и в телефон, и в облако уходит именно она
function serialize() {
  return JSON.stringify({
    transactions: state.transactions,
    categories: state.categories,
    updatedAt: state.updatedAt
  });
}

function applyData(data) {
  if (Array.isArray(data.transactions)) state.transactions = data.transactions;
  if (Array.isArray(data.categories))   state.categories   = data.categories;
  state.updatedAt = Number(data.updatedAt) || 0;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    applyData(JSON.parse(raw));

    // Записи, сделанные до появления облака, отметки времени не имеют.
    // Без неё облако не поймёт, что эти данные новее пустоты, — ставим сейчас.
    if (!state.updatedAt && state.transactions.length) state.updatedAt = Date.now();
  } catch (e) {
    console.error('Не удалось прочитать сохранённые данные:', e);
  }
}

function save() {
  state.updatedAt = Date.now();
  const raw = serialize();

  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch (e) {
    console.error('Не удалось сохранить данные:', e);
  }

  scheduleCloudSave(raw);
}


// --- 2б. Облако Telegram: чтобы записи не пропали вместе с телефоном ---

/* Telegram даёт приложению личное хранилище, привязанное к аккаунту, а не к
   устройству. Ограничения: одно значение — до 4096 символов, ключей — до 1024.
   Поэтому длинную историю режем на куски sotka_0, sotka_1, … , а рядом кладём
   оглавление sotka_meta: сколько кусков и когда записаны.

   Память телефона при этом никуда не девается — она остаётся быстрой местной
   копией, с которой приложение рисует экран сразу при запуске. */

const CLOUD_PREFIX = 'sotka_';
const CLOUD_META   = CLOUD_PREFIX + 'meta';
const CHUNK_SIZE   = 3900;      // с запасом от предела в 4096

// Облако есть только внутри Telegram и начиная с Bot API 6.9
const cloud = (inTelegram && tg.CloudStorage &&
               typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast('6.9'))
  ? tg.CloudStorage
  : null;

let cloudTimer     = null;   // отложенная запись
let cloudRetries   = 0;      // сколько раз уже пробовали после ошибки
let cloudFailed    = false;  // последняя попытка провалилась и осталась неотправленной
let sentChunks     = [];     // что в облаке лежит сейчас — чтобы не писать лишнего
let cloudChunkCount = 0;     // сколько кусков там было по последнему оглавлению

// Telegram отвечает через колбэки — заворачиваем в промисы, так читается ровнее
function cloudSet(key, value) {
  return new Promise(function (resolve, reject) {
    cloud.setItem(key, value, function (err, ok) {
      if (err || !ok) reject(err || new Error('Telegram не подтвердил запись'));
      else resolve();
    });
  });
}

function cloudGet(keys) {
  return new Promise(function (resolve, reject) {
    cloud.getItems(keys, function (err, values) {
      if (err) reject(err); else resolve(values || {});
    });
  });
}

function cloudRemove(keys) {
  return new Promise(function (resolve, reject) {
    cloud.removeItems(keys, function (err) {
      if (err) reject(err); else resolve();
    });
  });
}

function splitChunks(raw) {
  const chunks = [];
  for (let i = 0; i < raw.length; i += CHUNK_SIZE) chunks.push(raw.slice(i, i + CHUNK_SIZE));
  return chunks.length ? chunks : [''];
}

// Пишем не на каждое нажатие, а через паузу — иначе засыплем Telegram запросами
function scheduleCloudSave(raw) {
  if (!cloud) return;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(function () { cloudSave(raw); }, 700);
}

async function cloudSave(raw) {
  if (!cloud) return;

  const chunks = splitChunks(raw);
  const stamp = state.updatedAt || Date.now();   // ноль в облако не пишем никогда
  state.updatedAt = stamp;
  setStorageStatus('saving');

  try {
    // Пишем только изменившиеся куски — остальные в облаке уже такие же
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i] !== sentChunks[i]) await cloudSet(CLOUD_PREFIX + i, chunks[i]);
    }

    // Если записей стало меньше, убираем осиротевший хвост
    const extra = [];
    const was = Math.max(sentChunks.length, cloudChunkCount);
    for (let i = chunks.length; i < was; i++) extra.push(CLOUD_PREFIX + i);
    if (extra.length) await cloudRemove(extra);

    // Оглавление пишем последним: пока его нет, в облаке цела прежняя версия
    await cloudSet(CLOUD_META, JSON.stringify({ chunks: chunks.length, updatedAt: stamp }));

    sentChunks = chunks;
    cloudChunkCount = chunks.length;
    cloudRetries = 0;
    cloudFailed = false;
    setStorageStatus('saved');
  } catch (e) {
    console.error('Не удалось сохранить в облако Telegram:', e);
    sentChunks = [];            // в следующий раз перезапишем всё целиком
    cloudFailed = true;
    setStorageStatus('error');

    // Три попытки с растущей паузой: связь могла пропасть на секунду
    if (cloudRetries < 3) {
      cloudRetries++;
      clearTimeout(cloudTimer);
      cloudTimer = setTimeout(function () { cloudSave(serialize()); }, cloudRetries * 4000);
    }
  }
}

/* Попытки с растущей паузой могут кончиться, а связь появиться позже.
   Возвращение в приложение — хороший повод попробовать снова. */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && cloudFailed) {
    cloudRetries = 0;
    clearTimeout(cloudTimer);
    cloudSave(serialize());
  }
});

async function cloudLoad() {
  if (!cloud) {
    setStorageStatus('local');
    return;
  }

  setStorageStatus('loading');

  try {
    const head = await cloudGet([CLOUD_META]);
    const metaRaw = head[CLOUD_META];

    // В облаке пусто — значит, это первый запуск. Отправляем то, что есть.
    if (!metaRaw) {
      if (state.transactions.length) cloudSave(serialize());
      else setStorageStatus('saved');
      return;
    }

    const meta = JSON.parse(metaRaw);
    cloudChunkCount = Number(meta.chunks) || 0;

    // На телефоне свежее — значит, это облако отстало, а не мы
    if (!(Number(meta.updatedAt) > state.updatedAt)) {
      if (Number(meta.updatedAt) < state.updatedAt) cloudSave(serialize());
      else setStorageStatus('saved');
      return;
    }

    const keys = [];
    for (let i = 0; i < cloudChunkCount; i++) keys.push(CLOUD_PREFIX + i);

    const parts = await cloudGet(keys);
    const raw = keys.map(function (k) { return parts[k] || ''; }).join('');
    const data = JSON.parse(raw);

    // Пока читали, человек мог успеть что-то записать — тогда его правка важнее
    if (!(Number(data.updatedAt) > state.updatedAt)) {
      cloudSave(serialize());
      return;
    }

    applyData(data);
    try { localStorage.setItem(STORAGE_KEY, raw); } catch (e) {}

    sentChunks = splitChunks(raw);
    render();
    setStorageStatus('saved');
  } catch (e) {
    console.error('Не удалось прочитать облако Telegram:', e);
    setStorageStatus('error');
  }
}


// --- 3. Помощники для денег и дат ---

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
                'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

function money(n) {
  return nf.format(Math.round(n * 100) / 100) + ' ₽';
}

// Превращает то, что человек напечатал ("1 200,50"), в число 1200.5
function parseAmount(text) {
  const n = parseFloat(String(text).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}

function dayLabel(date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (sameDay(date, today))     return 'Сегодня';
  if (sameDay(date, yesterday)) return 'Вчера';

  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  });
}

function timeLabel(date) {
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function isThisMonth(date) {
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

// Ключи для группировки в отчёте: «2026-08» и «2026-08-11».
// Считаем по местному времени, а не по UTC — иначе ночные операции
// уезжали бы в соседний день.
function monthKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

function dayKey(date) {
  return monthKey(date) + '-' + String(date.getDate()).padStart(2, '0');
}

// «1 операция», «2 операции», «5 операций»
function plural(n, one, few, many) {
  const last = n % 10;
  const tail = n % 100;
  if (last === 1 && tail !== 11) return one;
  if (last >= 2 && last <= 4 && (tail < 10 || tail >= 20)) return few;
  return many;
}


// --- 4. Подсчёты ---

// Баланс = сколько денег «на руках». Банк считается отдельно.
function totals() {
  let balance = 0;
  let savings = 0;

  for (const t of state.transactions) {
    if      (t.type === 'income')    balance += t.amount;
    else if (t.type === 'expense')   balance -= t.amount;
    else if (t.type === 'save')    { balance -= t.amount; savings += t.amount; }
    else if (t.type === 'withdraw'){ balance += t.amount; savings -= t.amount; }
  }
  return { balance: balance, savings: savings };
}

// Сводка за текущий месяц — нужна и решётке, и итогам
function monthSummary() {
  let income = 0, spent = 0, saved = 0;
  const perCategory = {};

  for (const t of state.transactions) {
    if (!isThisMonth(new Date(t.date))) continue;

    if      (t.type === 'income')   income += t.amount;
    else if (t.type === 'save')     saved  += t.amount;
    else if (t.type === 'withdraw') saved  -= t.amount;
    else if (t.type === 'expense') {
      spent += t.amount;
      const key = t.category || 'Без категории';
      perCategory[key] = (perCategory[key] || 0) + t.amount;
    }
  }
  return { income: income, spent: spent, saved: Math.max(saved, 0), perCategory: perCategory };
}

// Итоги по любому набору операций — нужны отчёту для месяца, дня и всего времени
function periodStats(list) {
  let income = 0, spent = 0, saved = 0;

  for (const t of list) {
    if      (t.type === 'income')   income += t.amount;
    else if (t.type === 'expense')  spent  += t.amount;
    else if (t.type === 'save')     saved  += t.amount;
    else if (t.type === 'withdraw') saved  -= t.amount;
  }

  // «Итог» — заработано минус потрачено. Переводы в банк сюда не входят:
  // деньги не исчезли, они просто лежат в другом кармане.
  return { income: income, spent: spent, saved: saved, net: income - spent, count: list.length };
}

// Раскладывает операции по ключу: { '2026-08': [...], '2026-07': [...] }
function groupBy(list, keyOf) {
  const groups = {};
  list.forEach(function (t) {
    const key = keyOf(new Date(t.date));
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });
  return groups;
}


// --- 5. Находим элементы на странице один раз ---

const $ = function (id) { return document.getElementById(id); };

const elBalance      = $('balance');
const elSavings      = $('savings');
const elAmount       = $('amount');
const elNote         = $('note');
const elChips        = $('chips');
const elList         = $('list');
const elMonthTitle   = $('monthTitle');
const elMonthIncome  = $('monthIncome');
const elMonthExpense = $('monthExpense');
const elMonthSaved   = $('monthSaved');
const elByCategory   = $('byCategory');
const elGuilloche    = $('guilloche');
const elSerial       = $('serial');
const elTabs         = document.querySelectorAll('.tab');
const elViewMain     = $('viewMain');
const elViewReport   = $('viewReport');
const elAllIncome    = $('allIncome');
const elAllExpense   = $('allExpense');
const elAllSaved     = $('allSaved');
const elReportMeta   = $('reportMeta');
const elReportList   = $('reportList');
const elStorageDot   = $('storageDot');
const elStorageTitle = $('storageTitle');
const elStorageNote  = $('storageNote');
const elCatModal     = $('catModal');
const elCatList      = $('catList');
const elNewCat       = $('newCat');
const elConfirmModal = $('confirmModal');
const elConfirmText  = $('confirmText');
const elToast        = $('toast');
const elEntryModal   = $('entryModal');
const elEntryTitle   = $('entryTitle');
const elEntrySubmit  = $('entrySubmit');


// --- 5б. Окно записи операции ---

/* Раньше поля ввода висели прямо на главном экране. Теперь экран занят тем,
   сколько денег, а кнопки «Расход», «Доход», «Банк» и «Снять» открывают окно —
   каждая своё, со своим заголовком и цветом подтверждения. */

let entryType = 'expense';   // какую операцию сейчас записываем

function openEntry(type) {
  entryType = type;
  const info = TYPE_INFO[type];

  elEntryTitle.textContent = info.word;
  elEntrySubmit.className = 'act act-wide ' + info.act;
  elChips.hidden = !info.withCategory;

  // Внутри Telegram подтверждает его собственная кнопка — своя не нужна
  elEntrySubmit.hidden = hasMainButton;

  elAmount.value = '';
  elNote.value = '';
  fitAmount();

  elEntryModal.hidden = false;
  syncTelegramChrome();
  buzz();

  // Фокус ставим сразу, тем же нажатием — иначе айфон не покажет клавиатуру
  elAmount.focus();
}

function closeEntry() {
  elEntryModal.hidden = true;
  elAmount.blur();
  syncTelegramChrome();
}

/* Клавиатура закрывает низ экрана. Поджимаем окна ровно на её высоту.

   Внутри Telegram спрашиваем у самого Telegram: областью просмотра там
   распоряжается он, и visualViewport про клавиатуру ничего не сообщает —
   именно поэтому на айфоне кнопка «Записать» оставалась под клавиатурой.
   В обычном браузере работает visualViewport. */
function fitToKeyboard() {
  let covered = 0;

  if (inTelegram && tg.viewportStableHeight && tg.viewportHeight) {
    covered = tg.viewportStableHeight - tg.viewportHeight;
  } else if (window.visualViewport) {
    const vv = window.visualViewport;
    covered = window.innerHeight - vv.height - vv.offsetTop;
  }

  document.documentElement.style.setProperty(
    '--keyboard', Math.max(0, Math.round(covered)) + 'px'
  );
}

if (inTelegram && tg.onEvent) tg.onEvent('viewportChanged', fitToKeyboard);

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitToKeyboard);
  window.visualViewport.addEventListener('scroll', fitToKeyboard);
}

// Достаёт цвет из палитры в style.css — нужен для родной кнопки Telegram
function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* Кнопки самого Telegram: «Назад» закрывает окно, а главная кнопка заменяет
   «Записать». Её рисует Telegram поверх клавиатуры, поэтому спрятать её
   клавиатура не может — в отличие от кнопки внутри страницы. */
function syncTelegramChrome() {
  if (!inTelegram) return;

  const entryOpen = !elEntryModal.hidden;
  const catOpen   = !elCatModal.hidden;

  if (tg.BackButton) {
    if (entryOpen || catOpen) tg.BackButton.show();
    else tg.BackButton.hide();
  }

  if (!tg.MainButton) return;

  // Пока сверху окно категорий, записывать нечего — убираем кнопку
  if (entryOpen && !catOpen) {
    const info = TYPE_INFO[entryType];
    tg.MainButton.setParams({
      text: 'Записать',
      color: cssColor(info.mainColor),
      text_color: cssColor(info.mainTextColor)
    });
    tg.MainButton.show();
  } else {
    tg.MainButton.hide();
  }
}

// Есть ли у нас родная кнопка Telegram вместо кнопки внутри окна
const hasMainButton = !!(inTelegram && tg.MainButton);


// --- 6. Окно подтверждения и всплывающее сообщение ---

// Своё окно вместо системного: работает одинаково и в Telegram, и в браузере
let pendingYes = null;

function ask(text, onYes) {
  elConfirmText.textContent = text;
  elConfirmModal.hidden = false;
  pendingYes = onYes;
}

function closeAsk() {
  elConfirmModal.hidden = true;
  pendingYes = null;
}

let toastTimer = null;

function toast(text) {
  elToast.textContent = text;
  elToast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { elToast.classList.remove('is-visible'); }, 2400);
}


// --- 7. Добавление и удаление операций ---

/* word — как операция называется в истории и в заголовке окна записи
   sign, cls — знак и цвет суммы
   act — каким выглядит подтверждение в окне записи
   withCategory — переводы между кошельками категории не имеют */
const TYPE_INFO = {
  income: {
    word: 'Доход', sign: '+', cls: 'sum-earn', act: 'act-earn', withCategory: true,
    mainColor: '--engrave', mainTextColor: '--paper'
  },
  expense: {
    word: 'Расход', sign: '−', cls: 'sum-ink', act: 'act-spend', withCategory: true,
    mainColor: '--ink', mainTextColor: '--paper'
  },
  save: {
    word: 'В банк', sign: '−', cls: 'sum-vault', act: 'act-vault', withCategory: false,
    mainColor: '--fiber', mainTextColor: '--paper'
  },
  withdraw: {
    word: 'Из банка', sign: '+', cls: 'sum-vault', act: 'act-vault', withCategory: false,
    mainColor: '--fiber', mainTextColor: '--paper'
  }
};

function addTransaction(type) {
  const amount = parseAmount(elAmount.value);

  if (!amount) {
    // сумма не введена — подталкиваем поле и ставим в него курсор
    elAmount.classList.remove('is-nudged');
    void elAmount.offsetWidth;          // хитрость, чтобы анимация запустилась заново
    elAmount.classList.add('is-nudged');
    elAmount.focus();
    return;
  }

  // Нельзя снять из банка больше, чем в нём лежит
  if (type === 'withdraw' && amount > totals().savings) {
    toast('В банке только ' + money(totals().savings));
    return;
  }

  state.transactions.push({
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    type: type,
    amount: amount,
    category: TYPE_INFO[type].withCategory ? selectedCategory : '',
    note: elNote.value.trim(),
    date: new Date().toISOString()
  });

  save();
  buzz('medium');

  // очищаем поля, но выбранную категорию оставляем — удобно вводить подряд
  elAmount.value = '';
  elNote.value = '';
  fitAmount();

  closeEntry();
  render();
}

function deleteTransaction(id) {
  const t = state.transactions.find(function (x) { return x.id === id; });
  if (!t) return;

  ask('Удалить операцию на ' + money(t.amount) + '?', function () {
    state.transactions = state.transactions.filter(function (x) { return x.id !== id; });
    save();
    buzz('rigid');
    render();
  });
}


// --- 8. Отрисовка экрана ---

function renderTotals() {
  const t = totals();
  elBalance.textContent = money(t.balance);
  elBalance.classList.toggle('is-negative', t.balance < 0);
  elSavings.textContent = money(t.savings);

  // Номер как серия на купюре: сколько всего записей сделано
  elSerial.textContent = '№ ' + String(state.transactions.length).padStart(6, '0');

  drawGuilloche(t);
}

// Гильошир — розетка из вложенных волн, как на защитной сетке банкноты.
// Число лепестков берётся из суммы на руках, глубина волны — из банка,
// поворот — из числа операций. Поэтому у каждого состояния счёта свой узор.
function drawGuilloche(t) {
  const magnitude = Math.abs(Math.round(t.balance));

  const petals = 6 + (Math.floor(magnitude / 100) % 9);      // 6…14 лепестков
  const depth  = 7 + (Math.floor(t.savings / 100) % 7);      // 7…13 глубина волны
  const shift  = (magnitude % 360) * Math.PI / 180;          // сдвиг фазы

  const LAYERS = 15;
  let paths = '';

  for (let i = 0; i < LAYERS; i++) {
    const radius = 94 - i * 4.4;                 // кольца сходятся к центру
    const phase  = shift + i * 0.21;             // каждое чуть провёрнуто — отсюда муар
    const fade   = (0.5 - Math.abs(i / (LAYERS - 1) - 0.5)) * 1.5 + 0.18;
    paths += '<path d="' + rosette(radius, depth, petals, phase) + '"' +
             ' fill="none" stroke="currentColor" stroke-width="0.45"' +
             ' opacity="' + fade.toFixed(2) + '"/>';
  }

  // Сам <svg> создаём один раз: тогда поворот копится, а не сбрасывается
  if (!elGuilloche.firstChild) {
    elGuilloche.innerHTML = '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"></svg>';
  }

  const svg = elGuilloche.firstChild;
  svg.innerHTML =
    '<circle cx="100" cy="100" r="97" fill="none" stroke="currentColor"' +
    ' stroke-width="0.5" opacity="0.3"/>' + paths;

  // Каждая новая операция доворачивает узор — «перечеканка»
  requestAnimationFrame(function () {
    svg.style.transform = 'rotate(' + (state.transactions.length * 7) + 'deg)';
  });
}

// Одна волнистая окружность: радиус колеблется по косинусу
function rosette(radius, depth, petals, phase) {
  const STEPS = 220;
  let d = '';
  for (let i = 0; i <= STEPS; i++) {
    const a = i / STEPS * Math.PI * 2;
    const r = radius + depth * Math.cos(petals * a + phase);
    d += (i ? 'L' : 'M') +
         (100 + r * Math.cos(a)).toFixed(2) + ' ' +
         (100 + r * Math.sin(a)).toFixed(2) + ' ';
  }
  return d + 'Z';
}

function renderChips() {
  elChips.innerHTML = '';

  // Первым всегда идёт вариант «Без категории» — он выбран по умолчанию
  const options = [''].concat(state.categories);

  options.forEach(function (cat) {
    const btn = document.createElement('button');
    btn.className = 'chip' + (cat === selectedCategory ? ' is-active' : '');
    btn.textContent = cat === '' ? 'Без категории' : cat;
    btn.onclick = function () {
      selectedCategory = cat;
      buzz();
      renderChips();
    };
    elChips.appendChild(btn);
  });

  // Последняя кнопка — открыть окно управления категориями
  const add = document.createElement('button');
  add.className = 'chip';
  add.textContent = '+ категория';
  add.onclick = openCategories;
  elChips.appendChild(add);
}

function renderMonth() {
  const now = new Date();
  const m = monthSummary();

  elMonthTitle.textContent = MONTHS[now.getMonth()] + ' ' + now.getFullYear();
  elMonthIncome.textContent  = money(m.income);
  elMonthExpense.textContent = money(m.spent);
  elMonthSaved.textContent   = money(m.saved);

  // Топ-4 категории расходов
  const rows = Object.keys(m.perCategory)
    .map(function (name) { return [name, m.perCategory[name]]; })
    .sort(function (a, b) { return b[1] - a[1]; })
    .slice(0, 4);

  elByCategory.innerHTML = '';
  if (!rows.length || m.spent <= 0) return;

  rows.forEach(function (row) {
    const share = (row[1] / m.spent * 100).toFixed(1);
    const el = document.createElement('div');
    el.className = 'bar-row';
    el.innerHTML =
      '<div class="bar-top"><span class="bar-name"></span><span class="bar-sum"></span></div>' +
      '<div class="bar-track"><i class="bar-fill" style="width:' + share + '%"></i></div>';
    el.querySelector('.bar-name').textContent = row[0];
    el.querySelector('.bar-sum').textContent  = money(row[1]);
    elByCategory.appendChild(el);
  });
}

function renderHistory() {
  elList.innerHTML = '';

  if (!state.transactions.length) {
    elList.innerHTML = '<p class="empty">Здесь появятся записи. Начни с кнопки «Расход» или «Доход» наверху.</p>';
    return;
  }

  // Свежие операции — сверху
  const sorted = state.transactions.slice().sort(function (a, b) {
    return new Date(b.date) - new Date(a.date);
  });

  let currentDay = '';

  sorted.forEach(function (t) {
    const date = new Date(t.date);
    const label = dayLabel(date);

    if (label !== currentDay) {
      currentDay = label;
      const head = document.createElement('p');
      head.className = 'day';
      head.textContent = label;
      elList.appendChild(head);
    }

    elList.appendChild(opElement(t));
  });
}

// Одна строка операции. Нажатие удаляет — одинаково в истории и в отчёте
function opElement(t) {
  const date = new Date(t.date);
  const info = TYPE_INFO[t.type];

  const op = document.createElement('button');
  op.className = 'op';
  op.innerHTML =
    '<span class="op-main"><span class="op-title"></span><span class="op-sub"></span></span>' +
    '<span class="op-sum"></span>';

  op.querySelector('.op-title').textContent = t.category || t.note || info.word;
  op.querySelector('.op-sub').textContent =
    (t.category && t.note ? t.note + ' · ' : '') + timeLabel(date);

  const sum = op.querySelector('.op-sum');
  sum.textContent = info.sign + ' ' + money(t.amount);
  sum.classList.add(info.cls);

  op.onclick = function () { deleteTransaction(t.id); };
  return op;
}


// --- 8б. Отчёт: месяцы → дни → операции ---

// Какие месяцы и дни сейчас раскрыты. Живёт до перезагрузки, в память не пишется.
const openPeriods = {};

// «+ 1 200 ₽» / «− 340 ₽»
function signedMoney(n) {
  if (n > 0) return '+ ' + money(n);
  if (n < 0) return '− ' + money(-n);
  return money(0);
}

function netClass(n) {
  if (n > 0) return 'sum-earn';
  if (n < 0) return 'sum-ink';
  return 'sum-muted';
}

// Хвост подписи про переводы: показываем, только если они были
function bankNote(saved) {
  if (saved > 0) return ' · в банк ' + money(saved);
  if (saved < 0) return ' · из банка ' + money(-saved);
  return '';
}

function renderReport() {
  const all = periodStats(state.transactions);

  elAllIncome.textContent  = money(all.income);
  elAllExpense.textContent = money(all.spent);
  elAllSaved.textContent   = money(Math.max(all.saved, 0));

  elReportList.innerHTML = '';

  if (!all.count) {
    elReportMeta.textContent = '';
    elReportList.innerHTML =
      '<p class="empty">Записей пока нет. Отчёт заполнится сам, как только появится первая.</p>';
    return;
  }

  // С какого дня ведётся учёт — самая ранняя операция
  const first = state.transactions.reduce(function (a, b) {
    return new Date(a.date) < new Date(b.date) ? a : b;
  });

  elReportMeta.textContent =
    all.count + ' ' + plural(all.count, 'операция', 'операции', 'операций') + ' · с ' +
    new Date(first.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  // Свежие месяцы — сверху. Ключи вида «2026-08» сортируются как обычные строки
  const byMonth = groupBy(state.transactions, monthKey);

  Object.keys(byMonth).sort().reverse().forEach(function (key) {
    elReportList.appendChild(monthBlock(key, byMonth[key]));
  });
}

function monthBlock(key, list) {
  const stats = periodStats(list);
  const parts = key.split('-');

  const box = document.createElement('div');
  box.className = 'period' + (openPeriods[key] ? ' is-open' : '');

  box.appendChild(periodHead(
    key,
    MONTHS[Number(parts[1]) - 1] + ' ' + parts[0],
    'Доходы ' + money(stats.income) + ' · Расходы ' + money(stats.spent) + bankNote(stats.saved),
    stats.net
  ));

  // Полоса: какую долю доходов месяца съели расходы
  if (stats.income > 0) {
    const share = Math.min(stats.spent / stats.income * 100, 100).toFixed(1);
    const bar = document.createElement('div');
    bar.className = 'bar-track period-bar';
    bar.innerHTML = '<i class="bar-fill" style="width:' + share + '%"></i>';
    box.appendChild(bar);
  }

  if (openPeriods[key]) {
    const body = document.createElement('div');
    body.className = 'period-body';

    const byDay = groupBy(list, dayKey);
    Object.keys(byDay).sort().reverse().forEach(function (dk) {
      body.appendChild(dayBlock(dk, byDay[dk]));
    });

    box.appendChild(body);
  }

  return box;
}

function dayBlock(key, list) {
  const stats = periodStats(list);

  const box = document.createElement('div');
  box.className = 'period period-day' + (openPeriods[key] ? ' is-open' : '');

  box.appendChild(periodHead(
    key,
    dayLabel(new Date(list[0].date)),
    stats.count + ' ' + plural(stats.count, 'операция', 'операции', 'операций') + bankNote(stats.saved),
    stats.net
  ));

  if (openPeriods[key]) {
    const body = document.createElement('div');
    body.className = 'period-body';

    list.slice()
      .sort(function (a, b) { return new Date(b.date) - new Date(a.date); })
      .forEach(function (t) { body.appendChild(opElement(t)); });

    box.appendChild(body);
  }

  return box;
}

// Строка «Хранение» на экране отчёта: честно говорит, где сейчас лежат записи
const STORAGE_TEXT = {
  local: ['Только на этом устройстве', 'is-idle',
    'Записи лежат в памяти этого браузера. Открой «Сотку» внутри Telegram — она начнёт держать копию в облаке, привязанном к аккаунту.'],
  loading: ['Читаю облако Telegram…', 'is-work',
    'Проверяю, нет ли там записей свежее здешних.'],
  saving: ['Сохраняю в облако Telegram…', 'is-work',
    'Копия появится на всех устройствах с этим аккаунтом.'],
  saved: ['Сохранено в облаке Telegram', 'is-live',
    'Записи привязаны к аккаунту, а не к телефону: переустановка Telegram и новый телефон их не тронут.'],
  error: ['Облако Telegram не ответило', 'is-fail',
    'Записи целы на этом устройстве. Попробую сохранить ещё раз.']
};

function setStorageStatus(key) {
  const info = STORAGE_TEXT[key];
  if (!info) return;

  elStorageTitle.textContent = info[0];
  elStorageNote.textContent  = info[2];
  elStorageDot.className = 'storage-dot ' + info[1];
}

// Шапка месяца или дня: раскрывает и сворачивает то, что под ней
function periodHead(key, title, sub, net) {
  const head = document.createElement('button');
  head.className = 'period-head';
  head.setAttribute('aria-expanded', openPeriods[key] ? 'true' : 'false');
  head.innerHTML =
    '<span class="period-mark" aria-hidden="true">▸</span>' +
    '<span class="period-main"><span class="period-title"></span><span class="period-sub"></span></span>' +
    '<span class="period-net"></span>';

  head.querySelector('.period-title').textContent = title;
  head.querySelector('.period-sub').textContent   = sub;

  const sum = head.querySelector('.period-net');
  sum.textContent = signedMoney(net);
  sum.classList.add(netClass(net));

  head.onclick = function () {
    openPeriods[key] = !openPeriods[key];
    buzz();
    renderReport();
  };

  return head;
}

function render() {
  renderTotals();
  renderChips();
  renderMonth();
  renderHistory();
  renderReport();
}

// Переключение между «Счётом» и «Отчётом»
function showView(name) {
  elViewMain.hidden   = name !== 'main';
  elViewReport.hidden = name !== 'report';

  elTabs.forEach(function (tab) {
    const active = tab.dataset.view === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  window.scrollTo(0, 0);
  buzz();
}


// --- 9. Окно управления категориями ---

function openCategories() {
  renderCatList();
  elCatModal.hidden = false;
  syncTelegramChrome();
  buzz();
}

function closeCategories() {
  elCatModal.hidden = true;
  elNewCat.value = '';
  syncTelegramChrome();
}

function renderCatList() {
  elCatList.innerHTML = '';

  if (!state.categories.length) {
    elCatList.innerHTML = '<p class="empty">Категорий пока нет. Добавь первую ниже.</p>';
    return;
  }

  state.categories.forEach(function (cat) {
    const item = document.createElement('div');
    item.className = 'cat-item';
    item.innerHTML = '<span class="cat-name"></span><button class="cat-del">Удалить</button>';
    item.querySelector('.cat-name').textContent = cat;
    item.querySelector('.cat-del').onclick = function () {
      state.categories = state.categories.filter(function (c) { return c !== cat; });
      if (selectedCategory === cat) selectedCategory = '';   // возвращаемся к «Без категории»
      save();
      renderCatList();
      render();
    };
    elCatList.appendChild(item);
  });
}

function addCategory() {
  const name = elNewCat.value.trim();
  if (!name) return;

  if (!state.categories.includes(name)) {
    state.categories.push(name);
    save();
  }

  elNewCat.value = '';
  renderCatList();
  render();
  buzz();
}


// --- 10. Связываем кнопки с действиями ---

document.querySelectorAll('.actions .act').forEach(function (btn) {
  btn.onclick = function () { openEntry(btn.dataset.type); };
});

$('entrySubmit').onclick = function () { addTransaction(entryType); };

elEntryModal.querySelectorAll('[data-entry-close]').forEach(function (el) {
  el.onclick = closeEntry;
});

// На компьютере привычно: Enter записывает, Escape закрывает
[elAmount, elNote].forEach(function (field) {
  field.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') addTransaction(entryType);
  });
});

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  if (!elConfirmModal.hidden)   closeAsk();
  else if (!elCatModal.hidden)  closeCategories();
  else if (!elEntryModal.hidden) closeEntry();
});

elTabs.forEach(function (tab) {
  tab.onclick = function () { showView(tab.dataset.view); };
});

// Системная кнопка «Назад» в Telegram закрывает то окно, что сверху
if (inTelegram && tg.BackButton) {
  tg.BackButton.onClick(function () {
    if (!elCatModal.hidden)        closeCategories();
    else if (!elEntryModal.hidden) closeEntry();
  });
}

// Главная кнопка Telegram записывает операцию — она всегда поверх клавиатуры
if (hasMainButton) {
  tg.MainButton.onClick(function () { addTransaction(entryType); });
}

$('btnWithdraw').onclick   = function () { openEntry('withdraw'); };
$('btnCategories').onclick = openCategories;
$('btnAddCat').onclick     = addCategory;

elNewCat.addEventListener('keydown', function (e) { if (e.key === 'Enter') addCategory(); });

elCatModal.querySelectorAll('[data-close]').forEach(function (el) { el.onclick = closeCategories; });

$('confirmYes').onclick = function () {
  const yes = pendingYes;
  closeAsk();
  if (yes) yes();
};
elConfirmModal.querySelectorAll('[data-cancel]').forEach(function (el) { el.onclick = closeAsk; });

// Поле суммы: пускаем только цифры, запятую и точку,
// и подгоняем ширину поля под длину числа
function fitAmount() {
  elAmount.size = Math.max(1, elAmount.value.length);
}

elAmount.addEventListener('input', function () {
  elAmount.value = elAmount.value.replace(/[^\d.,]/g, '');
  fitAmount();
});


// --- 11. Запуск ---

// Микротекст по краям экрана — как на защитной печати
document.querySelectorAll('.microtext').forEach(function (el) {
  el.textContent = 'XXX77 · '.repeat(70);
});

load();
fitAmount();

// Текущий месяц в отчёте сразу раскрыт — с ним и работают чаще всего
openPeriods[monthKey(new Date())] = true;

render();

// Экран уже нарисован из памяти телефона. Теперь без спешки сверяемся с облаком.
cloudLoad();
