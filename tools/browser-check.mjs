// Do TREN TRINH DUYET THAT (Edge/Chrome), khong phai jsdom: nap goi extension vao profile tam,
// mo trang that cua site, dem chu Han con lai sau khi content script + engine chay xong.
//
// Tai sao can file nay: jsdom khong biet rang Edge khong cap chrome.storage cho offscreen document.
// Nhung thu "co ve chay" trong Node van co the chet o buoc dau tien tren trinh duyet.
//
// Dung:
//   node tools/browser-check.mjs                       # Edge headless + profile tam /tmp/vp-edge-profile
//   node tools/browser-check.mjs --port=9333 --keep    # attach vao Edge dang chay, don tab cua no
//   node tools/browser-check.mjs --url=https://...     # them/doi URL test (laptop duoc)
//   node tools/browser-check.mjs --mode=vi-han         # do ma song ngu (mac dinh: vi)
//
// An toan: luon dung --user-data-dir tam trong /tmp, KHONG bao gio mo profile that cua ban,
// va chi kill ding trinh duyet do no sinh ra.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const flag = name => process.argv.includes('--' + name);

const PORT = Number(arg('port') || 9333);
// Profile TINH THEO LAN CHAY. Ly do da do: Edge chi nap extension bang --load-extension khi
// profile con moi; dung lai profile cu -> khong service worker, khong offscreen, trang nguyen
// van Tieng Trung. Muon do lai lan 2 thi gan --profile=<duong dan> hoac attach vao Edge
// ma ban da Load unpacked thu cong (--port o muc dung).
const PROFILE = arg('profile') || '/tmp/vp-edge-profile-' + process.pid;
const REUSE = flag('reuse');
const BROWSER = arg('browser') || 'microsoft-edge';
const MODE = arg('mode') || 'vi';
const KEEP = flag('keep');
const DEBUG = 'http://127.0.0.1:' + PORT;

const URLS = process.argv.filter(a => a.startsWith('http')).concat([
  'https://www.piaotia.com/html/16/16728/13058667.html',
  'https://uukanshu.cc/book/21897/16209308.html'
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const record = (label, cond, detail) => {
  results.push({ label, cond: !!cond, detail });
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + label + (detail === undefined || detail === '' ? '' : '  -> ' + String(detail).slice(0, 260)));
};

async function targets() {
  try { return await (await fetch(DEBUG + '/json/list')).json(); } catch { return []; }
}

// ---------------------------------------------------------------- khong phai Node WS -> goi CDP thuan
function cdp(wsUrl, calls, timeoutMs = 30000) {
  return new Promise(resolve => {
    const out = {};
    const want = {};
    let seq = 0;
    let settled = false;
    let ws;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); try { ws && ws.close(); } catch (e) {} resolve(out); };
    const timer = setTimeout(finish, timeoutMs);
    try { ws = new WebSocket(wsUrl); } catch (e) { out.__err = 'WS ' + e.message; return finish(); }
    ws.onerror = () => { out.__err = 'WS-ERR'; finish(); };
    ws.onopen = () => {
      for (const [method, params] of calls) {
        const id = ++seq;
        want[id] = method;
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      }
    };
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (!(msg.id in want)) return;
      const key = want[msg.id];
      if (msg.error) { out[key] = 'ERR ' + JSON.stringify(msg.error).slice(0, 160); return; }
      const r = msg.result || {};
      const res = r.result;
      if (res && 'value' in res) out[key] = res.value;
      else if (r.exceptionDetails) out[key] = 'JS-ERR ' + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 160);
      else out[key] = r.targetId || true;
      if (Object.keys(out).length >= calls.length) finish();
    };
  });
}

const evaluate = (wsUrl, expression, timeoutMs) =>
  cdp(wsUrl, [['Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }]], timeoutMs)
    .then(out => out['Runtime.evaluate']);

// ---------------------------------------------------------------- danh thuc Edge
let spawned = null;
async function ensureBrowser() {
  if ((await targets()).length) return 'attach';
  if (!REUSE && fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true });
  if (!fs.existsSync(PROFILE)) fs.mkdirSync(PROFILE, { recursive: true });
  console.log('  (profile moi: ' + PROFILE + (REUSE ? ', giu nguyen neu da co' : '') + ')');
  const args = [
    '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT,
    '--disable-extensions-except=' + root,
    '--load-extension=' + root,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    'about:blank'
  ];
  console.log('  khoi dong ' + BROWSER + ' headless (profile tam ' + PROFILE + ')...');
  spawned = spawn(BROWSER, args, { stdio: 'ignore', detached: true });
  spawned.on('error', () => { spawned = null; });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await targets()).length) return 'spawned';
    await sleep(1000);
  }
  return null;
}

