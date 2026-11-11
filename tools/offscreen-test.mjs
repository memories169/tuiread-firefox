// Test THAT background.js + offscreen.js trong Node, gia lap moi rang buoc cua trinh duyet.
// Tai sao can: khong noi nao ngoai background duoc cham chrome.storage (ca Edge 155 — offscreen
// document khong co, ca Firefox — bang callP callback). Hai file nay la hai context khac nhau
// -> phai noi chung bang mot message bus moi test duoc, va offscreen duoc mo phong ma KHONG co
// chrome.storage (gap that).
// Dung: node tools/offscreen-test.mjs [--slow]

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const simulateSlow = process.argv.includes('--slow');

// ---------------------------------------------------------------- luoong tin nhan giua 2 context
const listeners = { sw: [], offscreen: [], options: [] };
const busLog = [];

function deliver(from, msg) {
  return new Promise(resolve => {
    let answered = false;
    const respond = resp => { if (!answered) { answered = true; resolve(resp); } };
    let asyncWaiters = 0;
    busLog.push(from + ' -> ' + (msg && msg.type));
    for (const name of Object.keys(listeners)) {
      if (name === from) continue;
      for (const fn of listeners[name]) {
        if (fn(msg, { id: 'fake-sender' }, respond) === true) asyncWaiters++;
      }
    }
    if (!asyncWaiters && !answered) setTimeout(() => respond(undefined), 0);
  });
}

const apiFor = name => ({
  id: 'fakeid',
  getURL: p => 'chrome-extension://fakeid/' + p,
  getManifest: () => ({ permissions: ['storage', 'offscreen', 'unlimitedStorage'] }),
  onMessage: { addListener: fn => listeners[name].push(fn) },
  sendMessage: (msg, cb) => {
    deliver(name, msg).then(resp => { if (cb) cb(resp); return resp; });
  }
});

// ---------------------------------------------------------------- service worker (co chrome.storage)
// Luu gia that nhu Edge: settings da user dat truoc, dung de chung minh offscreen DOC duoc no.
const store = {
  settings: { mode: 'vi', firstMeaning: false, skipParticles: false, useRules: true, useNames: true, translateChrome: true },
  hostState: {}
};

// chrome.storage that cua SW: set() phai ban su kien onChanged như trình duyệt thật,
// vì background.js dựa vào đó để phát vp:store-changed cho options đang mở ở tab khác.
const storageWatchers = [];
const fireChanged = obj => {
  const changes = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { oldValue: store[k], newValue: v }]));
  Object.assign(store, obj);
  setTimeout(() => { for (const fn of storageWatchers) fn(changes, 'local'); }, 0);
  return Promise.resolve();
};

// Mock chrome.scripting + chrome.permissions cua SW: luong "them site truyen khac".
const registeredScripts = [];
const removedPermissions = [];
const swChrome = {
  runtime: {
    ...apiFor('sw'),
    getManifest: () => ({
      permissions: ['storage', 'offscreen', 'unlimitedStorage', 'scripting'],
      content_scripts: [{ matches: ['*://uukanshu.cc/*', '*://*.uukanshu.cc/*', '*://www.piaotia.com/*', '*://piaotia.com/*'] }]
    }),
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onConnect: { addListener() {} }
  },
  storage: {
    local: {
      get: keys => Promise.resolve(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, store[k]]))),
      set: obj => fireChanged(obj)
    },
    onChanged: { addListener: fn => storageWatchers.push(fn) }
  },
  offscreen: {
    Reason: { DOM_PARSER: 'DOM_PARSER' },
    hasDocument: () => Promise.resolve(true),
    createDocument: () => Promise.resolve()
  },
  scripting: {
    getRegisteredContentScripts: () => Promise.resolve(registeredScripts.map(s => ({ ...s }))),
    registerContentScripts: scripts => { registeredScripts.push(...scripts.map(s => ({ ...s }))); return Promise.resolve(); },
    unregisterContentScripts: filter => {
      const ids = filter && filter.ids;
      for (let i = registeredScripts.length - 1; i >= 0; i--) {
        if (!ids || ids.includes(registeredScripts[i].id)) registeredScripts.splice(i, 1);
      }
      return Promise.resolve();
    }
  },
  permissions: {
    remove: origins => { removedPermissions.push(origins); return Promise.resolve(); },
    request: () => Promise.resolve(true),
    getAll: () => Promise.resolve({ origins: [] })
  }
};

