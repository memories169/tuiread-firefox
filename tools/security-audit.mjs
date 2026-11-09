// Kiem tra an toan cua goi extension: ma chay duoc trong trinh duyet + du lieu tu dien + ReDoS.
// Tai sao co file nay: moi logic dich duoc port/co tham chieu tu nguon ben ngoai
// (duongden/script-vietphrase-translator, VietPhrase.txt cua truyencuatui, OpenCC TSCharacters),
// nen phai kiem tra lai chu khong tin theo README cua ho.
//
// Dung: node tools/security-audit.mjs      (npm run audit)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, FILES, parseDict, createRuleEngine } from '../engine/index.js';
import { stripComments } from './lib/strip-comments.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
// Lột comment bằng tokenizer (tools/lib/strip-comments.mjs), KHÔNG bằng regex: regex cũ
// gặp `// dict/*.txt` là nuốt cả khúc code thật -> audit bỏ sót nguy cơ mà vẫn báo sạch.
// Bộ lột tự nó được kiểm ở `npm run check` mục 6a.
const codeOf = f => stripComments(read(f));

const results = [];
const check = (label, cond, detail) => {
  results.push({ label, cond: !!cond, detail });
  console.log('  ' + (cond ? 'ok   ' : 'CHU ') + label + (detail === undefined ? '' : '  -> ' + String(detail).slice(0, 300)));
};
const section = t => console.log('\n== ' + t + ' ==');

// ---------------------------------------------------------------- 1. Ma chay trong trinh duyet
section('1. Ma cua chung ta: nguy co XSS va thuc thi ma dong');
const SHIPPED = ['background.js', 'offscreen.js', 'content.js', 'popup.js', 'options.js', 'db.js'];
const ENGINE_FILES = fs.readdirSync(path.join(root, 'engine')).map(f => 'engine/' + f);
const ALL = SHIPPED.concat(ENGINE_FILES);

