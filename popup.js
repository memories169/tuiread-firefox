const $ = id => document.getElementById(id);
let tab = null;
let hostName = '';
let enabled = false;

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function ask(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false, error: 'khong co phan hoi' });
    });
  });
}

// Gọi API extension bằng callback — Firefox 128 không trả promise từ chrome.* (chỉ browser.*).
// Callback là giao diện gốc của cả hai; mock trong test trả Promise (thenable) vẫn chạy.
function callP(target, method, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (finish, value) => { if (!settled) { settled = true; finish(value); } };
    let ret;
    try {
      ret = target[method](...args, value => {
        const err = chrome.runtime.lastError;
        if (err) done(reject, new Error(err.message)); else done(resolve, value);
      });
    } catch (err) { done(reject, err); return; }
    if (ret && typeof ret.then === 'function') ret.then(v => done(resolve, v), e => done(reject, e));
  });
}

function toPage(message) {
  return new Promise(resolve => {
    if (!tab || tab.id === undefined) return resolve({ ok: false, error: 'khong co tab' });
    chrome.tabs.sendMessage(tab.id, message, response => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || { ok: false });
    });
  });
}

// Moi luu tru di qua background (event page / service worker) - xem ghi chu trong file do.
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

function renderStatus(box) {  const el = $('status');
  el.textContent = box;
  el.classList.toggle('err', String(box).includes('lỗi') || String(box).includes('error'));
}

function renderToggle() {
  $('toggle').textContent = enabled ? 'Đang bật' : 'Đang tắt';
  $('toggle').dataset.on = String(enabled);
}

async function refresh() {
  [tab] = (await callP(chrome.tabs, 'query', { active: true, currentWindow: true })) || [];
  hostName = hostnameOf((tab && tab.url) || '');
  $('host').textContent = hostName || '(không xác định)';
  if (hostName && !$('newHost').value) $('newHost').value = hostName;   // điền sẵn cho nút Thêm

  const got = await storeGet(['settings', 'hostState']);
  $('mode').value = (got.settings && got.settings.mode) || 'vi';
  document.documentElement.dataset.theme = (got.settings && got.settings.uiTheme) || '';   // cappuccino...
  const state = got.hostState || {};
  enabled = hostName ? state[hostName] !== false : false;
  renderToggle();

  const status = await ask({ type: 'vp:status' });
  if (!status || status.state !== 'ready') {
    const notResponding = !status || (!status.state && !status.message);
    if (notResponding) await ask({ type: 'vp:ensure' });
    const line = notResponding
      ? 'Engine: engine page không trả lời (background chưa tải trang engine)\nĐã yêu cầu tạo lại — bấm "Nạp lại từ điển" nếu vẫn không được\nXem lỗi: about:debugging → TuiRead → “Inspect” / About Firefox → Settings → extension'
      : `Engine: ${(status.message || 'chưa phản hồi')}` +
        (typeof status.progress === 'number' ? ` — ${Math.round(status.progress * 100)}%` : '') +
        (status.state === 'error' ? '' : '\nVẫn đang nạp, popup sẽ tự cập nhật.');
    renderStatus(line);
    schedulePoll();
    return;
  }
  const page = await toPage({ type: 'vp:command', action: 'status' });
  renderStatus(
    `Engine: sẵn sàng sau ${Math.round((status.loadMs || 0) / 100) / 10}s (build 0.6.0)\n` +
    `VP ${status.info.vp} · Names ${status.info.names} · PA ${status.info.pa}\n` +
    `Rules ${status.rules.active} hoạt động (${status.rules.unsupported} bỏ qua vì cần <ne|pn|w>)\n` +
    `繁→簡: ${status.t2s} ký tự\n` +
    (status.warning ? '⚠ ' + status.warning + '\n' : '') +
    (page.ok ? `Trang này: ${page.translated} đoạn đã dịch` : 'Trang này chưa chạy content script (URL không nằm trong danh sách hỗ trợ)')
  );
}

let pollTimer = null;
function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => { pollTimer = null; refresh(); }, 1500);
}

$('reload').addEventListener('click', async () => {
  renderStatus('Đang nạp lại từ điển...');
  await ask({ type: 'vp:ensure' });            // dam bao engine page (iframe/offscreen) ton tai
  const resp = await ask({ type: 'vp:reload' });
  if (resp && resp.ok) refresh();
  else renderStatus('Không nạp lại được: ' + ((resp && resp.error) || 'engine page không trả lời') +
    '\nHãy mở about:debugging → This Firefox → “Inspect” của TuiRead (hoặc Tắt/Bật lại extension).');
});

$('toggle').addEventListener('click', async () => {
  if (!hostName) return;
  const got = await storeGet(['hostState']);
  const state = got.hostState || {};
  enabled = !enabled;
  state[hostName] = enabled;
  await storeSet({ hostState: state });
  await ask({ type: 'vp:ensure' });
  await toPage({ type: 'vp:command', action: enabled ? 'enable' : 'disable' });
  renderToggle();
});

$('clear-cache').addEventListener('click', async () => {
  await ask({ type: 'vp:cache-clear' });
  await ask({ type: 'vp:ensure' });
  await toPage({ type: 'vp:command', action: 'retranslate' });
  renderStatus('Đã xoá cache dịch — trang đang được dịch lại bằng engine hiện tại.');
});