console.log('== 0. Ket noi trinh duyet ==');
const how = await ensureBrowser();
if (!how) {
  console.log('  KHONG ket noi duoc CDP o ' + DEBUG + '. Chay thu: ' + BROWSER + ' --remote-debugging-port=' + PORT);
  process.exit(1);
}
record('CDP san sang (nguon: ' + how + ')', true);

// ---------------------------------------------------------------- tim context cua extension
// Tim context THEO ID EXTENSION CUA TA. Edge ch chay ke ca extension cua no (Microsoft Voices...)
// va nhung SW do KHONG co chrome.storage -> gan sai target = ket luan sai (da mac phai).
let extId = null;
async function findTargets() {
  const list = await targets();
  const mine = t => extId && String(t.url || '').startsWith('chrome-extension://' + extId);
  return {
    off: list.find(t => /offscreen\.html/.test(t.url)),
    sw: list.find(t => t.type === 'service_worker' && mine(t)),
    page: list.find(t => t.type === 'page'),
    list
  };
}

let ctx = await findTargets();
let extIdReady = false;

async function locateOffscreen() {
  // Offscreen document KHONG phai luc nao cung co: no duoc tao tai onInstalled/onStartup
  // hoac khi co trang goi vp:ensure. Profile da cai roi thi lan khoi dong nay can ta tu kich.
  for (let attempt = 0; attempt < 6; attempt++) {
    ctx = await findTargets();
    if (ctx.off) { extId = ctx.off.url.split('/')[2]; extIdReady = true; return true; }

    // (a) goi truc tiep ham ensureOffscreen() da export trong service worker
    const swNow = ctx.sw || (await wakeSW());
    if (swNow) {
      const r = await evaluate(swNow.webSocketDebuggerUrl,
        '(async () => { try { return String(await (self.ensureOffscreen ? self.ensureOffscreen() : "khong co ham")); } catch (e) { return "THROW " + e.message; } })()', 15000);
      if (String(r) !== 'THROW Cannot read properties of undefined (reading "ensureOffscreen")') console.log('  (goi ensureOffscreen() trong SW -> ' + r + ')');
    } else if (ctx.page) {
      // (b) van bat tay: mo trang cua site, content script se gui vp:ensure
      console.log('  (khong co SW, mo trang cua site de content script kich hoat offscreen...)');
      await cdp(ctx.page.webSocketDebuggerUrl, [['Page.enable'], ['Page.navigate', { url: URLS[0] }]], 20000);
    }
    const t = Date.now();
    while (Date.now() - t < 12000) {
      await sleep(1500);
      ctx = await findTargets();
      if (ctx.off) { extId = ctx.off.url.split('/')[2]; extIdReady = true; return true; }
    }
  }
  return false;
}

if (!extId && !(await locateOffscreen())) {
  console.log('\n  KHONG co offscreen document. Extension chua nap duoc (xem chrome://extensions).');
  console.log('  Targets hien tai: ' + JSON.stringify((await targets()).map(t => t.type + ':' + String(t.url).slice(0, 46))));
  process.exit(1);
}
record('offscreen document ton tai trong trinh duyet that', extIdReady, 'id ' + extId);

async function wakeSW() {
  ctx = await findTargets();
  if (ctx.sw) return ctx.sw;
  // Phai co mot context KHAC service worker gui tin nhan thi SW moi bi danh thuc
  // (tin nhan gui tu chinh SW khong duoc phan phat lai cho no).
  if (ctx.off) {
    await evaluate(ctx.off.webSocketDebuggerUrl, '(async () => { try { return JSON.stringify(await chrome.runtime.sendMessage({ type: "vp:get-settings" })); } catch (e) { return "THROW " + e.message; } })()', 10000);
  } else if (ctx.page) {
    await cdp(ctx.page.webSocketDebuggerUrl, [['Page.enable'], ['Page.navigate', { url: URLS[0] }]], 15000);
  }
  for (let i = 0; i < 25; i++) {
    await sleep(800);
    ctx = await findTargets();
    if (ctx.sw) return ctx.sw;
  }
  return null;
}

