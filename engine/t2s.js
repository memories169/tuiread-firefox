// Chuẩn hoá 繁體 → 简体 bằng bảng OpenCC TSCharacters.txt (Apache-2.0).
// Dòng dữ liệu: <繁><TAB><简> [<简 biến thể...>]

export function parseT2S(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const parts = s.split(/\s+/);
    if (parts.length < 2) continue;
    map.set(parts[0], parts[1]);
  }
  return map;
}

export function toSimplified(text, map) {
  if (!map || map.size === 0) return text;
  let out = '';
  for (const ch of text) {
    const s = map.get(ch);
    out += s === undefined ? ch : s;
  }
  return out;
}
