const $ = id => document.getElementById(id);

const KEYS = ['mode', 'firstMeaning', 'skipParticles', 'useRules', 'useNames', 'translateChrome', 'allowClickEdit'];

function ask(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: 'khong co phan hoi' });
    });
  });
}

function current() {
  const out = {};
  for (const key of KEYS) {
    const el = $(key);
    out[key] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

// Moi luu tru di qua service worker; no day settings sang offscreen va offscreen tu
// dung lai engine neu cai gi doi thay doi cach dich (firstMeaning/skipParticles/useRules/useNames).
async function storeGet(keys) {
  const got = await ask({ type: 'vp:get-settings' });
  if (!got || !got.ok) return {};
  const wanted = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(wanted.filter(key => got[key] !== undefined).map(key => [key, got[key]]));
}
async function storeSet(obj) {
  const resp = await ask({ type: 'vp:set', patch: obj });
  return !!(resp && resp.ok);
}

async function load() {
  const got = await storeGet(['settings']);
  const s = got.settings || {};
  for (const key of KEYS) {
    const el = $(key);
    if (el.type === 'checkbox') el.checked = s[key] !== false;
    else el.value = s[key] || 'vi';
  }
}

$('save').addEventListener('click', async () => {
  const saved = await storeSet({ settings: current() });
  await ask({ type: 'vp:ensure' });
  const st = await ask({ type: 'vp:status' });
  const engineOk = st && (st.state === 'ready' || st.state === 'loading');
  $('msg').textContent = saved
    ? (engineOk ? 'Đã lưu. Engine tự dựng lại nếu bạn đổi cách chọn nghĩa / rule / Names.' : 'Đã lưu nhưng engine chưa trả lời - bấm "Nạp lại từ điển" ở popup.')
    : 'KHÔNG LƯU ĐƯỢC: service worker không ghi được bộ nhớ của extension. Xem mục “Sự cố hay gặp” trong README.';
  setTimeout(() => { $('msg').textContent = ''; }, 5000);
});

$('run').addEventListener('click', async () => {
  $('out').textContent = 'Đang convert...';
  const texts = $('src').value.split(/\n+/).filter(line => line.trim());
  await ask({ type: 'vp:ensure' });
  const resp = await ask({ type: 'vp:translate', texts });
  $('out').textContent = resp && resp.ok ? resp.results.join('\n') : 'Lỗi: ' + (resp && resp.error);
});

// ---------------------------------------------------------------- Từ điển của tôi (override)
// Bản vá nằm ở layer riêng trong chrome.storage, thắng mọi mục của từ điển gốc; file
// dict/*.txt giữ nguyên vĩnh viễn. Xuất ra đúng định dạng "Hán=nghĩa" nên muốn gộp
// hẳn vào từ điển riêng thì chép nội dung file vào cuối file đó là xong.
function ovMsg(text) {
  $('ovMsg').textContent = text;
  setTimeout(() => { $('ovMsg').textContent = ''; }, 6000);
}

// Đồng bộ hai chiều giữa card trên trang truyện và ô văn bản ở đây:
// - storage đổi (vá từ web / nhập file) mà ô KHÔNG bị sửa tay -> tự nạp lại.
// - ô bị sửa tay -> TỰ LƯU (debounce 900ms), không cần bấm nút; nút vẫn giữ để lưu ép.
let ovDirty = false;
let ovSaveTimer = null;

async function loadOverrides() {
  const got = await storeGet(['overrides', 'overridesVersion']);
  const map = got.overrides || {};
  const count = Object.keys(map).length;
  $('ovInfo').textContent = count
    ? `Đang vá ${count} mục (bản vá số ${got.overridesVersion || 0}) — ô dưới tự lưu khi bạn sửa.`
    : 'Chưa vá mục nào. Bấm vào một cụm đã dịch trên trang truyện để vá nhanh.';
  $('ovText').value = Object.entries(map).map(([han, vi]) => han + '=' + vi).join('\n');
  ovDirty = false;
}

$('ovText').addEventListener('input', () => {
  ovDirty = true;
  clearTimeout(ovSaveTimer);
  $('ovInfo').textContent = 'Đang sửa… tự lưu sau khi bạn ngừng gõ.';
  ovSaveTimer = setTimeout(() => applyOverrides(parseOverrideLines($('ovText').value), 'Đã tự lưu.'), 900);
});

// Vá từ card trên trang / nơi khác: phản ánh ngay vào ô (chỉ khi ô không đang được sửa tay,
// tránh ghi đè phần đang gõ dở). Đang dirty thì chỉ nhắc. Service worker nghe storage rồi
// phát tin này — options không tự chạm chrome.storage (xem background.js).
chrome.runtime.onMessage.addListener(msg => {
  if (!msg || msg.type !== 'vp:store-changed' || !(msg.keys || []).includes('overrides')) return;
  if (ovDirty) ovMsg('Bản vá vừa đổi ở nơi khác — ô này đang có sửa chưa lưu, bấm nút để ghi đè.');
  else loadOverrides();
});

function parseOverrideLines(text) {
  const entries = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    entries.push({ han: line.slice(0, eq).trim(), vi: line.slice(eq + 1).trim() });
  }
  return entries;
}

async function applyOverrides(entries, note) {
  if (!entries.length) { ovMsg('Không có dòng hợp lệ nào (dạng 漢=nghĩa).'); return false; }
  const resp = await ask({ type: 'vp:override-replace', entries });
  if (!resp || !resp.ok) { ovMsg('KHÔNG LƯU ĐƯỢC: ' + ((resp && resp.error) || 'service worker không trả lời')); return false; }
  await loadOverrides();
  ovMsg(note + ` Đã vá ${Object.keys(resp.overrides).length} mục.` + (resp.pushed ? '' : ' (Engine chưa trả lời — sẽ dùng bản vá ở lần dịch sau.)'));
  return true;
}

$('ovApply').addEventListener('click', () => applyOverrides(parseOverrideLines($('ovText').value), 'Đã cập nhật.'));

$('ovExport').addEventListener('click', () => {
  const lines = $('ovText').value.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  const header = '# TuiRead - bản vá từ điển của tôi. Định dạng: 漢=nghĩa (chép được vào cuối file từ điển .txt)\n';
  const blob = new Blob([header + lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tuiread-overrides.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

$('ovImport').addEventListener('click', () => $('ovFile').click());

$('ovFile').addEventListener('change', () => {
  const file = $('ovFile').files && $('ovFile').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => applyOverrides(parseOverrideLines(String(reader.result || '')), `Đã nhập "${file.name}".`);
  reader.onerror = () => ovMsg('Không đọc được file.');
  reader.readAsText(file, 'utf-8');
  $('ovFile').value = '';
});

// ---------------------------------------------------------------- Bản vá từ URL (raw GitHub…)
// GET-only tới URL người dùng dán. Server mở CORS (raw GitHub) thì tải ngay không cần quyền;
// server kín CORS thì xin quyền miền một lần rồi tải lại. Thành công = THAY toàn bộ bản vá
// (đúng ngữ nghĩa Nhập file) và nhớ URL để lần sau mở options thấy lại.
function urlMsg(text, isErr) {
  const el = $('urlMsg');
  el.textContent = text || '';
  el.classList.toggle('err', !!isErr);
}

async function fetchOverrideText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  const attempt = async () => {
    const r = await fetch(url.href, { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    if (text.length > 8 * 1024 * 1024) throw new Error('file lớn hơn 8MB');
    return text;
  };
  try {
    return await attempt();
  } catch (first) {
    const origins = [url.origin + '/*'];
    const has = await new Promise(res => chrome.permissions.contains({ origins }, res));
    if (has) throw first;
    const granted = await new Promise(res => chrome.permissions.request({ origins }, res));
    if (!granted) throw new Error(first.message + ' — trang không mở CORS và bạn chưa cấp quyền cho miền này');
    return attempt();
  } finally {
    clearTimeout(timer);
  }
}

$('ovUrlLoad').addEventListener('click', async () => {
  const raw = $('ovUrl').value.trim();
  let url;
  try { url = new URL(raw); } catch { urlMsg('URL không hợp lệ — dán đầy đủ kể cả https://', true); return; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') { urlMsg('Chỉ nhận URL http/https.', true); return; }
  const btn = $('ovUrlLoad');
  btn.disabled = true;
  btn.textContent = 'Đang tải…';
  urlMsg('');
  try {
    const entries = parseOverrideLines(await fetchOverrideText(url));
    if (!entries.length) { urlMsg('Tải được file nhưng không có dòng hợp lệ nào (dạng 漢=nghĩa).', true); return; }
    const ok = await applyOverrides(entries, 'Đã tải từ URL.');
    if (ok) {
      await storeSet({ ovUrl: url.href });
      urlMsg(`Đã nạp ${entries.length} dòng hợp lệ từ URL và nhớ URL này cho lần sau.`);
    } else {
      urlMsg('Có dòng hợp lệ nhưng không lưu được — xem thông báo cạnh nút "Lưu ngay".', true);
    }
  } catch (e) {
    urlMsg('Không tải được: ' + (e && e.name === 'AbortError' ? 'quá 20s không tải xong' : (e && e.message) || e), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Tải từ URL';
  }
});

$('ovUrl').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('ovUrlLoad').click(); }
});

async function loadUrlPref() {
  const got = await storeGet(['ovUrl']);
  if (got.ovUrl) $('ovUrl').value = got.ovUrl;
}

// ------------------------------------------------------- Selector khu vực truyện theo trang
// Cấu hình per-host, KHÔNG code cứng: site thêm qua popup mặc định dùng khối nhiều chữ Hán
// nhất tự chọn; site nào chọn sai khối thì dán selector đúng vào đây.
function siteMsg(text, isErr) {
  const el = $('siteMsg');
  el.textContent = text || '';
  el.style.color = isErr ? '#b3261e' : '#0a7a2f';
  setTimeout(() => { el.textContent = ''; }, 6000);
}

async function loadSiteSelectors() {
  const got = await storeGet(['siteSelectors']);
  const map = got.siteSelectors || {};
  $('siteSel').value = Object.entries(map).map(([host, sel]) => host + '=' + sel).join('\n');
}

function parseSiteLines(text) {
  const map = {};
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 2) continue;
    const host = line.slice(0, eq).trim().toLowerCase();
    const sel = line.slice(eq + 1).trim();
    if (host && sel) map[host] = sel;
  }
  return map;
}

$('siteSave').addEventListener('click', async () => {
  const map = parseSiteLines($('siteSel').value);
  const saved = await storeSet({ siteSelectors: map });
  siteMsg(saved
    ? `Đã lưu selector cho ${Object.keys(map).length} trang. Bấm "Dịch lại trang" ở popup để áp dụng.`
    : 'KHÔNG LƯU ĐƯỢC: service worker không trả lời.', !saved);
});

load();
loadOverrides();
loadSiteSelectors();
loadUrlPref();
