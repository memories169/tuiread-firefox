// Noi engine + tu dien song: mot page extension rieng (offscreen.html):
//   - Firefox: iframe an chen vao background page (khong co chrome.offscreen) — xem background.js.
//   - Chrome/Edge: offscreen document qua chrome.offscreen — xem background.js.
// Khong nam trong heap cua tab, khong bi kill nhu service worker/event page khi dang doc.
//
// KIEN TRUC: file nay TUYET DOI khong cham chrome.storage. Edge 155 khong cap
// chrome.storage (kem tabs/offscreen/runtime.getManifest) cho offscreen document - da do
// bang probe, xem README "Su co hay gap". Moi doc/ghi luu tru di qua background.js
// bang chrome.runtime.sendMessage, thu van chay duoc trong engine page.

import { decode, FILES, parseDict, parseDictBuffer, parseT2S, createRuleEngine, createEngine } from './engine/index.js';
import { maxKeyLength } from './engine/dict.js';
import { DICT_VERSION, setKeyContext, makeKey, cacheGet, cachePut, cachePrune, cacheStats, cacheClear } from './db.js';

// MARKER PHIÊN BẢN ENGINE: in ra console của background/offscreen để xác minh bản
// đang chạy; 'build' kèm trong MỌI response — content/popup cảnh báo khi lệch bản
// (chống 'zombie engine view' sống sót qua Reload add-on trả kết quả cũ).
const ENGINE_BUILD = '0.6.1';
console.log('[TuiRead] engine build ' + ENGINE_BUILD + ' (DICT_VERSION ' + DICT_VERSION + ', có quy tắc 的)');

const DATA = { vp: null, names: null, pa: null, pronouns: null, t2s: null, rules: null, supplement: null };
// MaxKeyLength tính MỘT LẦN lúc parse, rebuild sau đó chỉ dùng lại (mỗi lần Lưu tiết kiệm ~200ms quét 1M key).
const DATA_MAX = {};
let engine = null;
let status = { state: 'loading', message: 'Chưa khởi động' };

// Hộp đen: 15 sự kiện gần nhất (boot, rebuild, dịch batch, save override, lỗi). Đi kèm
// status-push vào chrome.storage nên sau khi restart Edge (ví dụ sau một lần treo) vẫn
// đọc được trong popup/console để biết nó kẹt ở bước nào. Không ghi gì nhạy cảm.
const recentEvents = [];
function noteEvent(text) {
  const t = new Date();
  recentEvents.push(t.toTimeString().slice(0, 8) + '.' + String(t.getMilliseconds()).padStart(3, '0') + ' ' + text);
  if (recentEvents.length > 15) recentEvents.shift();
}

// Layer override (từ điển vá của user): nạp từ background lúc boot, cập nhật qua vp:overrides.
let overridesMap = new Map();
let overridesVersion = 0;
// Glossary RIÊNG theo truyện (F4): { bookKey: { han: vi } } nạp một lần; khi dịch thì
// background gửi kèm bookKey -> engine dựng lớp đúng cho sách đó (lưu theo bookKey).
let glossariesMap = {};
let glossariesVersion = 0;
let supplementHash = '';
// Engine đang áp dụng bookKey nào (do background gửi kèm vp:translate/vp:tokens).
let appliedBookKey = '';
// Tối đa 4 engine song song (4 truyện đang đọc xen kẽ); quá thì bỏ engine cũ nhất.
const engineByBook = new Map();
const ENGINE_CACHE_MAX = 4;

// Thu tu nap: file nho truoc de engine co the tra loi som, file 36MB cuoi cung.
// File bự (vp, names) parse STREAMING từ buffer: không giữ mảng ~1 triệu dòng trong RAM
// cùng lúc → đỉnh bộ nhớ lúc boot/rebuild thấp hơn rõ (máy ít RAM trống không "ngộp").
const LOAD_ORDER = [
  { key: 't2s', file: FILES.t2s, label: 'Bảng 繁→簡', parse: text => parseT2S(text) },
  { key: 'rules', file: FILES.rules, label: 'Rule QuickTranslate', parse: text => createRuleEngine(text) },
  { key: 'pa', file: FILES.pa, label: 'Phiên âm Hán Việt', parse: text => parseDict(text, { singleChar: true }) },
  { key: 'pronouns', file: FILES.pronouns, label: 'Đại từ', parse: text => parseDict(text) },
  { key: 'pack', file: FILES.pack, label: 'Pack-UuHoa (cộng đồng)', parse: text => parseDict(text), optional: true },
  { key: 'supplement', file: FILES.supplement, label: 'Supplement dict', parse: text => parseDict(text), optional: true },
  { key: 'names', file: FILES.names, label: 'Tên riêng', parse: (text, buffer) => parseDictBuffer(buffer), maxKey: 'namesMax' },
  { key: 'vp', file: FILES.vp, label: 'VietPhrase (1.01 triệu mục từ)', parse: (text, buffer) => parseDictBuffer(buffer), maxKey: 'vpMax' }
];

