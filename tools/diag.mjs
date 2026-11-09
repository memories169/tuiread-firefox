// Chan doan: chu Han con sot lai sau khi chay content.js la do node chua duoc xu ly hay do engine khong dich duoc?
// Dung: node tools/diag.mjs [uukanshu|piaotia]

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine, parseDict, parseT2S, decode } from '../engine/index.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readFile = name => fs.readFileSync(path.join(root, 'dict', name));
const engine = await loadEngine(readFile, {});

const CASES = {
  uukanshu: { file: 'uukanshu_chap1234.html', url: 'https://uukanshu.cc/book/21897/16209308.html', sel: '.readcotent' },
  piaotia: { file: 'piaotia_chap1_utf8.html', url: 'https://www.piaotia.com/html/16/16728/13058667.html', sel: null }
};

const which = process.argv[2] || 'uukanshu';
const c = CASES[which];
const HAN = /[㐀-䶿一-鿿豈-﫿]/g;
const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'OPTION', 'TITLE', 'IFRAME', 'TEMPLATE']);

const html = fs.readFileSync(path.join(root, 'fixtures', c.file), 'utf8');
const dom = new JSDOM(html, { url: c.url, runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

window.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener() {} },
    sendMessage: (msg, cb) => {
      setTimeout(() => {
        if (msg.type === 'vp:translate') cb({ ok: true, results: msg.texts.map(t => engine.translate(t).vi) });
        else cb({ ok: true });
      }, 0);
    }
  },
  storage: { local: { get: () => Promise.resolve({ settings: { mode: 'vi', firstMeaning: true }, hostState: {} }), set: () => Promise.resolve() } }
};

