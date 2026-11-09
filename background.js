// Service worker: chu tich DUY NHAT cua chrome.storage + bao dam offscreen document ton tai.
// Engine + tu dien KHONG song o day (MV3 kill service worker sau 30s idle).
//
// Vi sao offscreen khong tu luu? Do bang probe tren Edge 155 (xem README, muc "Su co hay gap"):
//   trong offscreen document  -> chrome.storage, chrome.tabs, chrome.offscreen,
//                                 chrome.runtime.getManifest deu undefined
//   trong service worker      -> chrome.storage = object, ghi/duoc binh thuong
//   con lai o offscreen       -> chrome.runtime.sendMessage + getURL + onMessage van chay
// Nen moi thuan toan doc/ghi luu tru phai di qua background.js.

const OFFSCREEN_PATH = 'offscreen.html';

// Selector khu vực truyện mặc định cho 2 site khai sẵn trong manifest. Đây là CẤU HÌNH,
// không phải logic: user sửa/xóa thoải mái trong options (mục "Selector khu vực truyện"),
// site mới thêm vào không có dòng thì content script tự chọn khối nhiều chữ Hán nhất.
const DEFAULT_SITE_SELECTORS = {
  'uukanshu.cc': '.readcotent, #content, article',
  'piaotia.com': '#content, .content, td.tbd, #booktext'
};

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
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const id = scriptIdFor(host);
  if (registered.some(s => s.id === id)) return { ok: true, registered: false, existed: true, id };
  await chrome.scripting.registerContentScripts([{
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
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const hit = registered.find(s => s.id === id);
  if (hit) await chrome.scripting.unregisterContentScripts({ ids: [id] });
  try {
    await chrome.permissions.remove({ origins: (hit && hit.matches) || ['*://' + host + '/*', '*://*.' + host + '/*'] });
  } catch { /* quyền đã không còn — coi như xong */ }
  return { ok: true, removed: !!hit };
}

async function hasOffscreen() {
  try {
    return typeof chrome.offscreen.hasDocument === 'function'
      ? await chrome.offscreen.hasDocument()
      : false;
  } catch {
    return false;
  }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
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
  const got = await chrome.storage.local.get(['settings', 'hostState', 'overrides', 'overridesVersion', 'siteSelectors']);
  return {
    settings: got.settings || {},
    hostState: got.hostState || {},
    overrides: got.overrides || {},
    overridesVersion: got.overridesVersion || 0,
    siteSelectors: got.siteSelectors || DEFAULT_SITE_SELECTORS
  };
}

// Day settings moi sang offscreen de no dung lai engine. Neu offscreen chua ton tai
// thi loi "Could not establish connection" la binh thuong: no se tu hoi khi boot.
async function pushSettings(settings) {
  try {
    await chrome.runtime.sendMessage({ type: 'vp:settings', settings });
  } catch {
    /* offscreen chua song */
  }
}

// Day override + version moi sang offscreen va CHO no rebuild xong moi tra loi, de content
// script dich lai ngay sau khi luu khong bi dap vao engine cu. Offscreen chua song thi
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
  const got = await chrome.storage.local.get('overridesVersion');
  const version = (got.overridesVersion || 0) + 1;
  await chrome.storage.local.set({ overrides: map, overridesVersion: version });
  const pushed = await pushOverrides(map, version);
  return { version, pushed };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'vp:ensure') {
    ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // Doc: content script, popup, options va ca offscreen deu di qua day.
  if (msg.type === 'vp:get-settings') {
    readStore()
      .then(store => sendResponse({ ok: true, viaServiceWorker: true, ...store }))
      .catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // Ghi: mot cho duy nhat viet chrome.storage, va tu bao offscreen.
  if (msg.type === 'vp:set') {
    (async () => {
      const patch = msg.patch || {};
      await chrome.storage.local.set(patch);
      if ('settings' in patch) await pushSettings(patch.settings || {});
      sendResponse({ ok: true });
    })().catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  // Offscreen khong co chrome.storage -> no gui status qua day de popup/doc duoc.
  if (msg.type === 'vp:status-push') {
    chrome.storage.local.set({ engineStatus: msg.status || {} })
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
      const got = await chrome.storage.local.get('overrides');
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

  // Them site moi: popup da xin quyen truoc (permissions.request phai nam trong cú bam cua
  // user, goi tu popup); SW chi lo dang ky content script vinh vien + chong inject doi.
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
      const registered = await chrome.scripting.getRegisteredContentScripts();
      const added = registered
        .filter(s => s.id && s.id.startsWith('vp-site-'))
        .map(s => ({ id: s.id, host: s.id.slice('vp-site-'.length) }));
      sendResponse({ ok: true, builtin: builtinHosts(), added });
    })().catch(err => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  return false;
});

// Storage doi -> bao cho cac trang cua extension (options dang mo o tab khac).
// Chi SW nghe chrome.storage: cac noi con lai nhan tin nhan, dung invariant "mot chu
// luu tru duy nhat" va chay duoc ca khi browser nao do cat chrome.storage o page context.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.overrides) return;
  try {
    chrome.runtime.sendMessage({
      type: 'vp:store-changed',
      keys: Object.keys(changes),
      overrides: changes.overrides.newValue || {}
    }, () => { void chrome.runtime.lastError; });   // khong ai nghe thi thoi
  } catch { /* chua co context nao mo */ }
});

chrome.runtime.onInstalled.addListener(() => { ensureOffscreen().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { ensureOffscreen().catch(() => {}); });