// Chi nhung settings nay doi thi engine phai dung lai; mode/translateChrome la chuyen cua content.
const ENGINE_KEYS = ['firstMeaning', 'skipParticles', 'useRules', 'useNames'];

const CAN_ASK_SW = !!(typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function');

// Goi background, co tran: event page/SW bi unload sau khi idle la dung thoi quy cua MV3,
// va background ngu khong duoc phep lam engine page treo.
function askSW(message, timeoutMs = 5000) {
  if (!CAN_ASK_SW) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      chrome.runtime.sendMessage(message, response => {
        finish(chrome.runtime.lastError ? null : (response || null));
      });
    } catch {
      finish(null);
    }
  });
}

function setStatus(next) {
  if (next && next.message && next.state) noteEvent('status: ' + next.message);
  status = { ...status, ...next, recent: [...recentEvents] };
  // Day sang background de no viet chrome.storage giup (popup doc tu do).
  if (CAN_ASK_SW) { try { chrome.runtime.sendMessage({ type: 'vp:status-push', status }, () => {}); } catch { /* SW ngu */ } }
}

// Nap tung file mot, co timeout. Ban dau dung Promise.all(6 fetch) -> keo 34MB dong nghit,
// offscreen ket o buoc doc va popup chi con hiện "Đang đọc từ điển" mãi mãi.
async function fetchDict(name, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(chrome.runtime.getURL('dict/' + name), { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buffer = await res.arrayBuffer();
    if (!buffer || buffer.byteLength < 100) throw new Error('file rong (' + (buffer ? buffer.byteLength : 0) + ' byte)');
    return buffer;
  } catch (err) {
    const why = err && err.name === 'AbortError' ? 'het thoi gian cho ' + timeoutMs / 1000 + 's' : String(err && err.message || err);
    throw new Error('dict/' + name + ': ' + why);
  } finally {
    clearTimeout(timer);
  }
}

async function loadData() {
  if (DATA.vp && DATA.rules) return 0;
  const t0 = Date.now();
  const total = LOAD_ORDER.length;
  for (let i = 0; i < total; i++) {
    const step = LOAD_ORDER[i];
    if (DATA[step.key]) continue;
    setStatus({ state: 'loading', message: `Đang đọc ${i + 1}/${total}: ${step.label} (${step.file})`, progress: (i / total) });
    let buffer;
    try {
      buffer = await fetchDict(step.file);
    } catch (err) {
      if (!step.optional) throw err;
      buffer = new TextEncoder().encode('');   // file tùy chọn vắng mặt → lớp rỗng, không chặn boot
    }
    const text = decode(buffer);
    setStatus({ state: 'loading', message: `Đang phân tích ${i + 1}/${total}: ${step.label}`, progress: (i + 0.5) / total });
    DATA[step.key] = step.parse(text, buffer);
    DATA[step.key + 'Bytes'] = buffer.byteLength;
    if (step.maxKey) DATA_MAX[step.maxKey] = maxKeyLength(DATA[step.key]);
    if (step.key === 'supplement') supplementHash = fnv1a(text);
  }
  return Date.now() - t0;
}

// FNV-1a 32-bit — đủ để phát hiện Supplement.txt đổi nội dung (file chỉ vài KB, phí ~0).
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(36);
}

// Settings duoc cache sau lan hoi background thanh cong, de lan sau van chay duoc
// neu background ngu ma ta kip danh thuc.
let settingsCache = {};

function sameEngineSettings(a, b) {
  return ENGINE_KEYS.every(key => String(a[key] === undefined ? '' : a[key]) === String(b[key] === undefined ? '' : b[key]));
}