vm.runInNewContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), {
  chrome: swChrome, console, setTimeout, clearTimeout, Promise
});

// ---------------------------------------------------------------- fetch() cua extension page
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const rel = String(url).replace(/^chrome-extension:\/\/fakeid\//, '');
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return { ok: false, status: 404, url };
  if (opts && opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  const buf = fs.readFileSync(abs);
  if (simulateSlow) await new Promise(r => setTimeout(r, 400));
  return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

// ---------------------------------------------------------------- offscreen: KHONG co chrome.storage
// Dung nhu ban do tren Edge: chi runtime.sendMessage/getURL/onMessage ton tai.
globalThis.chrome = { runtime: apiFor('offscreen') };

const t0 = Date.now();
await import(pathToFileURL(path.join(root, 'offscreen.js')).href);

const ask = msg => deliver('page', msg);   // 'page' = popup/options/content: KHONG phai context nao co listener

async function waitUntil(fn, maxMs, everyMs = 200) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, everyMs));
  }
  return null;
}

let last = null;
let st = null;
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  st = await ask({ type: 'vp:status' });
  const line = st ? st.state + ' | ' + st.message + (typeof st.progress === 'number' ? ' | ' + Math.round(st.progress * 100) + '%' : '') : '(khong tra loi)';
  if (line !== last) { console.log('  [' + String(Math.round((Date.now() - t0) / 100) / 10) + 's] ' + line); last = line; }
  if (st && (st.state === 'ready' || st.state === 'error')) break;
  await new Promise(r => setTimeout(r, 100));
}

console.log('');
const checks = [];
const check = (label, cond, detail) => {
  checks.push({ label, cond: !!cond, detail });
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : '  -> ' + detail));
};

check('offscreen toi duoc "ready" du khong co chrome.storage', st && st.state === 'ready', st && st.message);
check('engine lay settings TU BACKGROUND', st && st.settingsSource === 'background', st && st.settingsSource);

// firstMeaning = false trong store -> "她" phai tra moi nghia cua dict gộp ("Nàng/他"), khong phai "Nàng"
const tr = await ask({ type: 'vp:translate', texts: ['她', '這是系統', '第三章'] });
check('vp:translate chay', tr && tr.ok, tr && tr.error);
check('offscreen dich theo settings cua user (firstMeaning=false giu moi nghia)',
  tr && tr.results[0] === 'Nàng/他', tr && JSON.stringify(tr.results));
check('golden: 這是系統 (firstMeaning=false -> giu moi nghia)',
  tr && tr.results[1] === 'Đây là hệ thống/có hệ thống/có quy củ/có ngăn nắp', tr && tr.results[1]);
check('golden: 第三章 -> Chương 3:', tr && tr.results[2] === 'Chương 3:', tr && tr.results[2]);

// Luật nhân: apposition 'A的[quan hệ][tên]' — '陸鳴的爺爺陸瑾' qua offscreen wrapper
const trLN = await ask({ type: 'vp:translate', texts: ['陸鳴的爺爺陸瑾', '陸檬檬的小女孩'] });
check('luat nhan apposition: 陸鳴的爺爺陸瑾 (khong "nhu the")',
  trLN && trLN.results[0] === 'Gia gia của Lục Minh lục cẩn', trLN && trLN.results && JSON.stringify(trLN.results));
check('luat nhan giu trat tu: 陸檬檬的小女孩',
  trLN && trLN.results[1] === 'Lục Mông Mông tiểu nữ hài', trLN && trLN.results && JSON.stringify(trLN.results));

