// Content script: tim text node goc truyen, gui sang engine page (background/iframe hoac
// offscreen document), ghi ket qua convert. Khong chua tu dien o day - content script dung
// chung heap voi tab.

(function () {
  'use strict';

  const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/;
  const HAN_GLOBAL = /[㐀-䶿一-鿿豈-﫿]/g;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'OPTION', 'TITLE', 'IFRAME', 'TEMPLATE']);
  const BATCH_MAX_NODES = 40;
  const BATCH_MAX_CHARS = 6000;

  const originals = new Map();   // Node -> goc (tieng Trung)
  const inserted = new Set();    // span ban chen them (che do song ngu)
  const done = new WeakSet();
  let applying = false;
  let settings = { mode: 'vi', firstMeaning: true, skipParticles: false, translateChrome: true, allowClickEdit: true };
  let hostEnabled = true;
  let observer = null;
  let queue = new Set();
  let timer = null;
  let overridesMap = {};       // ban vá của user: { chữ Hán: nghĩa } — đọc từ background, cập nhật sau mỗi lần lưu
  let siteSelectors = {};      // selector khu vực truyện theo host — cấu hình trong options, KHÔNG cứng trong code

  function host() {
    return location.hostname.replace(/^www\./, '');
  }

  // F4: key bộ từ điển riêng của truyện = host + đường dẫn sách. Chương khác nhau của
  // cùng một sách phải ra CÙNG key: uukanshu `/book/21897/16209313.html` -> `uukanshu.cc/book/21897`;
  // piaotia `/book/2342/1234567.html` -> `piaotia.com/book/2342`. Không khớp mẫu nào thì
  // dùng host + toàn bộ path (bỏ đuôi file) — vẫn gom được chương trình biểu diễn khác.
  function bookKey() {
    const path = location.pathname;
    let m = path.match(/\/book\/(\d+)\//);
    if (m) return host() + '/book/' + m[1];
    m = path.match(/^(\/[^/]+\/\d+)\//);
    if (m) return host() + m[1];
    return host() + path.replace(/[^/]+$/, '');
  }

  function hanCount(text) {
    const m = text.match(HAN_GLOBAL);
    return m ? m.length : 0;
  }

  function directHan(el) {
    let n = 0;
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) n += hanCount(child.nodeValue);
    }
    return n;
  }

  // Chon vung chua noi dung: selector cua host (cau hinh trong options — default do
  // background seed cho 2 site goc), khong thi khoi phan theo khoi nhieu chu Han nhat.
  function findContainers() {
    const rules = String(siteSelectors[host()] || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const selector of rules) {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { continue; }
      const hit = [...nodes].filter(el => hanCount(el.textContent) > 200);
      if (hit.length) return hit;
    }
    const scored = [...document.querySelectorAll('div, td, article, section, p, body > *')]
      .map(el => ({ el, han: hanCount(el.textContent) }))
      .filter(item => item.han >= 300)
      .sort((a, b) => a.han - b.han);
    if (scored.length) return [scored[0].el];
    const loose = [...document.querySelectorAll('div, td, article, section')]
      .map(el => ({ el, han: directHan(el) }))
      .filter(item => item.han >= 60);
    if (loose.length) return loose.map(item => item.el);
    return [document.body];
  }

  function collectTextNodes(containers) {
    const out = [];
    for (const root of containers) {
      if (!(root instanceof Element)) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const text = node.nodeValue;
          if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
          if (!HAN_RE.test(text)) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (isOurs(node)) return NodeFilter.FILTER_REJECT;
          if (parent.closest('.vp-orig')) return NodeFilter.FILTER_REJECT;
          if (done.has(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    }
    return out;
  }

  // ---------------------------------------------------------------- keep-alive (Firefox)
  // Giu background (event page) + engine page (iframe trong background) song trong khi user
  // dang doc trang: Firefox khong unload background khi con port/message port mo (MDN
  // Background_scripts). Chi connect thi van con khuyen/canh bao "phai thuong xuyen gui tin
  // qua port" (discourse.mozilla.org/t/124263) -> ping moi 20s cho chac. Port dong khi tab
  // dong -> background tu unload -> engine mat -> lan doc sau se tai lai (vp:ensure truoc
  // khi dich). Chrome van dung duoc port nay (van loi thuong: SW dua vao tin nhan de reset
  // idle timer). Chrome mock trong test (jsdom) khong co runtime.connect -> guard bo qua.
  let keepAlivePort = null;
  let keepAliveTimer = null;
  let keepAliveFails = 0;
  function keepAliveStop() {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    keepAlivePort = null;
  }
  function keepAliveStart() {
    try {
      if (!chrome.runtime || typeof chrome.runtime.connect !== 'function') return;
      keepAlivePort = chrome.runtime.connect({ name: 'vp:keepalive' });
      keepAlivePort.onMessage.addListener(msg => { if (msg === 'pong') keepAliveFails = 0; });
      keepAlivePort.onDisconnect.addListener(() => {
        keepAliveStop();
        // Background/mat port khong phai luc nao cung do tab dong: background crash/giiet la
        // mot lan. Connect lai = dayh thuc event page bang runtime (FF/event page wake on
        // connect), nhung gioi han 5 lan de khong vong vo han khi extension bi go.
        if (keepAliveFails++ < 5) setTimeout(() => keepAliveStart(), 1500);
      });
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAliveTimer = setInterval(() => {
        if (!keepAlivePort) { keepAliveStop(); return; }
        try { keepAlivePort.postMessage('ping'); } catch { /* port da dong -> onDisconnect lo */ }
      }, 20000);
    } catch { keepAliveStop(); }
  }

  function send(message) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      // Engine co the khong ton tai (Firefox: chua tao iframe; Edge thu hoi renderer); khong
      // co timeout thi trang khet "dang dich" vinh vien va nguoi dung khong con cach nao.
      const timer = setTimeout(() => finish({ ok: false, error: 'hết giờ chờ engine (15s)' }), 15000);
      try {
        chrome.runtime.sendMessage(message, response => {
          if (chrome.runtime.lastError) return finish({ ok: false, error: chrome.runtime.lastError.message });
          finish(response || { ok: false, error: 'khong co phan hoi' });
        });
      } catch (err) {
        finish({ ok: false, error: String(err && err.message || err) });
      }
    });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // vp:ensure -> background tao engine page (Firefox: iframe an trong background; Chrome:
  // offscreen document) roi CHO engine page nhan onMessage (module script chua kip chay tu
  // iframe/HTML moi tao) truoc khi dich lai. Lan thu 2/3 de phong truong hop load cham.
  async function askTranslate(texts) {
    let resp = await send({ type: 'vp:translate', texts, bookKey: bookKey() });
    if (resp && resp.ok) return resp.results;
    await send({ type: 'vp:ensure' });
    for (const wait of [300, 900]) {
      await sleep(wait);
      resp = await send({ type: 'vp:translate', texts, bookKey: bookKey() });
      if (resp && resp.ok) return resp.results;
    }
    throw new Error((resp && resp.error) || 'engine khong phan hoi');
  }

  function makeBatch(nodes) {
    const batch = [];
    let chars = 0;
    for (const node of nodes) {
      batch.push(node);
      chars += node.nodeValue.length;
      if (batch.length >= BATCH_MAX_NODES || chars >= BATCH_MAX_CHARS) break;
    }
    return batch;
  }

  function applyResult(node, original, translated) {
    if (!translated || translated === original) return;
    originals.set(node, original);
    if (settings.mode === 'vi-han') {
      const span = document.createElement('span');
      span.className = 'vp-orig';
      span.textContent = original;
      node.parentNode.insertBefore(span, node.nextSibling);
      inserted.add(span);
    }
    // Font SF Pro Display cho bản dịch: text node trần không nhận được font từ CSS,
    // phải bọc span .vp-vi quanh node (span nằm trong `inserted` để restore() dọn sạch).
    const vi = document.createElement('span');
    vi.className = 'vp-vi';
    // Kế thừa kiểu chữ từ nơi text node đang sống: span mới mặc định nhận font của trang
    // chứ KHÔNG kế thừa đúng weight/style từ cha (span là phần tử mới, tính toán lại).
    const cs = getComputedStyle(node.parentElement || document.body);
    vi.style.fontSize = cs.fontSize;
    vi.style.lineHeight = cs.lineHeight;
    vi.style.fontWeight = cs.fontWeight === '400' ? '400' : cs.fontWeight;
    if (cs.fontStyle === 'italic') vi.style.fontStyle = 'italic';
    vi.style.textTransform = cs.textTransform;
    vi.style.letterSpacing = cs.letterSpacing;
    node.parentNode.insertBefore(vi, node);
    vi.appendChild(node);
    inserted.add(vi);
    node.nodeValue = translated;
    done.add(node);
  }

  async function translatePending(nodes) {
    if (!nodes.length) return;
    applying = true;
    try {
      let remaining = nodes.slice();
      while (remaining.length) {
        const batch = makeBatch(remaining);
        remaining = remaining.slice(batch.length);
        const texts = batch.map(node => (originals.get(node) || node.nodeValue));
        try {
          const results = await askTranslate(texts);
          batch.forEach((node, i) => applyResult(node, texts[i], results[i]));
        } catch (err) {
          console.warn('[TuiRead] loi engine:', err.message);
          setStatusChip('Engine chưa sẵn sàng - thử tải lại trang');
          return;
        }
      }
    } finally {
      applying = false;
    }
  }

  async function runOnce() {
    if (!hostEnabled) return;
    const nodes = collectTextNodes(findContainers());
    if (settings.translateChrome !== false) {
      // Menu/header/footer nam ngoai khoi truyen: dich sau khi than truyen xong de khong cham hua.
      const seen = new Set(nodes);
      for (const n of collectTextNodes([document.body])) if (!seen.has(n)) nodes.push(n);
    }
    if (nodes.length) await translatePending(nodes);
  }

  function restore() {
    clearHighlight();   // gỡ <mark> chọn từ (ghép lại node) trước khi trả nguyên trạng
    for (const [node, text] of originals) {
      if (node.parentNode) node.nodeValue = text;
      done.delete(node);
    }
    originals.clear();
    for (const span of inserted) {
      const parent = span.parentNode;
      if (!parent) continue;
      if (span.classList && span.classList.contains('vp-vi')) {
        // Bọc .vp-vi đang CHỨA text node gốc — unwrap (đẩy node ra chỗ cũ) trước khi
        // remove, nếu không xoá mất luôn bản gốc Hán.
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        span.remove();
      } else {
        span.remove();   // .vp-orig: chữ Hán chèn thêm, xoá thẳng là đúng
      }
    }
    inserted.clear();
  }

  function schedule(node) {
    if (node) queue.add(node);   // observer gọi schedule() KHÔNG đối số khi chỉ muốn flush
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const pending = [...queue].filter(n => n && n.parentNode && !done.has(n) && !isOurs(n) && HAN_RE.test(n.nodeValue || ''));
      queue.clear();
      if (pending.length) await translatePending(pending);
    }, 350);
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(mutations => {
      if (applying) return;
      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE) {
            if (added.nodeValue && HAN_RE.test(added.nodeValue) && !isOurs(added)) queue.add(added);
            continue;
          }
          if (!(added instanceof Element)) continue;
          if (added.closest('.vp-pop, .vp-orig, .vp-vi, .vp-status-chip, .vp-highlight-layer')) continue;
          const walker = document.createTreeWalker(added, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) queue.add(n);
        }
      }
      if (queue.size) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function setStatusChip(text) {
    let chip = document.getElementById('vp-status-chip');
    if (!text) { if (chip) chip.remove(); return; }
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'vp-status-chip';
      chip.className = 'vp-status-chip';
      (document.body || document.documentElement).appendChild(chip);
    }
    chip.textContent = text;
  }

  // ---------------------------------------------------------------- tokenMap click-to-edit
  // Bấm vào một đoạn đã dịch -> hiện card: chữ Hán gốc + nghĩa đang dùng + ô sửa nghĩa.
  // Lưu -> ghi vào layer override (chrome.storage qua background) -> engine rebuild
  // -> cache tự chết theo version -> dịch lại trang với nghĩa mới. File từ điển gốc không
  // bao giờ bị sửa; bản vá nằm riêng và export/import được từ options page.
  const KIND_LABELS = {
    ov: 'bản vá của bạn',
    vp: 'cụm từ điển',
    vp1: 'tự điển',
    name: 'tên riêng',
    rule: 'quy tắc (số/ngày)',
    pa: 'âm Hán Việt — chưa có trong từ điển'
  };

  // Text node nằm trong element DO TUIREAD tạo (card, chip, chữ Hán gốc, layer highlight,
  // status chip) thì TUYỆT ĐỐI không đưa vào hàng đợi dịch — nếu không observer tự dịch
  // chữ Hán trong card của chính mình (chip 汉 hiện nghĩa Việt sau 350ms).
  function isOurs(n) {
    try {
      const p = n && n.parentElement;
      return !!(p && p.closest && p.closest('.vp-pop, .vp-orig, .vp-vi, .vp-status-chip, .vp-highlight-layer'));
    } catch { return false; }
  }

  // el(tag, class, text): helper tạo element — bị mất trong lần cắt khối highlight,
  // mọi chỗ dựng card/chip/layer đều gọi nó.
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function closePop() {
    const pop = document.getElementById('vp-pop');
    if (pop) pop.remove();
    clearHighlight();
  }

  // ---------------------------------------------------------------- highlight từ đang chọn
  // Tô nền xanh thẫm lên đúng đoạn đã dịch đang được sửa (F1). Vẽ bằng
  // Range.getClientRects() lên một layer pointer-events:none -> KHÔNG đụng vào DOM text,
  // nên không phá originals/observer và không kích hoạt dịch lại. Layer fixed + vẽ lại khi
  // scroll/resize vì rect là toạ độ khung nhìn.
  // F1 (bản 3): đánh dấu từ đang chọn bằng <mark class="vp-sel"> THẬT — tách text node
  // thành [trước][token][sau], bọc token trong mark. DOM + CSS thuần, không phụ thuộc
  // API nào cả, hiển thị chắc chắn. Khi đóng card: replaceWith(text) + normalize() =>
  // text node ĐẦU TIÊN (chính là node gốc trong `originals`) hấp thụ lại toàn bộ chuỗi
  // -> originals/done vẫn đúng, restore() trả trang về nguyên trạng như chưa từng bọc.
  let selMark = null;

  function clearHighlight() {
    if (selMark && selMark.parentNode) {
      const parent = selMark.parentNode;
      const text = selMark.textContent;
      selMark.replaceWith(document.createTextNode(text));
      parent.normalize();   // gộp [trước][token][sau] về đúng node gốc ban đầu
    }
    selMark = null;
  }

  function showHighlightFor(node, start, end) {
    clearHighlight();
    try {
      if (!node || !node.parentNode) return;
      const text = node.nodeValue;
      start = Math.max(0, Math.min(start, text.length));
      end = Math.max(start, Math.min(end, text.length));
      if (end <= start) return;
      node.nodeValue = text.slice(0, start);
      const mark = document.createElement('mark');
      mark.className = 'vp-sel';
      mark.textContent = text.slice(start, end);
      const afterNode = document.createTextNode(text.slice(end));
      node.parentNode.insertBefore(mark, node.nextSibling);
      node.parentNode.insertBefore(afterNode, mark.nextSibling);
      selMark = mark;
    } catch { /* node đã đổi giữa chừng — bỏ qua */ }
  }

  async function saveOverride(han, vi) {
    const resp = await send({ type: 'vp:override-set', han, vi });
    if (!resp || !resp.ok) {
      setStatusChip('Không lưu được bản vá: ' + ((resp && resp.error) || 'không có phản hồi'));
      setTimeout(() => setStatusChip(''), 5000);
      return false;
    }
    overridesMap = resp.overrides || {};
    closePop();
    setStatusChip('Đã vá "' + han + '" — đang dịch lại trang…');
    restore();
    await runOnce();
    setStatusChip('');
    return true;
  }

  // F4: lưu nghĩa vào bộ từ điển RIÊNG của truyện (glossary per-book). Engine rebuild
  // theo bookKey -> trang tự dịch lại với nghĩa mới; truyện khác không bị ảnh hưởng.
  async function saveGlossary(han, vi) {
    const resp = await send({ type: 'vp:glossary-set', bookKey: bookKey(), han, vi });
    if (!resp || !resp.ok) {
      setStatusChip('Không lưu được glossary: ' + ((resp && resp.error) || 'không có phản hồi'));
      setTimeout(() => setStatusChip(''), 5000);
      return false;
    }
    closePop();
    setStatusChip('Đã vá "' + han + '" vào truyện này — đang dịch lại…');
    restore();
    await runOnce();
    setStatusChip('');
    return true;
  }

  function showEditor(x, y, token, ctx) {
    // Gỡ card cũ (nếu có) nhưng GIỮ highlight: onDocClick vừa vẽ vùng chọn trước khi
    // gọi hàm này; closePop() ở đây từng xoá highlight ngay sau khi vẽ -> không thấy màu.
    const oldPop = document.getElementById('vp-pop');
    if (oldPop) oldPop.remove();
    const pop = el('div', 'vp-pop');
    pop.id = 'vp-pop';
    const state = {
      from: ctx.tokenIdx, to: ctx.tokenIdx,   // vung token dang chon [from..to]
      han: token.han, vi: token.vi, kind: token.kind
    };
    ctx.tokensRef = ctx.tokens;               // chi doc

    const head = el('div', 'vp-pop-head');
    const hanBox = el('span', 'vp-pop-han');
    head.appendChild(hanBox);
    head.appendChild(el('span', 'vp-pop-kind', KIND_LABELS[token.kind] || token.kind));
    pop.appendChild(head);

    // Am Han Viet cua vung chon (F-am): doc tu token[3] (offscreen tra phienOf); token cu
    // chi 3 phan tu thi tinh tam bang phienOf tu token.han.
    const phien = el('div', 'vp-pop-phien');
    pop.appendChild(phien);

    const cur = el('div', 'vp-pop-cur');
    pop.appendChild(cur);

    const input = document.createElement('input');
    input.className = 'vp-pop-input';
    input.type = 'text';
    pop.appendChild(input);

    // Vung chon hien tai: han ghep tu tokens[from..to], mac dinh la nghia ghep cua chung.
    function selHan() {
      let h = '';
      for (let i = state.from; i <= state.to; i++) h += ctx.tokens[i][0];
      return h;
    }
    function selDefaultVi() {
      let v = '';
      for (let i = state.from; i <= state.to; i++) v += ctx.tokens[i][1];
      return v;
    }

    let lastRange = state.from + '.' + state.to;   // vung da render lan truoc (kể cả lần đầu)
    function render() {
      // Chip tung CHU Han: bam vao chu o dau/cuoi de THU nhe vung (F2 - sua tong tu).
      hanBox.textContent = '';
      const han = selHan();
      let charIdx = 0;
      for (let ti = state.from; ti <= state.to; ti++) {
        const t = ctx.tokens[ti];
        for (const ch of t[0]) {
          const chip = el('button', 'vp-chip');
          chip.textContent = ch;
          const ci = charIdx;
          chip.addEventListener('click', () => {
            // bam chip nao: neu la chu dau -> bo token dau; chu cuoi -> bo token cuoi;
            // chip giua -> thu ve dung token do (from=to=ti).
            if (ci === 0 && state.from < state.to) state.from++;
            else if (ci + 1 >= [...han].length && state.to > state.from) state.to--;
            else { state.from = ti; state.to = ti; }
            render();
          });
          hanBox.appendChild(chip);
          charIdx++;
        }
        if (ti < state.to) hanBox.appendChild(el('span', 'vp-chip-sep', '·'));
      }
      state.han = han;
      let ph = '';
      for (let i = state.from; i <= state.to; i++) {
        const t = ctx.tokens[i];
        ph += (t.length >= 4 ? t[3] : (ctx.phienOf ? ctx.phienOf(t[0]) : '')) + ' ';
      }
      phien.textContent = ph.trim();
      phien.style.display = ph.trim() ? '' : 'none';
      const hasOv = overridesMap[state.han] !== undefined;
      cur.textContent = hasOv && overridesMap[state.han] !== selDefaultVi()
        ? 'Mặc định từ điển: ' + selDefaultVi()
        : '';
      if (input.value === '' || input.dataset.auto === '1') {
        input.value = hasOv ? overridesMap[state.han] : selDefaultVi();
        input.dataset.auto = '1';
      }
      const saveBtn = pop.querySelector('.vp-save');
      if (saveBtn) saveBtn.textContent = state.from === state.to ? 'Lưu' : 'Lưu (' + (state.to - state.from + 1) + ' từ)';
      // So voi vung LAN RENDER TRUOC (state co the bi nut ◀▶ doi truoc khi render goi,
      // nen so trong render thi luon bang nhau -> setRange khong bao gio chay).
      const nowRange = state.from + '.' + state.to;
      if (ctx.setRange && nowRange !== lastRange) { lastRange = nowRange; ctx.setRange(state.from, state.to); }
    }

    const btns = el('div', 'vp-pop-btns');
    // Mo rong vung sang token ke ben trai/phai (khong gioi han so lan bam).
    const left = el('button', undefined, '◀');
    left.title = 'Gộp thêm token bên trái';
    left.addEventListener('click', () => {
      if (state.from > 0 && ctx.tokens[state.from - 1][2] !== 'raw') { state.from--; render(); }
    });
    btns.appendChild(left);
    const shrink = el('button', undefined, 'Thu gọn');
    shrink.title = 'Thu về đúng token đầu';
    shrink.addEventListener('click', () => { state.to = state.from; render(); });
    btns.appendChild(shrink);
    const right = el('button', undefined, '▶');
    right.title = 'Gộp thêm token bên phải';
    right.addEventListener('click', () => {
      if (state.to + 1 < ctx.tokens.length && ctx.tokens[state.to + 1][2] !== 'raw') { state.to++; render(); }
    });
    btns.appendChild(right);

    const save = el('button', 'vp-save', 'Lưu');
    save.title = 'Lưu vào bộ từ điển riêng của truyện này';
    save.addEventListener('click', () => { input.dataset.auto = '0'; saveGlossary(state.han, input.value.trim()); });
    btns.appendChild(save);
    const saveGlobal = el('button', undefined, 'Lưu vào từ điển VP');
    saveGlobal.title = 'Áp dụng cho MỌI truyện (bản vá toàn cục)';
    saveGlobal.addEventListener('click', () => { input.dataset.auto = '0'; saveOverride(state.han, input.value.trim()); });
    btns.appendChild(saveGlobal);
    if (overridesMap[state.han] !== undefined) {
      const revert = el('button', undefined, 'Bỏ vá VP');
      revert.addEventListener('click', () => { input.dataset.auto = '0'; saveOverride(state.han, ''); });
      btns.appendChild(revert);
    }
    const close = el('button', undefined, 'Đóng');
    close.addEventListener('click', closePop);
    btns.appendChild(close);
    pop.appendChild(btns);

    pop.appendChild(el('div', 'vp-pop-hint', '◀ ▶ gộp token kề; bấm chip chữ Hán để thu vùng. ' + String.fromCharCode(34) + 'Lưu' + String.fromCharCode(34) + ' = từ điển riêng của truyện này; ' + String.fromCharCode(34) + 'Lưu vào từ điển VP' + String.fromCharCode(34) + ' = mọi truyện. Esc đóng.'));
    (document.body || document.documentElement).appendChild(pop);
    render();

    const width = pop.offsetWidth || 300;
    const height = pop.offsetHeight || 140;
    pop.style.left = Math.max(8, Math.min(x - 20, (window.innerWidth || 1024) - width - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(y + 16, (window.innerHeight || 768) - height - 8)) + 'px';
    input.focus();
  }


  // caretAt(x, y): tìm text node + vị trí ký tự tại toạ độ màn hình (đường vào chính của
  // click-to-edit). Firefox có caretRangeFromPoint; chuẩn là caretPositionFromPoint.
  function caretAt(x, y) {
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      if (range) return { node: range.startContainer, offset: range.startOffset };
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) return { node: pos.offsetNode, offset: pos.offset };
    }
    return { node: null, offset: -1 };
  }

  // Chọn token bằng HIT-TEST HÌNH HỌC: dựng Range cho từng token (biết start/end trong
  // chuỗi), lấy rect THẬT trên màn hình, token nào chứa điểm click thì chọn. Chính xác
  // tuyệt đối vì đo chữ đã render — không lệch bởi font/reflow/user-select như
  // caretRangeFromPoint (nhiều site tiểu thuyết đặt user-select:none để chống copy).
  function tokenIndexAtPoint(node, tokens, spans, x, y) {
    const len = node.nodeValue.length;
    for (let k = 0; k < spans.length; k++) {
      const [start, idx] = spans[k];
      const t = tokens[idx];
      if (!t || t[2] === 'raw') continue;
      const end = k + 1 < spans.length ? spans[k + 1][0] : len;
      if (end <= start) continue;
      let range;
      try {
        range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
      } catch { continue; }
      for (const rect of range.getClientRects()) {
        if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 3 && y <= rect.bottom + 3) return idx;
      }
    }
    return -1;
  }

  async function onDocClick(e) {
    const pop = document.getElementById('vp-pop');
    if (pop) {
      if (e.target && e.target.closest && e.target.closest('#vp-pop')) return;   // bấm trong card: để nút tự xử
      closePop();
    }
    if (!settings.allowClickEdit) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('a, button, input, select, textarea, label, #vp-status-chip')) return;

    let { node, offset } = caretAt(e.clientX, e.clientY);
    // Bấm vào CHỮ HÁN GỐC (span.vp-orig, mode vi+Hán): ánh xạ về node Việt tương ứng
    // (span.vp-orig được chèn NGAY SAU node Việt trong applyResult).
    if (node && node.parentElement && node.parentElement.classList &&
        node.parentElement.classList.contains('vp-orig')) {
      const viNode = node.parentElement.previousSibling;
      if (viNode && originals.has(viNode)) { node = viNode; offset = Math.floor((viNode.nodeValue || '').length / 2); }
      else return;
    }
    // caretAt có thể trả node của TRANG (site can thiệp caret) hoặc element trực tiếp;
    // nếu node không phải text đã dịch, DÙNG TỌA ĐỘ để tìm text node đã dịch gần nhất
    // (elementFromPoint → vị trí đầu của node con .vp-vi/.vp-vi con trực tiếp).
    if (!node || node.nodeType !== Node.TEXT_NODE || !originals.has(node)) {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const viSpan = hit && (hit.classList && hit.classList.contains('vp-vi') ? hit : (hit && hit.querySelector ? hit.querySelector('.vp-vi') : null));
      const viNode = viSpan && viSpan.firstChild;
      if (viNode && viNode.nodeType === Node.TEXT_NODE && originals.has(viNode)) {
        node = viNode;
        offset = -1;   // KHONG uoc luong offset theo X (sai voi chu Viet) — tokenIndexAtPoint
                       // se chon token theo rect that; caret-offset chi la fallback.
      } else {
        return;
      }
    }

    const original = originals.get(node);
    const resp = await send({ type: 'vp:tokens', texts: [original], bookKey: bookKey() });
    if (!resp || !resp.ok) return;
    const tokens = (resp.tokens && resp.tokens[0]) || [];
    const spans = (resp.spans && resp.spans[0]) || [];
    // 1) Hit-test hình học theo rect thật của từng token (chính xác nhất).
    let tokenIdx = tokenIndexAtPoint(node, tokens, spans, e.clientX, e.clientY);
    // 2) Fallback: caret offset (trường hợp rect bị chặn/ẩn bởi overlay của trang).
    if (tokenIdx < 0 && offset >= 0) {
      for (const [start, idx] of spans) {
        if (offset >= start) tokenIdx = idx;
        else break;
      }
    }
    if (tokenIdx < 0) return;
    const token = tokens[tokenIdx];
    if (!token || token[2] === 'raw') return;   // đoạn không phải chữ Hán thì không cần vá

    // F1+F2: tô xanh thẫm vùng token đang chọn; card nhận ctx để mở rộng/thu vùng.
    const tokenStart = spans.find(([start, idx]) => idx === tokenIdx)?.[0] ?? -1;
    if (tokenStart >= 0) {
      const nextStart = spans.find(([start, idx]) => idx === tokenIdx + 1)?.[0] ?? node.nodeValue.length;
      showHighlightFor(node, tokenStart, Math.max(tokenStart + 1, nextStart));
    }

    showEditor(e.clientX, e.clientY, { han: token[0], vi: token[1], kind: token[2] }, {
      tokens, spans, tokenIdx, node,
      phienOf: resp.phienOf,
      // mở vùng chọn khi user bấm ◀ ▶ (đồng bộ highlight theo vùng mới)
      setRange(from, to) {
        const s = spans.find(([start, idx]) => idx === from)?.[0] ?? -1;
        const e2 = to + 1 < tokens.length ? (spans.find(([start, idx]) => idx === to + 1)?.[0] ?? node.nodeValue.length) : node.nodeValue.length;
        if (s >= 0) showHighlightFor(node, s, Math.max(s + 1, e2));
        else clearHighlight();
      }
    });
  }

  document.addEventListener('click', e => { onDocClick(e); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });
  // Phím mũi tên khi đang gõ trong input/textarea của card KHÔNG được làm trang cuộn/chuyển
  // chương (uukanshu đổi chương bằng mũi tên). Chặn ở WINDOW pha capture = chạy trước mọi
  // handler của trang; chỉ dừng lan truyền (stopPropagation), KHÔNG preventDefault -> caret
  // trong ô nhập vẫn di chuyển sang trái/phải bình thường.
  window.addEventListener('keydown', e => {
    if (!e.key || !e.key.startsWith('Arrow')) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (typing && t.closest && t.closest('.vp-pop')) e.stopPropagation();
  }, { capture: true });

  // Doc config qua background (event page), khong doc chrome.storage truc tiep:
  // background la noi luu tru duy nhat va chac chan co chrome.storage (xem background.js).
  async function loadConfig() {
    const got = await send({ type: 'vp:get-settings' });
    const store = got && got.ok ? got : {};
    settings = { ...settings, ...(store.settings || {}) };
    overridesMap = store.overrides || {};
    siteSelectors = store.siteSelectors || {};
    const state = store.hostState || {};
    hostEnabled = state[host()] !== false;
    document.body.classList.toggle('vp-mode-han', settings.mode === 'vi-han');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'vp:command') return false;
    (async () => {
      if (msg.action === 'status') {
        sendResponse({ ok: true, host: host(), enabled: hostEnabled, translated: originals.size });
        return;
      }
      await loadConfig();
      if (msg.action === 'enable') {
        hostEnabled = true;
        startObserver();
        await runOnce();
      } else if (msg.action === 'disable') {
        hostEnabled = false;
        restore();
      } else if (msg.action === 'retranslate') {
        restore();
        await runOnce();
      }
      sendResponse({ ok: true, host: host(), enabled: hostEnabled, translated: originals.size });
    })();
    return true;
  });

  // Font SF Pro Display: CSS của content script có URL tương đối bị resolve theo NGUỒN TRANG
  // (uukanshu.cc) -> Firefox chặn tải font từ moz-extension://. Cách đúng: đăng ký bằng
  // FontFace API với URL tuyệt đối chrome.runtime.getURL — không đụng CSP của trang.
  const FONT_FILES = [
    ['400', 'normal', 'fonts/sf-pro/SF-Pro-Display-Regular.otf'],
    ['500', 'normal', 'fonts/sf-pro/SF-Pro-Display-Medium.otf'],
    ['700', 'normal', 'fonts/sf-pro/SF-Pro-Display-Bold.otf'],
    ['400', 'italic', 'fonts/sf-pro/SF-Pro-Display-RegularItalic.otf']
  ];
  let fontsRegistered = false;
  function registerFonts() {
    if (fontsRegistered || !(window.FontFace && chrome.runtime && chrome.runtime.getURL)) return;
    fontsRegistered = true;
    for (const [weight, style, path] of FONT_FILES) {
      try {
        const face = new FontFace('SF Pro Display', 'url(' + chrome.runtime.getURL(path) + ')', { weight, style });
        face.load().then(f => document.fonts.add(f)).catch(() => { /* font lỗi thì rơi về system-ui */ });
      } catch { /* trình duyệt cũ */ }
    }
  }

  async function init() {
    keepAliveStart();
    registerFonts();
    await loadConfig();
    if (!hostEnabled) return;
    await runOnce();
    startObserver();
  }

  init().catch(err => console.warn('[TuiRead] loi khoi dong:', err));
})();
