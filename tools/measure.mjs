// Do chat luong engine tren 2 chuong that (HTML tai ve tu uukanshu.cc va piaotia.com).
// Dung: node tools/measure.mjs [--show N]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../engine/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dictDir = path.join(here, '..', 'dict');
const testDir = path.join(here, '..', 'fixtures');

const readFile = name => fs.readFileSync(path.join(dictDir, name));
const argShow = (() => {
  const i = process.argv.indexOf('--show');
  return i > 0 ? Number(process.argv[i + 1]) || 6 : 6;
})();

// Lay cac doan van ban co chu Han, mock dung cach content script tach node.
function paragraphsFromHtml(file, pick) {
  let html = fs.readFileSync(path.join(testDir, file), 'utf8');
  if (pick) {
    const m = html.match(pick);
    if (m) html = m[1];
  }
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return html
    .replace(/&emsp;|&nbsp;|&#\d+;/g, '')
    .replace(/&amp;/g, '&')
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => /[㐀-䶿一-鿿]/.test(line) && line.length > 15);
}

const SOURCES = [
  {
    name: 'uukanshu.cc (繁體) chapter 1234',
    file: 'uukanshu_chap1234.html',
    pick: /class="[^"]*readcotent[^"]*"([\s\S]*?)<\/div>/
  },
  {
    name: 'piaotia.com (简体) chapter 1',
    file: 'piaotia_chap1_utf8.html',
    pick: /<div class="toplink"[\s\S]*?<\/div>([\s\S]*?)将本书加入书架/
  }
];

const engine = await loadEngine(readFile, {});
console.log(`engine: VP=${engine.info.vp} Names=${engine.info.names} PA=${engine.info.pa} ` +
  `rules=${engine.info.rules} (bo qua unsupported=${engine.ruleStats.skippedUnsupported}, ` +
  `loi=${engine.ruleStats.skippedInvalid}) t2s=${engine.t2sSize} | load ${engine.loadMs}ms\n`);

let grand = { han: 0, phrase: 0, pa: 0 };
for (const src of SOURCES) {
  const paras = paragraphsFromHtml(src.file, src.pick);
  let han = 0, phrase = 0, pa = 0;
  const t0 = Date.now();
  const results = paras.map(p => {
    const r = engine.translate(p);
    han += r.stats.hanChars; phrase += r.stats.phraseChars; pa += r.stats.paChars;
    return r;
  });
  const ms = Date.now() - t0;
  grand.han += han; grand.phrase += phrase; grand.pa += pa;
  console.log(`### ${src.name}`);
  console.log(`  doan van: ${paras.length} | chu Han: ${han} | phu cum tu >=2 chu: ${(phrase / han * 100).toFixed(1)}% | roi ve âm Hán Việt: ${(pa / han * 100).toFixed(1)}% | ${ms}ms (${(han / Math.max(ms, 1) / 1000).toFixed(1)}k ky tu/s)`);
  for (const r of results.slice(0, argShow)) console.log(`  > ${r.vi}`);
  console.log('');
}
console.log(`TONG: chu Han=${grand.han} phu cum=${(grand.phrase / grand.han * 100).toFixed(1)}%`);
