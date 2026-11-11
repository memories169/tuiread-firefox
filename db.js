// Cache kết quả dịch trong IndexedDB của engine page.
//
// Vì sao cache: mỗi lần mở/reload chương đều gửi lại toàn bộ text node cho engine. Dịch
// nhanh (~40ms/chương) nhưng khi trình duyệt vừa mở, từ điển 34MB chưa nạp xong (~2-5s)
// nên trang hiện chữ Hán rồi mới lật sang Việt. Có cache, chương đã đọc hiện Việt ngay
// cả khi engine còn đang nạp.
//
// Vì sao IndexedDB mà không phải chrome.storage: chrome.storage.local chỉ 10MB, không đủ
// cho hàng chục nghìn bản dịch; `unlimitedStorage` đã có sẵn trong manifest. IndexedDB là
// API web chuẩn (không thuộc chrome.* bị Edge cắt trong engine page — probe README), nếu
// trình duyệt nào vẫn chặn thì tự rơi về Map trong RAM: mất cache khi restart, không mất
// tính năng dịch.

// Tên DB giữ nguyên từ thời "VietPhrase Reader": đổi tên khi lên thương hiệu TuiRead
// sẽ bỏ toàn bộ cache bản dịch đã tích lũy của người đang dùng.
const DB_NAME = 'vietphrase-reader';
const STORE = 'translations';
const MAX_ENTRIES = 30000;   // Trần tổng, vượt thì prune còn lại một nửa lúc khởi động
const MEM_MAX = 8000;        // Trần tầng RAM (L1) để heap offscreen không phình vô hạn

// Tăng khi thay đổi file trong dict/ hoặc cách parse: cache cũ tự chết theo key.
export const DICT_VERSION = 18;   // bump: sua regex hoa Viet + sieat acceptName (substring VP)

let dbPromise = null;
let mem = new Map();         // key -> entry; L1 cho hit tức thì, đồng thời là fallback
let keyCtx = '';             // ngữ cảnh đặt trước của key: dict version + settings + overrides

function hasIDB() {
  try { return typeof indexedDB !== 'undefined' && indexedDB !== null; } catch { return false; }
}

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('khong mo duoc IndexedDB'));
  });
  return dbPromise;
}

// FNV-1a 32-bit: đủ cho key cache, nhanh hơn nhiều so với sha256 trên từng text node.
// Thêm text.length vào key để hai chuỗi khác độ dài khó va nhau hơn nữa.
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Xoá TOÀN BỘ cache dịch (store 'translations') + cache mem. Dùng tay từ popup
// ('Xoá cache dịch') — không bao giờ gọi tự động: bump DICT_VERSION là đủ cho các
// thay đổi engine/dict.
export async function cacheClear() {
  mem.clear();
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Gọi sau mỗi lần dựng engine (boot / đổi settings / đổi override): mọi key cũ vô nghĩa.
export function setKeyContext(parts) {
  keyCtx = parts.join('|');
  mem.clear();
}

export function makeKey(text) {
  return keyCtx + ':' + text.length + ':' + fnv1a(text);
}

function memSet(key, value) {
  if (mem.size >= MEM_MAX && !mem.has(key)) mem.delete(mem.keys().next().value);
  mem.set(key, value);
}

// keys: mảng key theo thứ tự -> mảng kết quả, miss = undefined.
export async function cacheGet(keys) {
  const out = new Array(keys.length);
  const missing = [];
  keys.forEach((key, i) => {
    if (mem.has(key)) out[i] = mem.get(key);
    else missing.push([key, i]);
  });
  if (missing.length && hasIDB()) {
    try {
      const db = await open();
      await new Promise((resolve, reject) => {
        const store = db.transaction(STORE, 'readonly').objectStore(STORE);
        let done = 0;
        for (const [key, i] of missing) {
          const req = store.get(key);
          req.onsuccess = () => {
            if (req.result !== undefined) { out[i] = req.result; memSet(key, req.result); }
            if (++done === missing.length) resolve();
          };
          req.onerror = () => reject(req.error);
        }
      });
    } catch { /* IndexedDB hỏng -> vẫn còn tầng RAM */ }
  }
  return out;
}

// entries: [[key, value], ...]. Ghi RAM trước (hit ngay trong phiên), IDB nền sau.
export async function cachePut(entries) {
  for (const [key, value] of entries) memSet(key, value);
  if (!hasIDB()) return;
  try {
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const [key, value] of entries) store.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch { /* ghi hỏng thì lần sau dịch lại, không fatal */ }
}

export function cacheStats() {
  return { persistent: hasIDB(), mem: mem.size };
}

// Chạy một lần sau mỗi lần dựng engine: cache quá đặc thì xóa bớt nửa còn lại (giữ mới
// nhất theo thứ tự cursor — key không có timestamp thứ tự, chấp nhận xóa lọc đầu bảng).
export async function cachePrune(max = MAX_ENTRIES) {
  if (!hasIDB()) return 0;
  try {
    const db = await open();
    const count = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (count <= max) return 0;
    let excess = count - Math.floor(max / 2);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const cursorReq = tx.objectStore(STORE).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || excess <= 0) return;
        cursor.delete();
        excess--;
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return count;
  } catch { return 0; }
}