// status cua offscreen phai nam trong chrome.storage (qua background), popup doc o do
check('engineStatus duoc day sang chrome.storage qua service worker',
  store.engineStatus && store.engineStatus.state === 'ready', store.engineStatus && store.engineStatus.state);

// user bam Luu tren options page -> vp:set di den SW -> SW ghi + day vp:settings -> offscreen tu dung lai
await ask({ type: 'vp:set', patch: { settings: { ...store.settings, firstMeaning: true } } });
const rebuilt = await waitUntil(async () => {
  const s = await ask({ type: 'vp:status' });
  return s && s.state === 'ready' && s.rebuiltFor === 'settings' ? s : null;
}, 30000);
check('vp:set duoc SW ghi that vao chrome.storage', store.settings.firstMeaning === true, store.settings.firstMeaning);
const tr2 = await ask({ type: 'vp:translate', texts: ['她'] });
check('doi firstMeaning -> offscreen tu dung lai engine va lay 1 nghia',
  rebuilt && tr2 && tr2.ok && tr2.results[0] === 'Nàng', (rebuilt ? 'rebuilt ok' : 'khong thay rebuild') + ' ' + JSON.stringify(tr2 && tr2.results));

const reload = await ask({ type: 'vp:reload' });
check('vp:reload van tra loi duoc khi offscreen khong co storage', reload && reload.ok, reload && reload.error);

// ---------------------------------------------------------------- cache + tokenMap + override (moi)
// Node khong co indexedDB -> db.js tu roi ve Map trong RAM: dung chinh duong fallback nay de
// chung minh logic cache/miss/put; IndexedDB that kiem chung bang npm run browser.
const c1 = await ask({ type: 'vp:translate', texts: ['這是系統'] });
check('lan dich dau: cache miss (roi ghi cache)', c1 && c1.ok && c1.stats && c1.stats.misses === 1, JSON.stringify(c1 && c1.stats));
const c2 = await ask({ type: 'vp:translate', texts: ['這是系統'] });
check('dich lai cung doan: trung cache, ket qua nhu cu',
  c2 && c2.ok && c2.stats && c2.stats.hits === 1 && c2.results[0] === 'Đây là hệ thống', JSON.stringify(c2 && c2.stats));

const tk = await ask({ type: 'vp:tokens', texts: ['第三章'] });
check('vp:tokens tra tokens (Hán gốc + nghĩa) cho click-to-edit',
  tk && tk.ok && tk.tokens && tk.tokens[0] && tk.tokens[0][0] && tk.tokens[0][0][0] === '第三章' && tk.tokens[0][0][1] === 'Chương 3:',
  JSON.stringify(tk && tk.tokens));

// Luong user vá một từ trên trang: vp:override-set -> SW ghi + đẩy offscreen -> rebuild
// -> version cache mới -> lần dịch sau miss và dùng engine đã có bản vá.
// Key của override là chữ ĐÃ 繁→簡 (engine tra trên văn bản đã chuẩn hoá) — như token.han mà card click-to-edit hiển thị.
const setOv = await ask({ type: 'vp:override-set', han: '这是系统', vi: 'Đây là Hệ Thống (đã vá)' });
check('vp:override-set ghi ban vá vào chrome.storage qua SW',
  setOv && setOv.ok && store.overrides && store.overrides['这是系统'] === 'Đây là Hệ Thống (đã vá)', JSON.stringify(store.overrides));
check('override-set có bump version (khóa cache cũ tự chết)', setOv && setOv.version >= 1, setOv && setOv.version);
const trOv = await ask({ type: 'vp:translate', texts: ['這是系統'] });
check('dịch theo bản vá sau khi lưu (miss ở version mới, engine đã rebuild)',
  trOv && trOv.ok && trOv.results[0] === 'Đây là Hệ Thống (đã vá)' && trOv.stats && trOv.stats.misses === 1,
  JSON.stringify(trOv && trOv.results) + ' ' + JSON.stringify(trOv && trOv.stats));