const swProbe = expr => '(async () => { try { return ' + expr + '; } catch (e) { return "THROW " + e.message; } })()';

// ---------------------------------------------------------------- 1. chrome.* o moi context
console.log('\n== 1. Ai co chrome.storage (day chinh la nguyen nhan loi hom truoc) ==');
let apis = null;
const tApi = Date.now();
while (Date.now() - tApi < 40000) {
  const swForApis = await wakeSW();
  if (!swForApis) break;
  const line = String(await evaluate(swForApis.webSocketDebuggerUrl, swProbe('JSON.stringify({ storage: typeof chrome.storage, offscreen: typeof chrome.offscreen, url: location.href })'), 15000));
  try { apis = JSON.parse(line); } catch (e) { apis = { raw: line }; }
  if (apis && apis.storage === 'object') break;
  await sleep(2000);
}
record('service worker CUA TA co chrome.storage', apis && apis.storage === 'object', JSON.stringify(apis));

const offApis = String(await evaluate(ctx.off.webSocketDebuggerUrl,
  swProbe('JSON.stringify({ storage: typeof chrome.storage, sendMessage: typeof chrome.runtime.sendMessage, getURL: typeof chrome.runtime.getURL })'), 15000));
record('offscreen KHONG co chrome.storage -> phai hoi SW (do lai tren Edge nay)', /"storage":"undefined"/.test(offApis), offApis);
record('offscreen van goi duoc runtime.sendMessage', /"sendMessage":"function"/.test(offApis), offApis);

// ---------------------------------------------------------------- 2. settings luu + lay lai duoc
console.log('\n== 2. Luu tru di qua service worker ==');
await evaluate(ctx.off.webSocketDebuggerUrl, `(async () => {
  try { return JSON.stringify(await chrome.runtime.sendMessage({ type: 'vp:set', patch: { settings: { mode: '${MODE}', firstMeaning: true, skipParticles: false, useRules: true, useNames: true, translateChrome: true } } })); }
  catch (e) { return 'THROW ' + e.message; }
})()`, 15000);
const readBack = String(await evaluate(ctx.off.webSocketDebuggerUrl,
  swProbe("JSON.stringify(await chrome.runtime.sendMessage({ type: 'vp:get-settings' }))"), 15000));
record('vp:set -> vp:get-settings tra dung settings', new RegExp('"mode":"' + MODE + '"').test(readBack), readBack);

// ---------------------------------------------------------------- 3. engine ready + dich golden
console.log('\n== 3. Engine trong offscreen that ==');
let status = null;
let lastLine = null;
const tReady = Date.now();
while (Date.now() - tReady < 90000) {
  const swNow = await wakeSW();
  if (!swNow) break;
  const line = String(await evaluate(swNow.webSocketDebuggerUrl, swProbe("JSON.stringify((await chrome.storage.local.get(['engineStatus'])).engineStatus || null)"), 15000));
  if (line !== lastLine) { console.log('  [' + Math.round((Date.now() - tReady) / 1000) + 's] ' + line.slice(0, 220)); lastLine = line; }
  try { status = line === 'null' ? null : JSON.parse(line); } catch (e) { status = null; }
  if (status && (status.state === 'ready' || status.state === 'error')) break;
  await sleep(1500);
}
record('engineStatus trong chrome.storage = ready (popup doc duoc)', status && status.state === 'ready', status && status.message);
record('lay settings TU service worker, khong phai mac dinh', status && status.settingsSource === 'service-worker', status && status.settingsSource);
record('IndexedDB song trong offscreen that (cache ban dich ben lau)', status && status.cache && status.cache.persistent === true, JSON.stringify(status && status.cache));
console.log('  engine: loadMs=' + (status && status.loadMs) + ' | VP=' + (status && status.info && status.info.vp) + ' | VP file=' + (status && status.bytes && status.bytes.vp ? (status.bytes.vp / 1048576).toFixed(1) + 'MB' : '?'));

