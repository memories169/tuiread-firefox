// Background (event page): noi luu tru DUY NHAT cua chrome.storage + dam bao engine page ton tai.
// Engine + tu dien KHONG song o day (event page co the unload khi idle).
//
// BAN FIREFOX (port tu Chrome):
//   - Firefox khong ho tro background.service_worker (chi background.scripts -> event page).
//   - Firefox KHONG co chrome.offscreen. Nen engine (offscreen.html + engine/*) song trong mot
//     iframe an CHEN VAO BACKGROUND PAGE. iframe la extension view -> giu event page khong unload
//     khi dang doc trang, va content script giu port keepalive 'vp-keepalive' cho nen khong mat
//     khi popup/options dong. Khi khong con tab nao -> event page unload -> iframe/engine chet ->
//     lan mo trang sau content gui vp:ensure TRUOC khi dich la engine page lai duoc tao.
//   - Neu chay tren Chrome/Edge (background SW) van dung duong cu: chrome.offscreen (neu co API).
//
// VI SAO engine khong tu luu? Do bang probe tren Edge 155 (xem README, muc "Su co hay gap"):
//   trong offscreen document  -> chrome.storage, chrome.tabs, chrome.offscreen,
//                                 chrome.runtime.getManifest deu undefined
//   trong service worker      -> chrome.storage = object, ghi/duoc binh thuong
//   con lai o offscreen        -> chrome.runtime.sendMessage + getURL + onMessage van chay
// Nen moi thuan toan doc/ghi luu tru phai di qua background nay.

const OFFSCREEN_PATH = 'offscreen.html';
const ENGINE_FRAME_ID = 'vp-engine-frame';
const KEEPALIVE_PORT = 'vp:keepalive';

// Selector khu vực truyện mặc định cho 2 site khai sẵn trong manifest. Đây là CẤU HÌNH,
// không phải logic: user sửa/xóa thoải mái trong options (mục "Selector khu vực truyện"),
// site mới thêm vào không có dòng thì content script tự chọn khối nhiều chữ Hán nhất.
const DEFAULT_SITE_SELECTORS = {
  'uukanshu.cc': '.readcotent, #content, article',
  'piaotia.com': '#content, .content, td.tbd, #booktext'
};

// Gọi API extension bang CALLBACK — chay duoc tren CA Chrome va Firefox:
//   - namespace chrome.* cua Firefox ho tro callback (native);
//   - Chrome callback luon ton tai (promise la lop boc them);
//   - cac mock trong test tra Promise (thenable) -> van nhan duoc, test khong doi.
// Day la diem khac Chrome goc (dung `await chrome.xxx()` promise) hay vo hon tren
// Firefox 128: chrome.* khong tra promise -> await undefined -> TypeError.
function callP(target, method, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const once = (finish, value) => { if (!settled) { settled = true; finish(value); } };
    let ret;
    try {
      ret = target[method](...args, value => {
        const err = chrome.runtime.lastError;
        if (err) once(reject, new Error(err.message)); else once(resolve, value);
      });
    } catch (err) { once(reject, err); return; }
    if (ret && typeof ret.then === 'function') ret.then(v => once(resolve, v), e => once(reject, e));
  });
}

// Host được khai sẵn trong manifest -> content script tự inject, KHÔNG đăng ký thêm
// (tránh 2 bản content script chạy chồng nhau trên cùng một trang).
function builtinHosts() {
  const hosts = new Set();
  for (const cs of chrome.runtime.getManifest().content_scripts || []) {
    for (const pattern of cs.matches || []) {
      const host = pattern.replace(/^\*:\/\/(\*\.)?/, '').replace(/\/\*$/, '').replace(/^www\./, '');
      if (host) hosts.add(host);
    }
  }
  return [...hosts];
}

function coveredByBuiltin(host) {
  return builtinHosts().some(b => host === b || host.endsWith('.' + b));
}

function scriptIdFor(host) {
  return 'vp-site-' + host.replace(/[^a-z0-9.-]/g, '-');
}

async function handleSiteAdd(host, origins) {
  if (!host || !Array.isArray(origins) || !origins.length) return { ok: false, error: 'thiếu host/origins' };
  if (coveredByBuiltin(host)) return { ok: true, builtin: true };
  const registered = await callP(chrome.scripting, 'getRegisteredContentScripts');
  const id = scriptIdFor(host);
  if (registered.some(s => s.id === id)) return { ok: true, registered: false, existed: true, id };
  await callP(chrome.scripting, 'registerContentScripts', [{
    id,
    matches: origins,
    js: ['content.js'],
    css: ['styles/content.css'],
    runAt: 'document_idle',
    persistAcrossSessions: true
  }]);
  return { ok: true, registered: true, id };
}

