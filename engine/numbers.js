// Chuyển chữ số Hán sang Ả Rập cho rule engine (<n>, <y>).

export const DIGITS = {
  '零': 0, '〇': 0, '○': 0,
  '一': 1, '二': 2, '两': 2, '兩': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9
};
export const SMALL_UNITS = { '十': 10, '百': 100, '千': 1000 };
export const LARGE_UNITS = { '万': 1e4, '萬': 1e4, '亿': 1e8, '億': 1e8 };

export const NUM_CHARS = /[0-9零〇○一二两兩三四五六七八九十百千万萬亿億]/;
export const DIGIT_ONLY_CHARS = /[0-9零〇○一二三四五六七八九]/;

export const LABELS = {
  '章': 'Chương', '卷': 'Quyển', '集': 'Tập', '节': 'Tiết', '節': 'Tiết',
  '幕': 'Màn', '回': 'Hồi', '折': 'Chiết'
};

export function isNumChar(ch) { return NUM_CHARS.test(ch); }
export function isDigitChar(ch) { return DIGIT_ONLY_CHARS.test(ch); }

// Chuỗi chỉ gồm 十百千 + 万亿亿 + chữ số -> số Ả Rập.
export function chineseNumberToArabic(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^[0-9]+$/.test(s)) return s;

  const hasUnit = [...s].some(ch => SMALL_UNITS[ch] || LARGE_UNITS[ch]);
  if (!hasUnit) {
    let out = '';
    for (const ch of s) out += /[0-9]/.test(ch) ? ch : (DIGITS[ch] ?? '');
    return out;
  }

  let result = 0, section = 0, number = 0, seen = false;
  for (const ch of s) {
    if (/[0-9]/.test(ch)) { number = Number(ch); seen = true; continue; }
    if (DIGITS[ch] !== undefined) { number = DIGITS[ch]; seen = true; continue; }
    if (SMALL_UNITS[ch]) { section += (number || 1) * SMALL_UNITS[ch]; number = 0; seen = true; continue; }
    if (LARGE_UNITS[ch]) { section += number; result += section * LARGE_UNITS[ch]; section = 0; number = 0; seen = true; continue; }
    return '';
  }
  return seen ? String(result + section + number) : '';
}

// Đọc từng chữ số: 二零一八 -> 2018 (dùng cho <y>: năm, mã số).
export function digitByDigit(input) {
  let out = '';
  for (const ch of String(input || '')) {
    if (/[0-9]/.test(ch)) out += ch;
    else if (DIGITS[ch] !== undefined) out += String(DIGITS[ch]);
    else return '';
  }
  return out;
}