const swTranslate = await wakeSW();
const golden = String(await evaluate(swTranslate.webSocketDebuggerUrl, swProbe(
  "JSON.stringify(await chrome.runtime.sendMessage({ type: 'vp:translate', texts: ['他没想到对方竟然会如此干脆利落，心中不由得一动。', '百分之五十', '第三章', '這是系統'] }))"), 60000));
record('golden cases chay trong trinh duyet', /50%/.test(golden) && /Chương 3:/.test(golden) && /Đây là hệ thống/.test(golden), golden);

// Cache: dich 2 lan cung doan -> lan 2 phai trung cache (khong do qua engine).
await evaluate(swTranslate.webSocketDebuggerUrl, swProbe(
  "JSON.stringify(await chrome.runtime.sendMessage({ type: 'vp:translate', texts: ['他没想到对方竟然会如此干脆利落，心中不由得一动。'] }))"), 60000);
const golden2 = String(await evaluate(swTranslate.webSocketDebuggerUrl, swProbe(
  "JSON.stringify(await chrome.runtime.sendMessage({ type: 'vp:translate', texts: ['他没想到对方竟然会如此干脆利落，心中不由得一动。'] }))"), 60000));
record('dich lai cung doan: trung cache trong offscreen that', /"hits":1/.test(golden2), golden2.slice(0, 200));

// Override round-trip that: vá -> dịch theo bản vá -> bỏ vá -> về nghĩa mặc định (profile tạm nên không đụng dữ liệu thật).
// LUU Y: phai gui TU OFFSCREEN (nhu content script gui) — runtime.sendMessage tu chinh SW
// khong bao gio giao lai cho listener cua SW, gui tu SW thi vp:override-set khong ai nhan.
const offWs = ctx.off.webSocketDebuggerUrl;
const ovSet = String(await evaluate(offWs, swProbe(
  "JSON.stringify(await chrome.runtime.sendMessage({ type: 'vp:override-set', han: '这是系统', vi: 'Day la he thong da va' }))"), 30000));
record('vp:override-set luu + day offscreen rebuild tren Edge that', /"ok":true/.test(ovSet) && /"pushed":true/.test(ovSet), ovSet.slice(0, 200));
// vp:translate chi offscreen tra loi -> gui tu SW nhu gold o tren (tu offscreen gui thi SW bo qua, khong ai respond)
const goldenOv = String(await evaluate(swTranslate.webSocketDebuggerUrl, swProbe(
  "JSON.stringify(await chrome.runtime.sendMessage({ type: 'vp:translate', texts: ['這是系統'] }))"), 30000));
record('dich theo ban vá vua luu (tokens/spans lay tu cache version moi)', /da va/.test(goldenOv), goldenOv.slice(0, 200));
const ovDel = String(await evaluate(offWs, swProbe(
  "JSON.stringify(await chrome.runtime.sendMessage({ type: 'vp:override-set', han: '这是系统', vi: '' }))"), 30000));
const goldenBack = String(await evaluate(swTranslate.webSocketDebuggerUrl, swProbe(
  "JSON.stringify(await chrome.runtime.sendMessage({ type: 'vp:translate', texts: ['這是系統'] }))"), 30000));
record('bo vá -> ve nghia mac dinh tren Edge that', /"ok":true/.test(ovDel) && /Đây là hệ thống/.test(goldenBack) && !/da va/.test(goldenBack), goldenBack.slice(0, 200));

// ---------------------------------------------------------------- 4. trang that cua site
console.log('\n== 4. Dich tren trang that (content script + engine, qua browser that) ==');