async function handleSiteRemove(host) {
  if (!host) return { ok: false, error: 'thiếu host' };
  const id = scriptIdFor(host);
  const registered = await callP(chrome.scripting, 'getRegisteredContentScripts');
  const hit = registered.find(s => s.id === id);
  if (hit) await callP(chrome.scripting, 'unregisterContentScripts', { ids: [id] });
  try {
    await callP(chrome.permissions, 'remove', { origins: (hit && hit.matches) || ['*://' + host + '/*', '*://*.' + host + '/*'] });
  } catch { /* quyền đã không còn — coi như xong */ }
  return { ok: true, removed: !!hit };
}

// Chrome/Edge: co chrome.offscreen (API chi cua Chrome). Firefox khong co -> nhay sang iframe.
function hasOffscreen() {
  try {
    return typeof chrome !== 'undefined' && !!chrome.offscreen
      && typeof chrome.offscreen.hasDocument === 'function';
  } catch {
    return false;
  }
}

// Firefox (background = event page, co document): chen engine page vao bang iframe an.
// iframe la extension view -> event page khong unload chung no; port keepalive tu content
// script cham nua cho nen tin (xem onConnect duoi day).
function ensureEngineFrame() {
  if (typeof document === 'undefined' || !document.documentElement) return false;
  if (document.getElementById(ENGINE_FRAME_ID)) return true;
  const frame = document.createElement('iframe');
  frame.id = ENGINE_FRAME_ID;
  // KHONG dat sandbox: iframe tro toi trang extension cua CHUNG TA (engine doc dict qua
  // getURL + luu IndexedDB can origin extension). Sandbox se dua iframe sang origin ao
  // -> fetch moz-extension:// bi CORS va IndexedDB bi chan.
  frame.src = chrome.runtime.getURL(OFFSCREEN_PATH);
  frame.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;visibility:hidden';
  (document.body || document.documentElement).appendChild(frame);
  return true;
}

async function ensureOffscreen() {
  // Firefox: engine page = iframe an (khong dung chrome.offscreen duoc).
  if (!hasOffscreen()) return ensureEngineFrame() ? true : Promise.reject(
    new Error('không tạo được engine page: không có chrome.offscreen và background không có document để gắn iframe'));

  try {
    const alive = typeof chrome.offscreen.hasDocument === 'function' ? await chrome.offscreen.hasDocument() : false;
    if (alive) return true;
  } catch { /* hoi lai duoi, tao lai neu can */ }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'Giữ từ điển VietPhrase (~680k mục từ, ~145MB heap) ở renderer riêng và trả kết quả convert cho content script. Service worker bị kill sau 30s idle nên không giữ được dữ liệu này.'
    });
    return true;
  } catch (err) {
    if (String(err && err.message).includes('one offscreen document')) return true;
    throw err;
  }
}

function errText(err) {
  return String((err && err.message) || err);
}

async function readStore() {
  const got = await callP(chrome.storage.local, 'get', ['settings', 'hostState', 'overrides', 'overridesVersion', 'siteSelectors', 'glossaries', 'glossariesVersion']);
  return {
    settings: got.settings || {},
    hostState: got.hostState || {},
    overrides: got.overrides || {},
    overridesVersion: got.overridesVersion || 0,
    siteSelectors: got.siteSelectors || DEFAULT_SITE_SELECTORS,
    glossaries: got.glossaries || {},
    glossariesVersion: got.glossariesVersion || 0
  };
}

// Day settings moi sang engine page de no dung lai engine. Engine chua ton tai
// thi loi "Could not establish connection" la binh thuong: no se tu hoi khi boot.
// GOI CÓ CALLBACK: chrome.runtime.sendMessage khong co callback tren Firefox cu tra
// undefined va ket qua loi bi mat -> settings khong den engine -> user doi ma van cu khong
// kich. callP callback-first dam bao tin van di va loi (khong co receiver) van doc duoc.
async function pushSettings(settings) {
  try {
    await callP(chrome.runtime, 'sendMessage', { type: 'vp:settings', settings });
  } catch {
    /* engine page chua song -> khong can loi */
  }
}