// snapshot cac node co chu Han TRUOC khi content.js chay
function textNodes(el) {
  const out = [];
  const walker = window.document.createTreeWalker(el, window.NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
  return out;
}
const scope = c.sel ? window.document.querySelector(c.sel) : window.document.body;
const beforeNodes = textNodes(scope);
const hanBefore = beforeNodes.reduce((sum, n) => sum + ((n.nodeValue || '').match(HAN) || []).length, 0);
const eligible = beforeNodes.filter(n => {
  const t = n.nodeValue || '';
  return t.trim() && HAN_RE.test(t) && n.parentElement && !SKIP_TAGS.has(n.parentElement.tagName);
});
const hanEligible = eligible.reduce((sum, n) => sum + ((n.nodeValue || '').match(HAN) || []).length, 0);

window.eval(fs.readFileSync(path.join(root, 'content.js'), 'utf8'));

const t0 = Date.now();
while (Date.now() - t0 < 10000) {
  const now = textNodes(c.sel ? window.document.querySelector(c.sel) : window.document.body);
  const han = now.reduce((sum, n) => sum + ((n.nodeValue || '').match(HAN) || []).length, 0);
  if (han <= hanBefore * 0.15) break;
  await new Promise(r => setTimeout(r, 150));
}

const scopeNow = c.sel ? window.document.querySelector(c.sel) : window.document.body;
const afterNodes = textNodes(scopeNow);
let hanAfter = 0;
const leftovers = [];
for (const n of afterNodes) {
  const t = n.nodeValue || '';
  const hits = t.match(HAN) || [];
  if (!hits.length) continue;
  hanAfter += hits.length;
  leftovers.push({
    node: n,
    text: t,
    han: hits.length,
    parent: n.parentElement ? n.parentElement.tagName : '-',
    inOrig: !!(n.parentElement && n.parentElement.closest('.vp-orig')),
    skipped: !!(n.parentElement && SKIP_TAGS.has(n.parentElement.tagName)),
    empty: !t.trim()
  });
}

console.log('=== ' + which + ' (' + (c.sel || 'fallback khoi Han') + ')');
console.log('  so node text: ' + beforeNodes.length + ' | co Han va hop le: ' + eligible.length);
console.log('  chu Han trong scope: ' + hanBefore + ' (hop le ma content.js phai lo: ' + hanEligible + ')');
console.log('  chu Han con lai: ' + hanAfter + ' (' + (hanAfter / hanBefore * 100).toFixed(1) + '%) tren ' + leftovers.length + ' node');
console.log('  node bo qua vi SKIP_TAGS: ' + leftovers.filter(l => l.skipped).length + ' (' + leftovers.filter(l => l.skipped).reduce((s, l) => s + l.han, 0) + ' ky tu)');

const real = leftovers.filter(l => !l.skipped);
const byCount = real.slice().sort((a, b) => b.han - a.han);
console.log('\n  --- 12 node con nhieu chu Han nhat (khong phai script/style) ---');
for (const l of byCount.slice(0, 12)) {
  console.log('  [' + l.parent + ' ' + l.han + ' Han] ' + JSON.stringify(l.text).slice(0, 220));
}

// chay lai qua engine truc tiep de biet engine co dich duoc khong
console.log('\n  --- engine dich lai chinh node con sot ---');
const stuckTokens = new Map();
for (const l of byCount.slice(0, 6)) {
  const r = engine.translate(l.text);
  const stillHan = (r.vi.match(HAN) || []).length;
  console.log('  ' + l.han + ' Han -> con ' + stillHan + ' | stats=' + JSON.stringify(r.stats));
  console.log('    ra: ' + JSON.stringify(r.vi).slice(0, 200));
}
for (const l of real) {
  const r = engine.translate(l.text);
  if (!r.tokens) continue;
  for (const t of r.tokens) {
    if (t.vi && HAN_RE.test(t.vi)) stuckTokens.set(t.vi, (stuckTokens.get(t.vi) || 0) + 1);
  }
}
const rankedTokens = [...stuckTokens.entries()].sort((a, b) => b[1] - a[1]);
console.log('\n  --- ' + rankedTokens.length + ' token ma engine khong map duoc (van con Chu Han trong ket qua) ---');
console.log('  ' + rankedTokens.slice(0, 60).map(([tok, n]) => tok + '×' + n).join(' | '));

// kiem tra tung ky tu Han con sot: co trong bang phien am (PA) hay bang 繁->簡 khong?
const pa = parseDict(decode(readFile('ChinesePhienAmWords.txt')), { singleChar: true });
const t2sMap = parseT2S(decode(readFile('TSCharacters.txt')));
const vp = parseDict(decode(readFile('VietPhrase.txt')));
const charSet = new Map();
for (const l of real) {
  for (const ch of l.text) {
    if (!HAN_RE.test(ch)) continue;
    charSet.set(ch, (charSet.get(ch) || 0) + 1);
  }
}
const ranked = [...charSet.entries()].sort((a, b) => b[1] - a[1]);
const noPa = ranked.filter(([ch]) => !pa.has(ch));
const noAnything = ranked.filter(([ch]) => !pa.has(ch) && !vp.has(ch));
console.log('\n  --- tan suat ' + ranked.length + ' ky tu Han khac nhau con lai ---');
console.log('  khong co trong PA: ' + noPa.length + ' ky tu (' + noPa.reduce((s, x) => s + x[1], 0) + ' luot xuat hien)');
console.log('  khong co trong PA lan VP: ' + noAnything.length + ' ky tu (' + noAnything.reduce((s, x) => s + x[1], 0) + ' luot)');
console.log('  vi du khong co gi ca: ' + noAnything.slice(0, 40).map(([ch, n]) => ch + ':' + n).join(' '));
console.log('\n  60 ky tu dau (co PA thi in [co], khong thi [—], 繁->簡 có thi (~)):');
console.log('  ' + ranked.slice(0, 60).map(([ch, n]) => ch + ':' + n + (pa.has(ch) ? '[coPA]' : '[—PA]') + (t2sMap.has(ch) ? '(~)' : '')).join(' '));
console.log('  kiem tra: VP co ' + vp.size + ' muc, PA co ' + pa.size + ' don zi, t2s co ' + t2sMap.size + ' don zi');

const uniqAll = [...window.document.body.querySelectorAll('*')].length;
console.log('\n  (tong so phan tu trong tai: ' + uniqAll + ')');
window.close();