async function fetchSettings() {
  const got = await askSW({ type: 'vp:get-settings' });
  if (got && got.ok && got.settings) {
    settingsCache = got.settings;
    return { settings: got.settings, fromWorker: true, store: got };
  }
  return { settings: settingsCache, fromWorker: false, store: null };
}

let appliedEngineSettings = {};
let appliedOverridesVersion = -1;

// Key cache phải chết khi bất cứ thứ gì đổi kết quả dịch: dict, supplement, settings ảnh hưởng engine,
// và layer override (bump version mỗi lần user vá một từ).
function cacheContextParts(settings) {
  return [
    'v' + DICT_VERSION,
    'sup' + (supplementHash || 0),
    'ov' + overridesVersion,
    'gl' + glossariesVersion,
    ...ENGINE_KEYS.map(key => key.charAt(0) + String(settings[key] === undefined ? '' : settings[key]))
  ];
}

async function rebuild(reason) {
  noteEvent('rebuild(' + reason + ') bắt đầu');
  const t0 = Date.now();
  const parsedMs = await loadData();
  const { settings, fromWorker, store } = await fetchSettings();
  // Rebuild do override/glossary/settings đổi -> engine-per-book đều stale, xoá sạch.
  // (Rebuild do đổi sách chỉ chuyển appliedBookKey, không tới đây.)
  if (engineByBook.size && !String(reason).startsWith('book:')) engineByBook.clear();
  if (store) {
    overridesMap = new Map(Object.entries(store.overrides || {}));
    overridesVersion = store.overridesVersion || 0;
    glossariesMap = store.glossaries || {};
    glossariesVersion = store.glossariesVersion || 0;
  }
  setKeyContext(cacheContextParts(settings));
  setStatus({ state: 'loading', message: 'Đang dựng engine (lập chỉ mục cụm từ)...', progress: 0.95 });
  // Gộp lớp supplement: Pack-UuHoa (cộng đồng) < Supplement.txt (bản vá tay thắng khi trùng key).
  const supplementMerged = new Map([...(DATA.pack || []), ...(DATA.supplement || [])]);
  // Cache engine theo bookKey: mỗi sách có glossary riêng (F4) -> mỗi sách một engine
  // (dict dùng chung, chỉ lớp glossary khác nhau; VP/names parse một lần nên rẻ).
  const bookKey = typeof appliedBookKey === 'string' ? appliedBookKey : '';
  const bookEngineKey = bookKey || '(chung)';
  if (engineByBook.has(bookEngineKey) && sameEngineSettings(appliedEngineSettings, settings)) {
    engine = engineByBook.get(bookEngineKey);
    setStatus({
      state: 'ready', message: 'Sẵn sàng (engine sách "' + bookEngineKey + '")', progress: 1,
      info: engine.info, overrides: { count: overridesMap.size, version: overridesVersion },
      glossaries: { count: Object.keys(glossariesMap).length, version: glossariesVersion },
      settingsSource: fromWorker ? 'background' : 'cache/mac-dinh'
    });
    return engine;
  }
  const glossary = new Map(Object.entries(glossariesMap[bookEngineKey] || {}));
  engine = createEngine(
    { pa: DATA.pa, vp: DATA.vp, names: DATA.names, pronouns: DATA.pronouns, t2s: DATA.t2s, rules: DATA.rules, overrides: overridesMap, glossary, supplement: supplementMerged, vpMax: DATA_MAX.vpMax, namesMax: DATA_MAX.namesMax },
    settings
  );
  engineByBook.set(bookEngineKey, engine);
  while (engineByBook.size > ENGINE_CACHE_MAX) {
    const oldest = engineByBook.keys().next().value;
    engineByBook.delete(oldest);
  }
  appliedEngineSettings = settings;
  appliedOverridesVersion = overridesVersion;
  const loadMs = Date.now() - t0;
  noteEvent('rebuild(' + reason + ') xong ' + loadMs + 'ms (parse ' + parsedMs + 'ms)');
  cachePrune();   // nền: dọn cache quá đặc, không chặn trả lời
  setStatus({
    state: 'ready',
    message: 'Sẵn sàng',
    progress: 1,
    loadMs,
    parsedMs,
    rebuiltFor: reason,
    info: engine.info,
    rules: { active: DATA.rules.count, unsupported: DATA.rules.stats.skippedUnsupported, invalid: DATA.rules.stats.skippedInvalid },
    t2s: DATA.t2s.size,
    bytes: { vp: DATA.vpBytes, names: DATA.namesBytes, supplement: DATA.supplementBytes },
    cache: cacheStats(),
    overrides: { count: overridesMap.size, version: overridesVersion },
    glossaries: { count: Object.keys(glossariesMap).length, version: glossariesVersion },
    book: bookEngineKey,
    settingsSource: fromWorker ? 'background' : 'cache/mac-dinh',
    warning: fromWorker ? null : 'Background không trả lời — engine dùng settings cache hoặc mặc định'
  });
  return engine;
}