$('retranslate').addEventListener('click', async () => {
  await toPage({ type: 'vp:command', action: 'retranslate' });
  refresh();
});

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('mode').addEventListener('change', async () => {
  const got = await storeGet(['settings']);
  const settings = { ...(got.settings || {}), mode: $('mode').value };
  await storeSet({ settings });
  await toPage({ type: 'vp:command', action: 'retranslate' });
});

// ---------------------------------------------------------------- Thêm site truyện khác
// Site mặc định (uukanshu/piaotia) khai sẵn trong manifest; site khác đi qua đây:
// xin quyền đúng lúc bấm (permissions.request phải nằm trong cú click của popup),
// rồi background đăng ký content script vĩnh viễn. Bỏ site = thu hồi quyền.
function addMsg(text, isErr) {
  const el = $('addMsg');
  el.textContent = text || '';
  el.classList.toggle('err', !!isErr);
  if (text) setTimeout(() => { el.textContent = ''; }, 6000);
}

// Chấp nhận cả domain lẫn URL đầy đủ; chuẩn hóa: bỏ www., bỏ path/cổng.
function hostFromInput(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return ''; }
}

function originsFor(host) {
  return ['*://' + host + '/*', '*://*.' + host + '/*'];
}

// Vừa thêm xong thì bơm script ngay vào tab hiện tại nếu đang đứng trên site đó — không cần F5.
async function injectIntoCurrentTab(host) {
  if (!host) return;
  const [t] = (await callP(chrome.tabs, 'query', { active: true, currentWindow: true })) || [];
  if (!t || hostnameOf(t.url) !== host) return;
  try {
    // Đường dẫn bắt đầu bằng "/" = tuyệt đối tính từ gốc extension. Khác Chrome: Firefox resolve
    // URL tương đối trong inject CSS/JS theo TRANG HIỆN TẠI (MDN Chrome incompatibilities) -> nếu
    // thiếu "/" thì Firefox sẽ tìm sai đường dẫn và bỏ qua khi bơm CSS.
    await callP(chrome.scripting, 'insertCSS', { target: { tabId: t.id }, files: ['/styles/content.css'] });
    await callP(chrome.scripting, 'executeScript', { target: { tabId: t.id }, files: ['/content.js'] });
  } catch { /* tab hệ thống/đã inject — bỏ qua, lần tải sau tự chạy */ }
}

async function refreshSites() {
  const resp = await ask({ type: 'vp:sites' });
  const list = $('siteList');
  list.textContent = '';
  if (!resp || !resp.ok) { addMsg('Không đọc được danh sách site.', true); return; }
  const mkChip = (host, isDefault, removable) => {
    const chip = document.createElement('span');
    chip.className = 'chip' + (isDefault ? ' def' : '');
    chip.appendChild(document.createTextNode(isDefault ? host + ' *' : host));
    if (removable) {
      const rm = document.createElement('button');
      rm.textContent = '×';
      rm.title = 'Bỏ site này và thu hồi quyền';
      rm.addEventListener('click', async () => {
        const r = await ask({ type: 'vp:site-remove', host });
        if (r && r.ok) { addMsg('Đã bỏ ' + host); refreshSites(); }
        else addMsg('Không bỏ được: ' + ((r && r.error) || '?'), true);
      });
      chip.appendChild(rm);
    }
    return chip;
  };
  for (const host of resp.builtin || []) list.appendChild(mkChip(host, true, false));
  for (const item of resp.added || []) list.appendChild(mkChip(item.host, false, true));
  if (!(resp.builtin || []).length && !(resp.added || []).length) {
    list.appendChild(document.createTextNode('Chưa có site nào được bật.'));
  }
}

$('addSite').addEventListener('click', async () => {
  const host = hostFromInput($('newHost').value);
  if (!host) { addMsg('Nhập domain (vd: truyenfull.vn) hoặc dán cả URL.', true); return; }
  addMsg('Đang xin quyền cho ' + host + '…');
  let granted = false;
  try {
    // chrome.permissions.request: GỌI CÓ CALLBACK (giao diện gốc của cả Chrome lẫn Firefox).
    // Nếu không có callback, Firefox cũ trả undefined (chưa có promise trong chrome.*) ->
    // grant bị coi như từ chối dù user đã bấm "Cho phép". callP bọc callback + vẫn đọc được
    // promise nếu API trả về (mock test / Firefox mới).
    granted = await callP(chrome.permissions, 'request', { origins: originsFor(host) });
  } catch (e) {
    addMsg('Không xin được quyền: ' + e.message, true);
    return;
  }
  if (!granted) { addMsg('Bạn chưa đồng ý cấp quyền cho ' + host + '.', true); return; }
  const resp = await ask({ type: 'vp:site-add', host, origins: originsFor(host) });
  if (!resp || !resp.ok) { addMsg('Không thêm được: ' + ((resp && resp.error) || '?'), true); return; }
  if (resp.builtin) addMsg(host + ' đã có sẵn trong gói — bật/tắt bằng nút ở trên.');
  else { addMsg('Đã thêm ' + host + '. Vào trang truyện là tự dịch.'); await injectIntoCurrentTab(host); }
  $('newHost').value = '';
  refreshSites();
});

// Danh sách site nạp một lần lúc mở popup (refresh() lo phần điền sẵn ô nhập).
refreshSites();

refresh();