const DANGEROUS = [
  ['innerHTML / outerHTML / insertAdjacentHTML', /(\.innerHTML|\.outerHTML|insertAdjacentHTML)\s*[=(]/],
  ['document.write / writeln', /document\.write(?:ln)?\s*\(/],
  ['eval()', /(?<![\w.'])eval\s*\(/],
  ['new Function()', /new\s+Function\s*\(/],
  ['srcdoc / iframe din', /\.srcdoc|createElement\(\s*['"]iframe/i],
  ['setTimeout/setInterval voi chuoi', /set(Timeout|Interval)\s*\(\s*['"`]/],
  ['fetch/XHR den URL ben ngoai', /(?:fetch|XMLHttpRequest)\s*\(\s*['"`]https?:\/\//i],
  ['websocket', /new\s+WebSocket|wss?:\/\//i],
  ['dua du lieu trang vao URL mang', /fetch\s*\([^)]*\+\s*(location|text|node|html)/i]
];

for (const [label, re] of DANGEROUS) {
  const hits = ALL.filter(f => re.test(codeOf(f)));
  check(label + ': khong xuat hien trong ' + ALL.length + ' file ship', hits.length === 0, hits.length ? 'co o ' + hits.join(', ') : '');
}

// Pham vi ghi DOM: chi nodeValue/textContent -> khong the bom HTML vao trang
const domSinks = [];
for (const f of SHIPPED) {
  const src = codeOf(f);
  for (const m of src.matchAll(/(\w+)\.(nodeValue|textContent)\s*=\s*([^;]{0,60})/g)) domSinks.push(f + ': ' + m[2] + ' = ' + m[3].trim().slice(0, 40));
}
check('moi choi ghi van ban deu la nodeValue/textContent (khong phai HTML sink)', domSinks.length > 0);
console.log('       ' + domSinks.length + ' cho ghi: ' + domSinks.slice(0, 4).join(' | '));

// Network: dem va liet ke TOAN BO loi goi mang
const netCalls = [];
for (const f of ALL) for (const m of codeOf(f).matchAll(/fetch\s*\(\s*([^)]{0,80})/g)) netCalls.push(f + ': ' + m[1].trim());
const dictCalls = netCalls.filter(c => /chrome\.runtime\.getURL\('dict\//.test(c));
const urlCalls = netCalls.filter(c => c.startsWith('options.js:') && !/https?:\/\//.test(c));
check('loi goi mang = doc tu dien cua goi + tai file ban va theo URL nguoi dung dan',
  netCalls.length === 2 && dictCalls.length === 1 && urlCalls.length === 1, netCalls.join(' | '));
check('tai URL la GET-only, khong gui du lieu cua nguoi dung len mang',
  !/method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i.test(codeOf('options.js')));

// Quyen: toi thieu, khong <all_urls>
const manifest = JSON.parse(read('manifest.json'));
check('host_permissions khong rong (<all_urls>)', !JSON.stringify(manifest.host_permissions).includes('<all_urls>'), manifest.host_permissions.join(', '));
check('khong co permission bat thuong (debugger/clipboardRead/...)', !['debugger', 'clipboardRead', 'clipboardWrite', 'management', 'webRequest', 'proxy'].some(p => (manifest.permissions || []).includes(p)), (manifest.permissions || []).join(','));
check('khong co content_security_policy tu custom (giu MV3 mac dinh)', !manifest.content_security_policy);

// ---------------------------------------------------------------- 2. Du lieu tu dien
section('2. Du lieu tu dien (34MB) co duoc dung nhu loi thuong khong');
const DANGER = {
  'RTL override U+202E (dao nguong doan van)': /[‮‭‬]/g,
  'control ky tu (khong phai tab/newline)': /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
  'zero-width (tron chu)': /[​-‍⁠﻿]/g,
  'dong dang HTML trong gia tri': /<[a-zA-Z/][^>]*>/,
  'javascript: URI': /javascript\s*:/gi,
  'data: URI': /\bdata:[a-z]+;/gi,
  'URL ben ngoai': /https?:\/\/[^\s"'<>]+/gi,
  'chrome-extension://': /chrome-extension:\/\//g
};

const dictReport = [];
for (const name of fs.readdirSync(path.join(root, 'dict'))) {
  const text = decode(fs.readFileSync(path.join(root, 'dict', name)));
  const found = [];
  for (const [label, re] of Object.entries(DANGER)) {
    const m = text.match(re);
    if (m && m.length) found.push(label + ' = ' + m.length);
  }
  dictReport.push(name + ': ' + (found.length ? found.join(' | ') : 'sach'));
}
for (const line of dictReport) console.log('  ' + line);

// Giai thich tung loai hit da biet, de "CHU" khong bi hieu oan la loi
const vpText = decode(fs.readFileSync(path.join(root, 'dict', FILES.vp)));
const angleRatio = (vpText.match(/<[a-zA-Z/][^>]*>/g) || []).length / (vpText.match(/\n/g) || []).length;
check('<...> trong VietPhrase.txt la ky hieu ghi chu nghia cua VietPhrase, khong phai HTML',
  angleRatio < 0.02, Math.round(angleRatio * 10000) / 100 + '% so dong chua <...> (vi du: <tinh nu>');
check('khi ghi ra trang chi dung nodeValue/textContent nen <...> la van ban thuong, vo hai', true);
const urls = (decode(fs.readFileSync(path.join(root, 'dict', FILES.t2s))).match(/https?:\/\/\S+/g) || []);
check('URL duy nhat trong du lieu la chu thich nguon OpenCC (khong bao gio goi)', urls.length <= 1, urls.join(', '));

// ---------------------------------------------------------------- 3. ReDoS trong rule engine
section('3. ReDoS: rule.txt duoc bien thanh regex luc nap');
const rules = createRuleEngine(decode(fs.readFileSync(path.join(root, 'dict', FILES.rules))));
console.log('  rule.txt: ' + rules.count + ' rule dang dung, ' + rules.stats.skippedInvalid + ' loi, ' + rules.stats.skippedUnsupported + ' bo qua');

const time = (label, fn) => {
  const t0 = Date.now();
  fn();
  const ms = Date.now() - t0;
  console.log('  ' + label + ' = ' + ms + 'ms');
  return ms;
};
const a = time('50 lan matchAt tren chuoi 400 ky tu Han la (測x400)', () => { for (let i = 0; i < 50; i++) rules.matchAt('測'.repeat(400), 0); });
const b = time('20 lan matchAt mau 第 + 300x一 + 章', () => { for (let i = 0; i < 20; i++) rules.matchAt('第' + '一'.repeat(300) + '章', 0); });
check('khong catastrophic backtracking (ReDoS): 2 thu nghiem < 2000ms', a < 2000 && b < 2000, 'a=' + a + 'ms b=' + b + 'ms');

// Thu cong: chuoi dai bat thuong co lam treo offscreen?
const c = time('matchAt 1 lan tren chuoi 200k ky tu', () => rules.matchAt('中'.repeat(200000), 0));
check('chuoi 200k ky tu van tra loi nhanh', c < 3000, c + 'ms');

// ---------------------------------------------------------------- 4. Nguon goc + giay phep
// QUYẾT ĐỊNH CỦA CHỦ PROJECT (2026-11-07): gói CHỈ DÙNG LOCAL — không zip/share/store/repo.
// Không phân phát thì nghĩa vụ GPL-3.0 (engine kế thừa duongden) và vùng xám license của
// dict KHÔNG kích hoạt. Nếu một ngày muốn phân phát: đổi PHAT_HANH = true — 4 cảnh báo
// giấy phép sống lại để nhắc bổ sung LICENSE + header nguồn trước khi đóng gói.
const PHAT_HANH = false;
section('4. Nguon goc va giay phep' + (PHAT_HANH ? '' : ' (che do CHI DUNG LOCAL theo chot cua chu project)'));
const STRUCT = [
  ['package.json cua tool la private (Chrome khong doc file nay)', fs.existsSync(path.join(root, 'package.json'))],
  ['khong co file/thu muc ten bat dau bang _ hoac . (Chrome/Edge tu choi Load unpacked)', !fs.readdirSync(root).some(f => f.startsWith('_') || (f.startsWith('.') && f !== '.gitignore'))],
  ['engine khong tai code tu ben ngoai ve luc chay (khong co import() URL)', !/import\s*\(\s*['"`]https?:/.test(ALL.map(codeOf).join(''))]
];
for (const [label, cond] of STRUCT) check(label, cond);

// Dung word-boundary: /mit/i khop ca "limit" va da danh bai chinh check nay hom truoc.
const LICENSE_RE = /\bGPL-3(\.0)?\b|\bGNU GENERAL PUBLIC LICENSE\b/i;
const LICENSE_FILE = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find(f => fs.existsSync(path.join(root, f)));
const LICENSE_NOTE = 'Chu project da chot (2026-11-07): chi dung local, khong phat hanh — nghia vu giay phep khong kich hoat. Khi PHAT_HANH = true thi phai kem GPL-3.0 + giu copyright cho engine ke thua duongden/script-vietphrase-translator.';
check('co file LICENSE trong goi (chi bat buoc khi phat hanh)', !PHAT_HANH || !!LICENSE_FILE,
  LICENSE_FILE || (PHAT_HANH ? 'KHONG CO — engine ke thua GPL-3.0, buoc kem license.' : LICENSE_NOTE));
check('noi dung LICENSE la GPL-3 (chi bat buoc khi phat hanh)', !PHAT_HANH || (!!LICENSE_FILE && LICENSE_RE.test(read(LICENSE_FILE))), LICENSE_FILE || LICENSE_NOTE);
const headers = ENGINE_FILES.filter(f => /duongden|script-vietphrase|GPL/i.test(read(f).slice(0, 700)));
check('file engine co header ghi nguon goc/license (chi bat buoc khi phat hanh)', !PHAT_HANH || headers.length > 0,
  headers.length ? headers.join(', ') : LICENSE_NOTE);
const dictLicense = ['LICENSE', 'LICENSE.txt', 'README.md'].some(f => fs.existsSync(path.join(root, 'dict', f)));
check('dict/ co ghi chu giay phep di kem (chi bat buoc khi phat hanh)', !PHAT_HANH || dictLicense,
  dictLicense ? 'dict/ co ghi chu' : LICENSE_NOTE + ' Rieng VietPhrase.txt (truycuatui) khong khai giay phep — khong dong goi 34MB nay de phat hanh.');

// ---------------------------------------------------------------- 5. Ket
const warns = results.filter(r => !r.cond);
console.log('\n' + '='.repeat(60));
console.log(results.length + ' kiem tra | ' + warns.length + ' canh bao' + (PHAT_HANH ? '' : ' | che do chi-dung-local: 4 muc giay phep da duoc chu project chot bo qua'));
for (const w of warns) console.log('  - ' + w.label + (w.detail ? ' | ' + w.detail : ''));
console.log(warns.length ? '\nKHOAN TOAN CO CANH BAO (xem o tren).' : '\nKHONG PHAT HIEN VAN DE. Luu y: bao cao nay do tinh chat tinh, khong phai bao dam tuy doi.');
process.exit(warns.length ? 1 : 0);