const delOv = await ask({ type: 'vp:override-set', han: '这是系统', vi: '' });
const trBack = await ask({ type: 'vp:translate', texts: ['這是系統'] });
check('bỏ vá (vi rỗng) -> trả về nghĩa mặc định của từ điển',
  delOv && delOv.ok && trBack && trBack.ok && trBack.results[0] === 'Đây là hệ thống', JSON.stringify(trBack && trBack.results));

const rep = await ask({ type: 'vp:override-replace', entries: [{ han: '第三章', vi: 'Chương ba:' }] });
check('vp:override-replace thay toàn bộ bản vá',
  rep && rep.ok && rep.overrides['第三章'] === 'Chương ba:' && !rep.overrides['這是系統'], JSON.stringify(rep && rep.overrides));

// ---------------------------------------------------------------- options dong bo qua tin nhan
// options.js KHONG duoc cham chrome.storage: SW nghe onChanged roi phat vp:store-changed.
const storeEvents = [];
listeners.options.push(msg => { if (msg && msg.type === 'vp:store-changed') storeEvents.push(msg); });
const optSync = await ask({ type: 'vp:override-set', han: '社死', vi: 'cái chết xã hội' });
await waitUntil(() => storeEvents.length > 0, 3000);
check('SW phat vp:store-changed khi override doi (options tu cap nhat, khong can storage)',
  optSync && optSync.ok && storeEvents.some(e => (e.keys || []).includes('overrides') && e.overrides && e.overrides['社死'] === 'cái chết xã hội'),
  JSON.stringify(storeEvents[0] || null));
await ask({ type: 'vp:override-set', han: '社死', vi: '' });

// ---------------------------------------------------------------- them site truyen khac (moi)
// popup xin quyen (permissions.request trong cú click) roi goi vp:site-add; SW dang ky script vinh vien.
const siteAdd = await ask({ type: 'vp:site-add', host: 'truyenfull.vn', origins: ['*://truyenfull.vn/*', '*://*.truyenfull.vn/*'] });
check('vp:site-add dang ky content script cho site moi',
  siteAdd && siteAdd.ok && siteAdd.registered === true, JSON.stringify(siteAdd));
const siteDef = await ask({ type: 'vp:site-add', host: 'uukanshu.cc', origins: ['*://uukanshu.cc/*'] });
check('site mac dinh -> bo qua dang ky (chong inject doi)',
  siteDef && siteDef.ok && siteDef.builtin === true, JSON.stringify(siteDef));
const sites = await ask({ type: 'vp:sites' });
check('vp:sites tra site mac dinh + site da them',
  sites && sites.ok && sites.builtin.includes('uukanshu.cc') && sites.builtin.includes('piaotia.com')
    && sites.added.some(s => s.host === 'truyenfull.vn'), JSON.stringify(sites));
const siteRm = await ask({ type: 'vp:site-remove', host: 'truyenfull.vn' });
check('vp:site-remove huy dang ky + thu hoi quyen',
  siteRm && siteRm.ok && siteRm.removed === true && removedPermissions.length === 1, JSON.stringify(siteRm));
const sitesAfter = await ask({ type: 'vp:sites' });
check('sau khi bo, danh sach khong con site do',
  sitesAfter && sitesAfter.ok && !sitesAfter.added.some(s => s.host === 'truyenfull.vn'), JSON.stringify(sitesAfter && sitesAfter.added));

// selector khu vực truyện là cấu hình: mặc định seed cho 2 site gốc, đọc qua SW
const cfg = await ask({ type: 'vp:get-settings' });
check('vp:get-settings tra selector mac dinh cho 2 site goc (content.js khong code cung)',
  cfg && cfg.ok && cfg.siteSelectors && /\.readcotent/.test(cfg.siteSelectors['uukanshu.cc']),
  JSON.stringify(cfg && cfg.siteSelectors));

const fails = checks.filter(c => !c.cond);
console.log('\n  ' + (fails.length ? fails.length + '/' + checks.length + ' buoc FAIL' : checks.length + '/' + checks.length + ' buoc dat') +
  ' | offscreen nap xong trong ' + Math.round(Date.now() - t0) + 'ms (Node).');
process.exit(fails.length ? 1 : 0);
