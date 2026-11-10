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
    for (const [node, text] of originals) {
      if (node.parentNode) node.nodeValue = text;
      done.delete(node);
    }
    originals.clear();
    for (const span of inserted) span.remove();
    inserted.clear();
  }

  function schedule(node) {
    queue.add(node);
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const pending = [...queue].filter(n => n.parentNode && !done.has(n) && HAN_RE.test(n.nodeValue || ''));
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
          if (added.nodeType === Node.TEXT_NODE) { queue.add(added); continue; }
          if (!(added instanceof Element)) continue;
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
  let highlightLayer = null;
  let highlightSource = null;

  function clearHighlight() {
    if (highlightLayer) { highlightLayer.remove(); highlightLayer = null; }
    highlightSource = null;
  }

  function showHighlightFor(node, start, end) {
    clearHighlight();
    try {
      const range = document.createRange();
      range.setStart(node, Math.max(0, Math.min(start, node.nodeValue.length)));
      range.setEnd(node, Math.max(0, Math.min(end, node.nodeValue.length)));
      const rects = [...range.getClientRects()];
      if (!rects.length) return;
      highlightLayer = el('div', 'vp-highlight-layer');
      for (const r of rects) {
        const box = el('div', 'vp-highlight');
        box.style.left = r.left + 'px';
        box.style.top = r.top + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
        highlightLayer.appendChild(box);
      }
      (document.body || document.documentElement).appendChild(highlightLayer);
      highlightSource = { node, start, end };
    } catch { /* node đã đổi giữa chừng — bỏ qua, card vẫn mở bình thường */ }
  }

  window.addEventListener('scroll', () => {
    if (highlightSource) showHighlightFor(highlightSource.node, highlightSource.start, highlightSource.end);
  }, { passive: true, capture: true });
  window.addEventListener('resize', () => {
    if (highlightSource) showHighlightFor(highlightSource.node, highlightSource.start, highlightSource.end);
  });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

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

  function showEditor(x, y, token) {
    closePop();
    const pop = el('div', 'vp-pop');
    pop.id = 'vp-pop';

    const head = el('div', 'vp-pop-head');
    head.appendChild(el('span', 'vp-pop-han', token.han));
    head.appendChild(el('span', 'vp-pop-kind', KIND_LABELS[token.kind] || token.kind));
    pop.appendChild(head);

    const currentOverride = overridesMap[token.han];
    if (currentOverride !== undefined && currentOverride !== token.vi) {
      pop.appendChild(el('div', 'vp-pop-cur', 'Mặc định từ điển: ' + token.vi));
    }

    const input = document.createElement('input');
    input.className = 'vp-pop-input';
    input.type = 'text';
    input.value = currentOverride !== undefined ? currentOverride : token.vi;
    pop.appendChild(input);

    const btns = el('div', 'vp-pop-btns');
    const save = el('button', undefined, 'Lưu');
    save.addEventListener('click', () => saveOverride(token.han, input.value.trim()));
    btns.appendChild(save);
    if (currentOverride !== undefined) {
      const revert = el('button', undefined, 'Bỏ vá');
      revert.addEventListener('click', () => saveOverride(token.han, ''));
      btns.appendChild(revert);
    }
    // F4: vá vào bộ từ điển RIÊNG của truyện đang đọc (không ảnh hưởng truyện khác).
    const saveBook = el('button', undefined, 'Chỉ truyện này');
    saveBook.addEventListener('click', () => saveGlossary(token.han, input.value.trim()));
    btns.appendChild(saveBook);
    const close = el('button', undefined, 'Đóng');
    close.addEventListener('click', closePop);
    btns.appendChild(close);
    pop.appendChild(btns);

    pop.appendChild(el('div', 'vp-pop-hint', 'Áp dụng cho mọi nơi chữ này xuất hiện. Esc để đóng.'));
    (document.body || document.documentElement).appendChild(pop);

    const width = pop.offsetWidth || 300;
    const height = pop.offsetHeight || 140;
    pop.style.left = Math.max(8, Math.min(x - 20, (window.innerWidth || 1024) - width - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(y + 16, (window.innerHeight || 768) - height - 8)) + 'px';
    input.focus();
    input.select();
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

    const { node, offset } = caretAt(e.clientX, e.clientY);
    if (!node || node.nodeType !== Node.TEXT_NODE || !originals.has(node)) return;

    const original = originals.get(node);
    const resp = await send({ type: 'vp:tokens', texts: [original], bookKey: bookKey() });
    if (!resp || !resp.ok) return;
    const tokens = (resp.tokens && resp.tokens[0]) || [];
    const spans = (resp.spans && resp.spans[0]) || [];
    let tokenIdx = -1;
    for (const [start, idx] of spans) {
      if (offset >= start) tokenIdx = idx;
      else break;
    }
    if (tokenIdx < 0) return;
    const token = tokens[tokenIdx];
    if (!token || token[2] === 'raw') return;   // đoạn không phải chữ Hán thì không cần vá

    // F1: tô xanh thẫm đúng khoảng vi của token đang sửa (start = spans[tokenIdx][0],
    // end = start token kế hoặc cuối chuỗi). vi của token có thể bị rút space đầu
    // (needsSpace) nhưng spans ghi TRƯỚC khi rút nên dùng start là đủ chính xác.
    const tokenStart = spans.find(([start, idx]) => idx === tokenIdx)?.[0] ?? -1;
    if (tokenStart >= 0) {
      const nextStart = spans.find(([start, idx]) => idx === tokenIdx + 1)?.[0] ?? node.nodeValue.length;
      showHighlightFor(node, tokenStart, Math.max(tokenStart + 1, nextStart));
    }

    showEditor(e.clientX, e.clientY, { han: token[0], vi: token[1], kind: token[2] });
  }

  document.addEventListener('click', e => { onDocClick(e); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });

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

  async function init() {
    keepAliveStart();
    await loadConfig();
    if (!hostEnabled) return;
    await runOnce();
    startObserver();
  }

  init().catch(err => console.warn('[TuiRead] loi khoi dong:', err));
})();
