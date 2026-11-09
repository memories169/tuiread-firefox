// Đọc file từ điển định dạng "Hán=nghĩa Việt" (một mục từ mỗi dòng).
// Nghĩa nhiều nghĩa phân cách bởi separator (mặc định '/'), có thể lấy nghĩa đầu.

function isWsCode(code) {
  return code === 32 || code === 9 || code === 13 || code === 10;
}

// Xử lý một dòng dict: trả [key, value] hoặc null. Dùng chung cho parseDict (string)
// và parseDictBuffer (streaming) để hai đường luôn hành xử giống hệt nhau.
function dictEntry(line, singleChar) {
  if (!line) return null;
  const c0 = line.charCodeAt(0);
  if (c0 === 35 || c0 === 47) return null; // '#' or '/'
  const eq = line.indexOf('=');
  if (eq < 1) return null;
  let from = 0, to = eq;
  while (from < to && isWsCode(line.charCodeAt(from))) from++;
  while (to > from && isWsCode(line.charCodeAt(to - 1))) to--;
  const key = to > from ? line.slice(from, to) : '';
  from = eq + 1; to = line.length;
  while (from < to && isWsCode(line.charCodeAt(from))) from++;
  while (to > from && isWsCode(line.charCodeAt(to - 1))) to--;
  const value = to > from ? line.slice(from, to) : '';
  if (!key || !value) return null;
  if (singleChar && Array.from(key).length > 1) return null;
  return [key, value];
}

export function parseDict(text, { singleChar = false } = {}) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const entry = dictEntry(line, singleChar);
    if (entry) map.set(entry[0], entry[1]);
  }
  return map;
}

// Streaming parse cho file từ điển BỰ (36MB): decode từng khối, cắt dòng, không giữ
// mảng 1 triệu dòng trong RAM cùng lúc → đỉnh bộ nhớ lúc nạp giảm đáng kể (tránh
// cảm giác "treo" trên máy ít RAM trống khi offscreen boot/rebuild).
export function parseDictBuffer(buffer, { singleChar = false, chunkBytes = 1 << 21 } = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let decoder, offset = 0;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) { decoder = new TextDecoder('utf-16le'); offset = 2; }
  else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { decoder = new TextDecoder('utf-8'); offset = 3; }
  else decoder = new TextDecoder('utf-8');

  const map = new Map();
  let carry = '';
  while (offset < bytes.length) {
    const end = Math.min(bytes.length, offset + chunkBytes);
    const text = decoder.decode(bytes.subarray(offset, end), { stream: true });
    offset = end;
    let lineStart = 0;
    for (;;) {
      const nl = text.indexOf('\n', lineStart);
      if (nl < 0) { carry += text.slice(lineStart); break; }
      const entry = dictEntry(carry + text.slice(lineStart, nl), singleChar);
      if (entry) map.set(entry[0], entry[1]);
      carry = '';
      lineStart = nl + 1;
    }
  }
  // dòng cuối không có '\n' + flush decoder (phần multi-byte còn treo)
  const tail = carry + decoder.decode();
  const entry = dictEntry(tail, singleChar);
  if (entry) map.set(entry[0], entry[1]);
  return map;
}

// Gỡ wrapper điều khiển còn sót trong dữ liệu dict cộng đồng, giữ nguyên {0} (placeholder luật):
//   {máy luyện lực tổng hợp} -> máy luyện lực tổng hợp   (378 mục trong VP)
//   [Nữ siêu nhân số 2]      -> Nữ siêu nhân số 2        (ngoặc bao trọn nghĩa)
//   ...thời[]                -> ...thời                  (ngoặc rỗng đuôi)
//   {đèn pin tiến hóa☼}      -> đèn pin tiến hóa         (☼ là cờ nội bộ của dict cũ)
export function cleanMeaning(text) {
  let out = String(text);
  out = out.replace(/\{([^{}]*)\}/g, (m, inner) => (/^\d+$/.test(inner) ? m : inner));
  out = out.replace(/\[([^\[\]]*)\]/g, (m, inner) => inner);
  out = out.replace(/☼/g, '');
  return out.trim();
}

export function firstMeaning(value, separator) {
  const sep = separator || '/';
  // Chọn candidate đầu tiên KHÔNG rỗng sau khi gỡ wrapper: dict cộng đồng có mục
  // kiểu "/lấy/mắng" (candidate đầu trống) — lấy theo vị trí thì token biến mất khỏi bản dịch.
  for (const part of String(value).split(sep)) {
    const cleaned = cleanMeaning(part);
    if (cleaned) return cleaned;
  }
  return '';
}

// Độ dài mục từ dài nhất — dùng làm trần cho vòng lặp longest-match.
export function maxKeyLength(map) {
  let max = 1;
  for (const key of map.keys()) {
    const len = [...key].length;
    if (len > max) max = len;
  }
  return max;
}