// Day override + version moi sang engine page va CHO no rebuild xong moi tra loi, de content
// script dich lai ngay sau khi luu khong bi dap vao engine cu. Engine page chua song thi
// khong sao: lan boot sau no tu doc ban moi trong storage.
function pushOverrides(overrides, version, timeoutMs = 8000) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      chrome.runtime.sendMessage({ type: 'vp:overrides', overrides, version }, resp => {
        finish(!chrome.runtime.lastError && !!(resp && resp.ok));
      });
    } catch {
      finish(false);
    }
  });
}

// Ghi ban override moi + tang version. Version nay de vao key cache nen tang cu tu huy.
async function writeOverrides(map) {
  const got = await callP(chrome.storage.local, 'get', 'overridesVersion');
  const version = (got.overridesVersion || 0) + 1;
  await callP(chrome.storage.local, 'set', { overrides: map, overridesVersion: version });
  const pushed = await pushOverrides(map, version);
  return { version, pushed };
}

// Ghi glossary per-book (F4) + tăng version riêng. Engine rebuild theo bookKey nên
// mỗi lần lưu chỉ dựng lại engine của sách đó (cache engine-per-book ở offscreen).
async function writeGlossaries(map) {
  const got = await callP(chrome.storage.local, 'get', 'glossariesVersion');
  const version = (got.glossariesVersion || 0) + 1;
  await callP(chrome.storage.local, 'set', { glossaries: map, glossariesVersion: version });
  try { await callP(chrome.runtime, 'sendMessage', { type: 'vp:settings', settings: {} }); } catch { /* engine chưa sống */ }
  return { version };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'vp:ensure') {
    ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // Doc: content script, popup, options va ca engine deu di qua day.
  if (msg.type === 'vp:get-settings') {
    readStore()
      .then(store => sendResponse({ ok: true, viaServiceWorker: true, ...store }))
      .catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // Ghi: mot cho duy nhat viet chrome.storage, va tu bao engine page.
  if (msg.type === 'vp:set') {
    (async () => {
      const patch = msg.patch || {};
      await callP(chrome.storage.local, 'set', patch);
      if ('settings' in patch) await pushSettings(patch.settings || {});
      sendResponse({ ok: true });
    })().catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // Engine page khong co chrome.storage -> no gui status qua day de popup/doc duoc.
  if (msg.type === 'vp:status-push') {
    callP(chrome.storage.local, 'set', { engineStatus: msg.status || {} })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // Sua/bo MOT muc: content script goi sau khi user bam Luu trong card tren trang.
  // vi rong = xoa override (tra ve nghia mac dinh cua tu dien).
  if (msg.type === 'vp:override-set') {
    (async () => {
      const han = String(msg.han || '').trim();
      if (!han) return sendResponse({ ok: false, error: 'thieu chu Han' });
      const got = await callP(chrome.storage.local, 'get', 'overrides');
      const map = got.overrides || {};
      const vi = String(msg.vi == null ? '' : msg.vi).trim();
      if (vi) map[han] = vi;
      else delete map[han];
      const { version, pushed } = await writeOverrides(map);
      sendResponse({ ok: true, overrides: map, version, pushed });
    })().catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // Thay toan bo ban override (options page: cap nhat tu o van ban / nhap file).
  if (msg.type === 'vp:override-replace') {
    (async () => {
      const map = {};
      for (const entry of (msg.entries || [])) {
        const han = String((entry && entry.han) || '').trim();
        const vi = String((entry && entry.vi) == null ? '' : entry.vi).trim();
        if (han && vi) map[han] = vi;
      }
      const { version, pushed } = await writeOverrides(map);
      sendResponse({ ok: true, overrides: map, version, pushed });
    })().catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // ---- F4: glossary per-book ----
  // Sửa MỘT mục trong bộ từ điển riêng của truyện: msg { bookKey, han, vi }.
  // vi rỗng = xoá mục. Trả về bộ glossary của đúng sách đó.
  if (msg.type === 'vp:glossary-set') {
    (async () => {
      const bookKey = String(msg.bookKey || '').trim();
      const han = String(msg.han || '').trim();
      if (!bookKey) return sendResponse({ ok: false, error: 'thiếu bookKey' });
      if (!han) return sendResponse({ ok: false, error: 'thiếu chữ Hán' });
      const got = await callP(chrome.storage.local, 'get', 'glossaries');
      const all = got.glossaries || {};
      const book = { ...(all[bookKey] || {}) };
      const vi = String(msg.vi == null ? '' : msg.vi).trim();
      if (vi) book[han] = vi;
      else delete book[han];
      all[bookKey] = book;
      const { version } = await writeGlossaries(all);
      sendResponse({ ok: true, glossary: book, version });
    })().catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // Thay TOÀN BỘ bộ glossary của một sách (options page): msg { bookKey, entries: [{han, vi}] }.
  if (msg.type === 'vp:glossary-replace') {
    (async () => {
      const bookKey = String(msg.bookKey || '').trim();
      if (!bookKey) return sendResponse({ ok: false, error: 'thiếu bookKey' });
      const got = await callP(chrome.storage.local, 'get', 'glossaries');
      const all = got.glossaries || {};
      const book = {};
      for (const entry of (msg.entries || [])) {
        const han = String((entry && entry.han) || '').trim();
        const vi = String((entry && entry.vi) == null ? '' : entry.vi).trim();
        if (han && vi) book[han] = vi;
      }
      if (Object.keys(book).length) all[bookKey] = book;
      else delete all[bookKey];
      const { version } = await writeGlossaries(all);
      sendResponse({ ok: true, glossary: book, version });
    })().catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // Danh sách các sách đã có glossary + số mục từng sách (options page hiển thị).
  if (msg.type === 'vp:glossary-list') {
    (async () => {
      const got = await callP(chrome.storage.local, 'get', ['glossaries', 'glossariesVersion']);
      const all = got.glossaries || {};
      const books = Object.keys(all).sort().map(key => ({ key, count: Object.keys(all[key]).length }));
      sendResponse({ ok: true, books, version: got.glossariesVersion || 0 });
    })().catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // Thêm site mới: popup da xin quyen truoc (permissions.request phai nam trong cú bam cua
  // user, goi tu popup); background chi lo dang ky content script vinh vien + chong inject doi.
  if (msg.type === 'vp:site-add') {
    (async () => {
      const result = await handleSiteAdd(String(msg.host || ''), msg.origins);
      sendResponse(result);
    })().catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // Bo site da them: huy dang ky + thu hoi quyen. Site mac dinh trong manifest khong bo duoc.
  if (msg.type === 'vp:site-remove') {
    (async () => {
      const result = await handleSiteRemove(String(msg.host || ''));
      sendResponse(result);
    })().catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // Danh sach site cho popup: site mac dinh (dau *) + site da them bo (xoa duoc).
  if (msg.type === 'vp:sites') {
    (async () => {
      const registered = await callP(chrome.scripting, 'getRegisteredContentScripts');
      const added = registered
        .filter(s => s.id && s.id.startsWith('vp-site-'))
        .map(s => ({ id: s.id, host: s.id.slice('vp-site-'.length) }));
      sendResponse({ ok: true, builtin: builtinHosts(), added });
    })().catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  return false;
});

// Port keepalive tu content script (trang dang doc): giu event page + engine iframe song
// trong khi user dang doc, khong cho event page unload va mat engine giua 2 lan doc.
// MDN Background_scripts: background page "does not unload until all visible views and
// message ports are closed". Port dong khi tab dong -> background tu unload sau do.
chrome.runtime.onConnect.addListener(port => {
  if (!port || port.name !== KEEPALIVE_PORT) return;
  port.onMessage.addListener(msg => {
    if (msg === 'ping') { try { port.postMessage('pong'); } catch { /* dong cua ben kia */ } }
  });
  port.onDisconnect.addListener(() => { /* content script roi trang */ });
});

// Storage doi -> bao cho cac trang cua extension (options dang mo o tab khac).
// Chi background nghe chrome.storage: cac noi con lai nhan tin nhan, dung invariant "mot chu
// luu tru duy nhat" va chay duoc ca khi browser nao do bat chrome.storage o page context.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.overrides && !changes.glossaries)) return;
  try {
    chrome.runtime.sendMessage({
      type: 'vp:store-changed',
      keys: Object.keys(changes),
      overrides: changes.overrides ? (changes.overrides.newValue || {}) : undefined,
      glossaries: changes.glossaries ? (changes.glossaries.newValue || {}) : undefined
    }, () => { void chrome.runtime.lastError; });   // khong ai nghe thi thoi
  } catch { /* chua co context nao mo */ }
});

chrome.runtime.onInstalled.addListener(() => { ensureOffscreen().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { ensureOffscreen().catch(() => {}); });
