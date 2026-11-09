// Lột comment khỏi JS để quét phần CODE thật (audit XSS, invariant chrome.storage).
//
// Vì sao không dùng regex: bản cũ `.replace(/\/\*[\s\S]*?\*\//g, '')` gặp dòng
//   // dict/*.txt giữ nguyên vĩnh viễn
// thì tưởng `/*` mở block comment, nuốt tới `*/` kế tiếp ở cuối file — mất ~1.700 ký
// tự code thật của options.js, gồm cả dòng chrome.storage.onChanged. Check "không
// chạm storage" và audit vì thế PASS GIẢ. Thước đo sai còn tệ hơn không đo.
//
// Bộ lột này đi từng ký tự, phân biệt: comment // và /* */, chuỗi ' " `, template
// có ${} (đệ quy), và regex literal (để `/https?:\/\//` không bị tưởng là comment).

// `/` mở regex khi token Significant đứng trước là toán tử / dấu mở khối / từ khóa.
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>',
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await'
]);

function skipQuoted(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    if (src[i] === '\n') return i;   // chuỗi đứt dòng: đừng nuốt cả file
    i++;
  }
  return i;
}

function skipTemplate(src, i) {
  i++;   // qua `
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '`') return i + 1;
    if (src[i] === '$' && src[i + 1] === '{') { i = closeExpression(src, i + 2) + 1; continue; }
    i++;
  }
  return i;
}

// Vị trí của `}` đóng `${...}` — bỏ qua chuỗi/template/comment/brace lồng bên trong.
function closeExpression(src, i) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipQuoted(src, i); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { if (depth === 0) return i; depth--; }
    i++;
  }
  return i;
}

function readTemplate(src, i) {
  let out = '`';
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if (c === '`') return [out + '`', i + 1];
    if (c === '$' && src[i + 1] === '{') {
      const end = closeExpression(src, i + 2);
      out += '${' + stripComments(src.slice(i + 2, end)) + '}';
      i = end + 1;
      continue;
    }
    out += c;
    i++;
  }
  return [out, i];
}

export function stripComments(source) {
  let out = '';
  let i = 0;
  let prev = '';   // token significant gần nhất (không tính khoảng trắng)
  let word = '';
  const n = source.length;

  const emit = text => {
    out += text;
    for (const ch of text) {
      if (/[A-Za-z0-9_$]/.test(ch)) { word += ch; prev = word; }
      else if (!/\s/.test(ch)) { word = ''; prev = ch; }
    }
  };

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];

    if (c === '/' && d === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      out += ' ';   // giữ ranh giới token: `a/*x*/b` không thành `ab`
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipQuoted(source, i);
      emit(source.slice(i, end));
      prev = 'value'; word = '';
      i = end;
      continue;
    }
    if (c === '`') {
      const [text, end] = readTemplate(source, i);
      emit(text);
      prev = 'value'; word = '';
      i = end;
      continue;
    }
    if (c === '/' && REGEX_PRECEDERS.has(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) { j++; break; }
        else if (source[j] === '\n') break;
        j++;
      }
      while (j < n && /[a-z]/.test(source[j])) j++;   // flags
      emit(source.slice(i, j));
      prev = 'value'; word = '';
      i = j;
      continue;
    }
    emit(c);
    i++;
  }
  return out;
}