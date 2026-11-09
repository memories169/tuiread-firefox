// Gộp 2 nguồn dict công khai thành dict/VietPhrase.txt duy nhất:
//   base    = truyencuatui/VietPhrase (29,6MB UTF-16LE, 679.293 mục — giàu compound ngữ pháp X的/X了)
//   overlay = ldhieu304/file-vietphrase (28,6MB UTF-8, 763.736 mục — cùng dòng với dict STV,
//             sạch hơn, có từ ngữ web-novel hiện đại, thứ tự nghĩa "hay nhất trước")
// Quy tắc: overlay ĐÈ mục trùng (đo 2026-11-07: thắng trên cả 3 benchmark — STV-chapter
// 81,3% giống STV, coverage 92,7% > STV 91,3%; fixture uukanshu 90,4%, piaotia 93,7%).
//
// Dùng: node tools/build-dict-merge.mjs [--base PATH] [--overlay PATH] [--out PATH]
// Mặc định đọc từ ../dict-sources/ (ngoài thư mục extension để không thành payload của gói).
// Nguồn tải lại được:
//   base:    https://github.com/truyencuatui/VietPhrase        (VietPhrase.txt)
//   overlay: https://github.com/ldhieu304/file-vietphrase      (VietPhrase.txt)
//
// File out ghi UTF-8 (decode() của engine tự nhận qua BOM/—heuristic; không BOM = utf-8).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDict, decode } from '../engine/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const sources = path.resolve(project, '..', 'dict-sources');

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const basePath = arg('--base', path.join(sources, 'VietPhrase.truyencuatui.txt'));
const overlayPath = arg('--overlay', path.join(sources, 'VietPhrase.ldhieu.txt'));
const outPath = arg('--out', path.join(project, 'dict', 'VietPhrase.txt'));

const readDict = file => parseDict(decode(fs.readFileSync(file)));

const t0 = Date.now();
const base = readDict(basePath);
const overlay = readDict(overlayPath);
console.log(`base:    ${base.size.toLocaleString('vi-VN')} mục  (${path.basename(basePath)})`);
console.log(`overlay: ${overlay.size.toLocaleString('vi-VN')} mục  (${path.basename(overlayPath)})`);

let overwritten = 0, added = 0, identical = 0;
for (const [key, value] of overlay) {
  const prev = base.get(key);
  if (prev === undefined) { base.set(key, value); added++; }
  else if (prev !== value) { base.set(key, value); overwritten++; }
  else identical++;
}
console.log(`overlay đè ${overwritten.toLocaleString('vi-VN')} mục trùng, thêm ${added.toLocaleString('vi-VN')} mục mới, ${identical.toLocaleString('vi-VN')} mục giống hệt (bỏ qua)`);
console.log(`tổng: ${base.size.toLocaleString('vi-VN')} mục`);

const lines = [];
for (const [key, value] of base) lines.push(key + '=' + value);
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
const bytes = fs.statSync(outPath).size;
console.log(`ghi ${outPath} — ${(bytes / 1e6).toFixed(2)} MB, ${(Date.now() - t0) / 1000 | 0}s`);
