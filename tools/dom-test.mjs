// Test end-to-end lop DOM (content.js) bang jsdom + engine that + tu dien that.
// Dung: node tools/dom-test.mjs [--mode vi-han] [--restore] [--no-chrome]

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../engine/index.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readFile = name => fs.readFileSync(path.join(root, 'dict', name));
const engine = await loadEngine(readFile, {});

const argMode = (() => { const i = process.argv.indexOf('--mode'); return i > 0 ? process.argv[i + 1] : 'vi'; })();
const wantRestore = process.argv.includes('--restore');
const noChrome = process.argv.includes('--no-chrome');

const CASES = [
  { label: 'uukanshu.cc (繁體, co selector)', file: 'uukanshu_chap1234.html', url: 'https://uukanshu.cc/book/21897/16209308.html' },
  { label: 'piaotia.com (简体, khong co selector)', file: 'piaotia_chap1_utf8.html', url: 'https://www.piaotia.com/html/16/16728/13058667.html' }
];

const HAN = /[㐀-䶿一-鿿豈-﫿]/g;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'OPTION', 'TITLE', 'IFRAME', 'TEMPLATE']);
const contentSrc = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

function hanIn(node) {
  const m = (node.textContent || '').match(HAN);
  return m ? m.length : 0;
}

function installChromeStub(window, stats) {
  const listeners = [];
  window.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: fn => listeners.push(fn) },
      sendMessage: (msg, cb) => {
        setTimeout(() => {
          try {
            if (msg.type === 'vp:translate') {
              stats.messages++;
              stats.chars += msg.texts.reduce((n, t) => n + t.length, 0);
              cb({ ok: true, results: msg.texts.map(t => engine.translate(t).vi) });
            } else if (msg.type === 'vp:ensure') cb({ ok: true });
            else if (msg.type === 'vp:status') cb({ state: 'ready', loadMs: engine.loadMs, info: engine.info });
            else if (msg.type === 'vp:get-settings') cb({
              ok: true,
              settings: { mode: argMode, firstMeaning: true, translateChrome: !noChrome },
              hostState: {},
              siteSelectors: { 'uukanshu.cc': '.readcotent, #content, article', 'piaotia.com': '#content, .content, td.tbd, #booktext' }
            });
            else cb({ ok: false, error: 'unhandled:' + msg.type });
          } catch (err) {
            cb({ ok: false, error: String(err && err.message) });
          }
        }, 0);
      }
    },
    storage: {
      local: {
        get: () => Promise.resolve({ settings: { mode: argMode, firstMeaning: true, translateChrome: !noChrome }, hostState: {} }),
        set: () => Promise.resolve()
      }
    }
  };
  return listeners;
}

// Choi den khi so chu Han on dinh (khong do gitua chung nhu phien ban truoc).
async function waitSettled(getHan, { quietMs = 700, maxMs = 20000 } = {}) {
  const t0 = Date.now();
  let last = getHan();
  let changedAt = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise(r => setTimeout(r, 100));
    const now = getHan();
    if (now !== last) { last = now; changedAt = Date.now(); }
    else if (Date.now() - changedAt >= quietMs) return { han: now, ms: Date.now() - t0 };
  }
  return { han: getHan(), ms: Date.now() - t0 };
}

for (const testCase of CASES) {
  const html = fs.readFileSync(path.join(root, 'fixtures', testCase.file), 'utf8');
  const dom = new JSDOM(html, { url: testCase.url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const stats = { messages: 0, chars: 0 };
  const listeners = installChromeStub(window, stats);

  // chi do chu Han trong ban dich (bo script/style va bo ca span goc .vp-orig cua che do song ngu)
  const NF = window.NodeFilter;
  const VISIBLE = {
    acceptNode(n) {
      const parent = n.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName)) return NF.FILTER_SKIP;
      if (parent.closest('.vp-orig')) return NF.FILTER_SKIP;
      return NF.FILTER_ACCEPT;
    }
  };
  function visibleHan(rootEl) {
    if (!rootEl) return 0;
    let total = 0;
    const walker = window.document.createTreeWalker(rootEl, NF.SHOW_TEXT, VISIBLE);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) total += hanIn(n);
    return total;
  }

  const containerSel = testCase.file.startsWith('uukanshu') ? '.readcotent' : null;
  const bodyBefore = visibleHan(window.document.body);
  const containerBefore = containerSel ? window.document.querySelector(containerSel) : null;
  const containerHanBefore = containerBefore ? visibleHan(containerBefore) : bodyBefore;
  const before = { han: bodyBefore, children: window.document.body.childNodes.length };

  window.eval(contentSrc);

  const scope = containerSel ? () => visibleHan(window.document.querySelector(containerSel)) : () => visibleHan(window.document.body);
  const settled = await waitSettled(scope);
  const after = visibleHan(window.document.body);
  const afterContainer = containerSel ? visibleHan(window.document.querySelector(containerSel)) : after;
  const ok = settled.han < (containerSel ? containerHanBefore : bodyBefore);
  const origSpans = window.document.querySelectorAll('.vp-orig').length;

  console.log('=== ' + testCase.label);
  console.log('  mode=' + argMode + ' | dich chrome=' + (!noChrome) + ' | tin nhan engine=' + stats.messages + ' (' + stats.chars + ' ky tu, ' + settled.ms + 'ms) | ' + (ok ? 'OK' : 'KHONG thay doi'));
  console.log('  chu Han (phan tho): toan trang ' + before.han + ' -> ' + after + ' (con ' + (after / before.han * 100).toFixed(1) + '%)');
  if (containerSel) console.log('  trong ' + containerSel + ': ' + containerHanBefore + ' -> ' + afterContainer + ' (con ' + (afterContainer / containerHanBefore * 100).toFixed(1) + '%)');
  console.log('  span goc (.vp-orig): ' + origSpans + ' | body con ' + window.document.body.childNodes.length + ' children (truoc ' + before.children + ')');

  const sample = [...window.document.querySelectorAll('br')].length;
  const firstLines = (window.document.body.textContent || '').split('\n').map(s => s.trim()).filter(s => s.length > 30).slice(0, 3);
  for (const line of firstLines) console.log('  > ' + line);

  if (wantRestore) {
    await new Promise(resolve => listeners[0]({ type: 'vp:command', action: 'disable' }, {}, () => resolve()));
    console.log('  sau restore: chu Han = ' + visibleHan(window.document.body) + ' (ky vong ' + before.han + ') | span goc con = ' + window.document.querySelectorAll('.vp-orig').length);
  }
  console.log('  <br> trong body: ' + sample + ' (kiem tra bo site khong pha markup)');
  console.log('');
  window.close();
}