// Dem chu Han LOAI .vp-orig: o che do song ngu, gi nguyen van la ket qua DUNG, khong phai loi.
// (Quen dieu nay tung khien do ban "2148 chu Han con lai" tren trang da dich xong.)
const MEASURE = `(async () => {
  const HAN = /[\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF]/g;
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, SELECT: 1, TEMPLATE: 1 };
  const count = root => {
    let n = 0;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || SKIP[p.tagName] || !node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (p.closest('.vp-orig')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (let x = w.nextNode(); x; x = w.nextNode()) n += (x.nodeValue.match(HAN) || []).length;
    return n;
  };
  const body = document.body || { textContent: '' };
  const txt = c => (c ? c.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200) : '');
  const container = document.querySelector('.readcotent') || document.querySelector('#content') || document.body;
  return JSON.stringify({
    title: document.title.slice(0, 70),
    href: location.href.slice(0, 90),
    hanThanTruyen: count(container),
    hanCaTrang: count(body),
    soSpanGoc: document.querySelectorAll('.vp-orig').length,
    coContainer: !!document.querySelector('.readcotent, #content, .content, td.tbd'),
    coChuViet: /[a-zàáâãèéêìíòóôõùúýăđơư]/i.test(txt(container)),
    blocked: /Attention Required|Just a moment|cf-chl|enable cookies/i.test(document.title + ' ' + txt(document.body)),
    doanDau: txt(container)
  });
})()`;

const samples = [];
const skipped = [];
const skip = (label, detail) => { skipped.push(label); console.log('  SKIP ' + label + '  -> ' + String(detail).slice(0, 200)); };
for (const url of URLS) {
  console.log('\n  --- ' + url + ' ---');
  const live = await findTargets();
  const page = live.page;
  if (!page) { record('mo tab cho ' + url, false, 'khong co page target'); continue; }
  await cdp(page.webSocketDebuggerUrl, [['Page.enable'], ['Page.navigate', { url }]], 20000);

  let result = null;
  let stable = 0;
  let prev = null;
  const tNav = Date.now();
  while (Date.now() - tNav < 60000) {
    await sleep(3000);
    const again = await findTargets();
    const tab = again.page || page;
    const line = await evaluate(tab.webSocketDebuggerUrl, MEASURE, 20000);
    try { result = JSON.parse(line); } catch (e) { result = null; }
    if (!result) { console.log('    [' + Math.round((Date.now() - tNav) / 1000) + 's] ' + String(line).slice(0, 160)); continue; }
    console.log('    [' + Math.round((Date.now() - tNav) / 1000) + 's] than=' + result.hanThanTruyen + ' caTrang=' + result.hanCaTrang + ' goc=' + result.soSpanGoc + ' | ' + result.title);
    if (result.blocked) { console.log('    BI CHAN BOI (Cloudflare/anti-bot) - headless khong qua duoc captcha.'); break; }
    if (!result.coContainer) { console.log('    khong tim thay khoi truyen - co the doi URL (bai 404?)'); break; }
    if (prev === result.hanThanTruyen) { if (++stable >= 2) break; } else stable = 0;
    prev = result.hanThanTruyen;
    if (result.hanThanTruyen === 0) break;
  }
  if (result) {
    const host = url.replace(/^https?:\/\//, '').split('/')[0];
    if (result.blocked) {
      skip(host + ': trang bi chan boi (Cloudflare/anti-bot)', 'headless khong qua duoc captcha -> do bang mat ngu tren chrome cua ban');
    } else if (!result.coContainer) {
      skip(host + ': khong tim thay khoi truyen', 'URL 404 hoac site doi cau truc -> ' + result.doanDau.slice(0, 80));
    } else {
      samples.push({ url, result });
      record(host + ': than truyen con 0 chu Han (tru nguyen van che do song ngu)',
        result.hanThanTruyen === 0, 'han=' + result.hanThanTruyen + ', caTrang=' + result.hanCaTrang + ', goc=' + result.soSpanGoc);
      record(host + ': ket qua ra chu cai Tieng Viet', result.coChuViet, result.doanDau.slice(0, 90));
    }
  }
}

const fails = results.filter(r => !r.cond);
console.log('\n' + '='.repeat(60));
console.log(fails.length ? 'CO ' + fails.length + '/' + results.length + ' buoc FAIL tren trinh duyet that.' : 'TAT CA ' + results.length + ' buoc DAT tren trinh duyet that.');
for (const f of fails) console.log('  - ' + f.label + ' | ' + f.detail);
for (const s of skipped) console.log('  (bo qua: ' + s + ')');
console.log('mode test: ' + MODE + ' | profile: ' + PROFILE);

if (!KEEP && spawned) {
  try { process.kill(-spawned.pid); } catch (e) { try { spawned.kill('SIGTERM'); } catch (e2) {} }
  console.log('  (da dong trinh duyet headless do tool mo ra)');
}
process.exit(fails.length ? 1 : 0);