// Mọi rebuild đi qua MỘT chuỗi promise: save override trong lúc boot, hoặc save liên tiếp
// (user vá nhiều từ nhanh) không được phép dựng 2 engine song song — đó là chỗ cấp phát
// đỉnh và jank dễ biến thành cảm giác "treo" trên máy ít RAM trống.
let rebuildChain = Promise.resolve();
function rebuildSerialized(reason) {
  const run = rebuildChain.then(() => rebuild(reason));
  rebuildChain = run.then(() => undefined, () => undefined);   // chuỗi sống tiếp dù lần trước lỗi
  return run;
}

let booting = null;
function boot() {
  if (!booting) booting = rebuildSerialized('boot').finally(() => { setTimeout(() => { booting = null; }, 0); });
  return booting;
}

function fail(err) {
  const message = String(err && err.message || err);
  noteEvent('LỖI: ' + message);
  console.error('[TuiRead offscreen]', message);
  setStatus({ state: 'error', message: 'Lỗi nạp từ điển: ' + message, progress: 0 });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'vp:status') {
    sendResponse(status);
    return false;
  }

  // background day settings sau khi user bam Luu: cache + dung lai engine neu lenh khac.
  if (msg.type === 'vp:settings') {
    settingsCache = msg.settings || {};
    if (engine && !sameEngineSettings(appliedEngineSettings, settingsCache)) rebuildSerialized('settings').catch(fail);
    return false;
  }

  // background day ban override moi sau khi user sua mot tu tren trang. CHO rebuild xong
  // moi tra loi de lan "dich lai" ngay sau do khong dap vao engine cu.
  if (msg.type === 'vp:overrides') {
    (async () => {
      noteEvent('nhận override version ' + (msg.version || 0));
      overridesMap = new Map(Object.entries(msg.overrides || {}));
      overridesVersion = msg.version || 0;
      if (!engine || overridesVersion !== appliedOverridesVersion) {
        appliedBookKey = '';   // buộc rebuild engine-per-book để glossary mới vào đúng sách
        await rebuildSerialized('overrides');
      }
      sendResponse({ ok: true });
    })().catch(err => { fail(err); sendResponse({ ok: false, error: String(err && err.message || err) }); });
    return true;
  }

  // Glossary per-book đổi (lưu từ card/options): đọc lại từ chrome.storage QUA background
  // (invariant một-chỗ-đọc-lưu-trữ) rồi rebuild XONG mới trả lời -> lần dịch lại của trang
  // ngay sau đó chắc chắn dùng bộ mới. Version cũ hơn đang chạy thì bỏ qua (tin cũ đến sau).
  if (msg.type === 'vp:glossaries') {
    (async () => {
      noteEvent('nhận glossary version ' + (msg.version || 0));
      if (msg.version && glossariesVersion && msg.version < glossariesVersion) return sendResponse({ ok: true, stale: true });
      appliedBookKey = '';     // engine-per-book phải dựng lại để nạp glossary mới của sách
      await rebuildSerialized('glossaries');
      sendResponse({ ok: true });
    })().catch(err => { fail(err); sendResponse({ ok: false, error: String(err && err.message || err) }); });
    return true;
  }

  // Xoá toàn bộ cache dịch (IndexedDB + mem) — dùng khi nghi kết quả cũ còn dính
  // (nạp nhầm bản, bump version chưa ăn) hoặc muốn dịch lại từ đầu bằng engine hiện tại.
  if (msg.type === 'vp:cache-clear') {
    (async () => {
      await cacheClear();
      sendResponse({ ok: true, build: ENGINE_BUILD });
    })().catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (msg.type === 'vp:translate') {
    (async () => {
      try {
        const texts = msg.texts || [];
        // Đổi sách (bookKey mới) -> rebuild TRƯỚC khi dịch để lớp glossary đúng.
        if (typeof msg.bookKey === 'string' && msg.bookKey !== appliedBookKey) {
          appliedBookKey = msg.bookKey;
          await rebuildSerialized('book:' + msg.bookKey);
        }
        const keys = texts.map(makeKey);
        const hits = await cacheGet(keys);
        const results = new Array(texts.length);
        let misses = 0;
        const putEntries = [];
        let eng = null;
        for (let i = 0; i < texts.length; i++) {
          if (hits[i]) { results[i] = hits[i].vi; continue; }
          misses++;
          if (!eng) eng = engine || await boot();   // miss moi can engine: chuong da dich thi hien ngay ca khi dict chua nap xong
          const out = eng.translate(texts[i]);
          const vi = out.stats ? out.vi : texts[i];
          results[i] = vi;
          putEntries.push([keys[i], { vi, tokens: out.tokens.map(t => [t.han, t.vi, t.kind]), spans: out.spans, ts: Date.now() }]);
        }
        if (putEntries.length) cachePut(putEntries);   // nen: khong cho ghi xong moi tra loi
        if (misses) noteEvent('dịch batch ' + texts.length + ' node (miss ' + misses + ')');
        sendResponse({ ok: true, build: ENGINE_BUILD, results, stats: { hits: texts.length - misses, misses } });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true;
  }

  // content script hoi tokens + spans cua mot doan DA DICH khi user bam chuot vao no
  // (tokenMap click-to-edit). Ket qua trung cache thi khong can engine.
  if (msg.type === 'vp:tokens') {
    (async () => {
      try {
        const texts = msg.texts || [];
        if (typeof msg.bookKey === 'string' && msg.bookKey !== appliedBookKey) {
          appliedBookKey = msg.bookKey;
          await rebuildSerialized('book:' + msg.bookKey);
        }
        const keys = texts.map(makeKey);
        const hits = await cacheGet(keys);
        const tokens = new Array(texts.length);
        const spans = new Array(texts.length);
        const missIdx = [];
        for (let i = 0; i < texts.length; i++) {
          if (hits[i]) { tokens[i] = hits[i].tokens; spans[i] = hits[i].spans || []; continue; }
          missIdx.push(i);
        }
        if (missIdx.length) {
          const eng = engine || await boot();
          const putEntries = [];
          for (const i of missIdx) {
            const out = eng.translate(texts[i]);
            tokens[i] = out.tokens.map(t => [t.han, t.vi, t.kind, eng.phienOf(t.han), t.raw || '']);
            spans[i] = out.spans;
            putEntries.push([keys[i], { vi: out.stats ? out.vi : texts[i], tokens: tokens[i], spans: out.spans, ts: Date.now() }]);
          }
          cachePut(putEntries);
        } else if (engine) {
          // hit cache: token cũ 3 phần tử - bơm âm Hán Việt ngay trước khi trả về.
          for (let i = 0; i < tokens.length; i++) {
            if (tokens[i] && tokens[i].length) {
              // token cũ 3/4 phần tử -> bơm âm Hán Việt + raw (rỗng nếu không có).
              tokens[i] = tokens[i].map(t => t.length >= 5 ? t : [...t, engine.phienOf(t[0]), '']);
            }
          }
        }
        sendResponse({ ok: true, build: ENGINE_BUILD, tokens, spans, phienOf: (engine || eng).phienOf });
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true;
  }

  if (msg.type === 'vp:rebuild') {
    rebuild(msg.reason || 'settings').then(() => sendResponse({ ok: true, status })).catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  // Nap lai tu đầu, dung khi user bam "Nạp lại" sau mot lan loi.
  if (msg.type === 'vp:reload') {
    DATA.vp = null; DATA.names = null; DATA.pa = null; DATA.pronouns = null; DATA.t2s = null; DATA.rules = null;
    engine = null; booting = null; appliedEngineSettings = {};
    boot().then(() => sendResponse({ ok: true, status })).catch(err => { fail(err); sendResponse({ ok: false, error: String(err && err.message || err) }); });
    return true;
  }

  return false;
});

boot().catch(fail);
