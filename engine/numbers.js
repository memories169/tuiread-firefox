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

// Chuỗi gồm 十百千 + 万萬亿億 + chữ số -> số Ả Rập.
// Hỗ trợ dạng rút gọn: 六百三八=638, 一千三百=1300, 六百三=630, 一百二=120 —
// chữ số trần đứng NGAY sau đơn vị mà tiếp theo là chữ số khác hoặc hết chuỗi
// thì chiếm bậc đơn vị/10; các chữ số trần sau đó giảm bậc /10 từng bước.
// Hạn chế (hiếm gặp trong số chương): 一万二 chưa rút gọn được (cần 一万二千).
export function chineseNumberToArabic(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^[0-9]+$/.test(s)) return String(Number(s));

  const chars = [...s];
  const hasUnit = chars.some(ch => SMALL_UNITS[ch] || LARGE_UNITS[ch]);
  if (!hasUnit) {
    // Không có đơn vị -> đọc từng chữ số: 三八=38, 二零一八=2018.
    let out = '';
    for (const ch of chars) {
      const d = DIGITS[ch];
      const v = d !== undefined ? d : (/[0-9]/.test(ch) ? Number(ch) : null);
      if (v === null) return '';
      out += String(v);
    }
    return out;
  }

  let result = 0, section = 0, number = 0, mag = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];
    const after = chars[i + 2];
    const d = DIGITS[ch], u = SMALL_UNITS[ch], L = LARGE_UNITS[ch];
    const ascii = /[0-9]/.test(ch);
    if (d !== undefined || ascii) {
      const value = ascii ? Number(ch) : d;
      const nextIsUnit = next !== undefined && (SMALL_UNITS[next] !== undefined || LARGE_UNITS[next] !== undefined);
      if (mag > 0 && value > 0 && !nextIsUnit) {
        number += value * mag;          // chữ số trần trong chuỗi rút gọn
        mag = mag >= 10 ? mag / 10 : 0;
      } else {
        number = value; mag = 0;        // chữ số thường (đứng trước đơn vị) hoặc 零: hủy rút gọn
      }
      continue;
    }
    if (u) {
      section += (number || 1) * u;
      number = 0;
      // Chữ số kế tiếp là "số trần" (tiếp nữa là chữ số khác hoặc hết chuỗi)
      // -> nó chiếm bậc u/10, KHÔNG phải chữ số đứng trước đơn vị nữa.
      mag = (next !== undefined && DIGITS[next] !== undefined && (after === undefined || DIGITS[after] !== undefined)) ? u / 10 : 0;
      continue;
    }
    if (L) {
      section += number;
      result += (section || 1) * L;
      section = 0; number = 0;
      // 一万二 = 12000: chữ số sau đơn vị lớn cũng có bậc rút gọn (L/10).
      mag = (next !== undefined && DIGITS[next] !== undefined) ? L / 10 : 0;
      continue;
    }
    return '';
  }
  return String(result + section + number);
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
