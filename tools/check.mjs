// Kiem tra tuyen tinh (regression check) cho TuiRead (ten cu: VietPhrase Reader).
// Dung: node tools/check.mjs        -> chay toan bo, exit 1 neu co fail
//        node tools/check.mjs --fast -> bo qua phan DOM (nhanh hon nhieu)
//        node tools/check.mjs --verbose

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEngine, parseDict, parseT2S, decode, FILES, createEngine } from '../engine/index.js';
import { stripComments } from './lib/strip-comments.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readFile = name => fs.readFileSync(path.join(root, 'dict', name));
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
// Ma da cat comment — dung o nhieu section (6a chung minh bo lot nay an toan truoc khi tin).
const codeOf = f => stripComments(read(f));
const verbose = process.argv.includes('--verbose');
const fast = process.argv.includes('--fast');

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    if (verbose) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  } else {
    failures.push(name + (detail ? '  -> ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

// ---------------------------------------------------------------- 1. Goi dict
section('1. Tu dian va thoi gian nap');
const t0 = Date.now();
const engine = await loadEngine(readFile, {});
const loadMs = Date.now() - t0;

check('dict VP >= 600k muc tu', engine.info.vp >= 600000, engine.info.vp + ' muc');
check('dict Names >= 10k muc tu', engine.info.names >= 10000, engine.info.names + ' muc');
check('bang phien am PA >= 15k don zi', engine.info.pa >= 15000, engine.info.pa + ' zi');
check('rule engine >= 500 rule dang dung', engine.info.rules >= 500, engine.info.rules + ' rule, loi ' + engine.ruleStats.skippedInvalid);
check('bang 繁->簡 >= 4000 don zi', engine.t2sSize >= 4000, engine.t2sSize + ' zi');
check('nap dict < 8 giay', loadMs < 8000, loadMs + 'ms');

// Dict gộp (build-dict-merge 2026-11-07) ghi UTF-8 — không còn BOM UTF-16 như dump truyencuatui cũ.
check('VP gộp là UTF-8 (không BOM UTF-16)', !(readFile('VietPhrase.txt')[0] === 0xff && readFile('VietPhrase.txt')[1] === 0xfe));
check('decode() đọc được VP gộp UTF-8 và không sót BOM', !decode(readFile('VietPhrase.txt')).startsWith('\uFEFF') && decode(readFile('VietPhrase.txt')).includes('我'));

// ---------------------------------------------------------------- 2. Dich golden
section('2. Cac cau dich vong (golden cases)');
const GOLDEN = [
  ['我愛你', 'Ta yêu ngươi'],  // dict gộp (dòng STV) chọn văn phong Hán-Việt ta/ngươi
  ['第三章', 'Chương 3:'],
  ['你好，世界！', 'Ngươi khỏe, thế giới!'],   // firstMeaning off: 'thế giới/vũ trụ/...' — check riêng ở dưới
  ['他是一個很厲害的人。', 'Hắn là một cái người rất lợi hại.'],
  ['百分之五十', '50%'],
  ['這是系統', 'Đây là hệ thống'],
  ['剑神', 'Kiếm Thần'],
  ['第二百三十六章  battle', 'Chương 236: battle']
];
// firstMeaning mặc định TẮT (hiển thị TẤT CẢ nghĩa cách nhau '/') — golden case chỉ
// bắt buộc NGHĨA ĐẦU đúng: got phải bắt đầu bằng nghĩa mong muốn.
for (const [zh, vi] of GOLDEN) {
  if (zh === '你好，世界！') continue;   // kiểm tra riêng bên dưới (nghịa 'thế giới' có nhiều nghĩa)
  const got = engine.translate(zh).vi;
  check('dich "' + zh + '"', got === vi || got.startsWith(vi + '/') || got.startsWith(vi + ' '), 'got "' + got + '" muon "' + vi + '"');
}
check('dich "你好，世界！" (nghia dau + dau câu)', engine.translate('你好，世界！').vi.startsWith('Ngươi khỏe, thế giới') && engine.translate('你好，世界！').vi.includes('!'));

// ---------------------------------------------------------------- 3. Han vi engine
section('3. Han vi xu ly');
check('khong co chu Han -> tra nguyen van', engine.translate('hello world 123').vi === 'hello world 123');
check('chuoi trong -> nguyen van', engine.translate('   ').vi === '   ');
check('idempotent: dich ket qua dich khong doi',
  engine.translate(engine.translate('這是系統').vi).vi === engine.translate('這是系統').vi);
check('khong con dau ":" + "." liet nhau (loi dict 第X章)', !/:\./.test(engine.translate('第三章').vi));
check('dau câu full-width duoc chuan hoa', engine.translate('你好，世界！').vi.includes(', ') && engine.translate('你好，世界！').vi.includes('!'));
check('繁->簡 bat buoc truoc khi tra VP', engine.translate('這是系統').vi === engine.translate('这是系统').vi);
check('so Trung van -> chu so ả Rập', /236/.test(engine.translate('第二百三十六章').vi));
check('don zi khong co trong VP roi ve am Han Viet', engine.translate('她说：「你好吗？」').stats.phraseChars > 0);

const pa = parseDict(decode(readFile('ChinesePhienAmWords.txt')), { singleChar: true });
const t2sMap = parseT2S(decode(readFile('TSCharacters.txt')));
check('huong bang 繁->簡 dung (愛->爱, khong phai nguoc lai)', t2sMap.get('愛') === '爱' && !t2sMap.get('爱'));
check('PA la bang don zi (moi key 1 chu)', pa.size > 0 && [...pa.keys()].every(k => [...k].length === 1));

const multi = await loadEngine(readFile, { firstMeaning: false });
check('tat ca nghia khi firstMeaning=false (multi engine)', multi.translate('她').vi === 'Nàng/他', multi.translate('她').vi);
check('firstMeaning=false -> nhieu nghia phan tach', multi.translate('她').vi === 'Nàng/他', multi.translate('她').vi);

// ---------------------------------------------------------------- 3b. Layer override (tokenMap click-to-edit)
section('3b. Layer override: bản vá của user thắng mọi tầng từ điển');
const mkOvEngine = (overrides, settings = {}) => createEngine(
  {
    vp: new Map([['魔法', 'phép thuật/pháp thuật'], ['厲害', 'lợi hại']]),
    names: new Map([['林動', 'Lâm Động']]),
    pa: new Map([['魔', 'ma'], ['法', 'pháp']]),
    t2s: new Map([['煉', '炼']]),
    overrides
  },
  settings
);
check('override thang VP (ca khi firstMeaning on)', mkOvEngine(new Map([['魔法', 'ma thuật riêng']])).translate('魔法').vi === 'Ma thuật riêng',
  mkOvEngine(new Map([['魔法', 'ma thuật riêng']])).translate('魔法').vi);
check('khong override -> VP tra nghia dau (default firstMeaning on)', mkOvEngine(new Map()).translate('魔法').vi === 'Phép thuật', mkOvEngine(new Map()).translate('魔法').vi);
check('firstMeaning=true (bat lai trong options) -> mot nghia dau', mkOvEngine(new Map(), { firstMeaning: true }).translate('她').vi === '她', mkOvEngine(new Map(), { firstMeaning: true }).translate('她').vi);
check('firstMeaning=false trong settings -> tat ca nghia', mkOvEngine(new Map(), { firstMeaning: false }).translate('魔法').vi === 'Phép thuật/pháp thuật');
check('override thang Names', mkOvEngine(new Map([['林動', 'Võ Động']])).translate('林動出手').vi.startsWith('Võ Động'),
  mkOvEngine(new Map([['林動', 'Võ Động']])).translate('林動出手').vi);
check('override don tu thang PA fallback', mkOvEngine(new Map([['魔', 'ma thuật']])).translate('魔法').vi.startsWith('Ma thuật'),
  mkOvEngine(new Map([['魔', 'ma thuật']])).translate('魔法').vi);
check('override key 簡 khop van ban 繁 (tra sau buoc 繁->簡)', mkOvEngine(new Map([['炼丹', 'luyện đan']])).translate('煉丹').vi === 'Luyện đan',
  mkOvEngine(new Map([['炼丹', 'luyện đan']])).translate('煉丹').vi);
check('override khong lan sang cu khac', mkOvEngine(new Map([['魔法', 'ma thuật riêng']])).translate('厲害').vi === 'Lợi hại');
const ovInfoEngine = mkOvEngine(new Map([['魔法', 'ma thuật riêng'], ['林動', 'Võ Động']]));
check('engine.info.ov dem so ban vá', ovInfoEngine.info.ov === 2, JSON.stringify(ovInfoEngine.info));

// spans phai dung vi tri trong chuoi vi CUOI CUNG (nens click-to-edit map chuot -> token)
const spanRes = mkOvEngine(new Map([['魔法', 'ma thuật riêng']])).translate('魔法厲害。');
const span0 = spanRes.spans[0];
check('spans: token override nam dau chuoi vi', span0 && span0[0] === 0 && spanRes.tokens[span0[1]] && spanRes.tokens[span0[1]].kind === 'ov',
  JSON.stringify(spanRes.spans) + ' vi="' + spanRes.vi + '"');
const span1 = spanRes.spans[1];
check('spans: token ke tiep dung vi tri sau khi ghep + space', span1 && spanRes.vi.slice(span1[0]).startsWith(spanRes.tokens[span1[1]].vi),
  JSON.stringify(spanRes.spans) + ' vi="' + spanRes.vi + '"');
const spanGolden = engine.translate('第二百三十六章  battle');
check('spans: khong lech sau khi rua (golden co space doi)', spanGolden.spans.length === 2 && spanGolden.vi.slice(spanGolden.spans[1][0]).startsWith('battle'),
  JSON.stringify(spanGolden.spans) + ' vi="' + spanGolden.vi + '"');

// ---------------------------------------------------------------- 3c. Supplement dict + dict gộp (2026-11-07)
section('3c. Supplement dict: lop bo tro giua override user va dict goc');
check('supplement da nap theo goi', engine.supplementSize === 7478, 'supplementSize=' + engine.supplementSize); // 26 Supplement + 7.453 Pack-UuHoa (da loc 34 muc rac), trung 1 khoa
check('supplement sua order xau (明白了=hiểu rồi)', engine.translate('明白了').vi.startsWith('Hiểu rồi'), engine.translate('明白了').vi);
check('supplement go bo trash ":": 当', engine.translate('当').vi.startsWith('Làm'), engine.translate('当').vi);
check('supplement go bo trash ":": 点', engine.translate('点').vi.startsWith('Điểm'), engine.translate('点').vi);
check('supplement go bo trash ":": 一顿', engine.translate('一顿').vi.startsWith('Một trận'), engine.translate('一顿').vi);
check('supplement them muc thieu (整活)', engine.translate('整活').vi.startsWith('Làm trò'), engine.translate('整活').vi);
check('supplement them muc thieu (蜘蛛人)', engine.translate('蜘蛛人').vi.startsWith('Spider Man'), engine.translate('蜘蛛人').vi);
// regression guard bug trọng tài Names-vs-VP (Names có 能量=Energon, phải nhường VP 负能量)
check('Names khong cat vu VP dai hon (负能量)', engine.translate('负能量').vi === 'Phụ năng lượng', engine.translate('负能量').vi);
// firstMeaning nhảy qua candidate rỗng (dict gộp có 着="/lấy/mắng")
check('firstMeaning bo qua candidate rong (着, engine riêng firstMeaning=true)',
  mkOvEngine(new Map(), { firstMeaning: true }).translate('她').vi === '她'   // sanity
    ? createEngine({ vp: new Map([['着', '/lấy/mắng']]), pa: new Map(), names: new Map(), t2s: new Map(), overrides: new Map() }, { firstMeaning: true }).translate('着').vi === 'Lấy'
    : false);
check('firstMeaning on bo candidate rong (着 -> Lấy)', engine.translate('着').vi === 'Lấy', engine.translate('着').vi);
// dict gộp giữ được mục tốt của truyencuatui mà ldhieu thiếu
check('dict gộp giữ mục truyencuatui (和地球相似)', engine.translate('和地球相似').vi === 'Tương tự với địa cầu', engine.translate('和地球相似').vi);
check('dict gộp dùng order ldhieu (一款)', engine.translate('一款').vi.startsWith('Một cái'), engine.translate('一款').vi);
// thứ tự lớp: user override > supplement (test mini-engine, không nạp lại 36MB)
const mkSupEngine = (overrides, supplement) => createEngine(
  { vp: new Map([['明白了', 'đã minh bạch/hiểu']]), pa: new Map(), t2s: new Map(), overrides, supplement }, {});
check('user override vẫn thắng supplement', mkSupEngine(new Map([['明白了', 'hiểu thật rồi']]), new Map([['明白了', 'hiểu rồi']])).translate('明白了').vi === 'Hiểu thật rồi');
check('supplement thắng dict gốc', mkSupEngine(new Map(), new Map([['明白了', 'hiểu rồi']])).translate('明白了').vi === 'Hiểu rồi');

section('4. Tong hop ca chapter (ty le phu cum tu)');
function paragraphsFromHtml(file, pick) {
  let html = fs.readFileSync(path.join(root, 'fixtures', file), 'utf8');
  const m = pick && html.match(pick);
  if (m) html = m[1];
  html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return html.replace(/&emsp;|&nbsp;|&#\d+;/g, '').replace(/&amp;/g, '&')
    .split(/\n+/).map(l => l.replace(/\s+/g, ' ').trim())
    .filter(l => /[㐀-䶿一-鿿]/.test(l) && l.length > 15);
}
const SRC = [
  { name: 'uukanshu', file: 'uukanshu_chap1234.html', pick: /class="[^"]*readcotent[^"]*"([\s\S]*?)<\/div>/, minCover: 0.8 },
  { name: 'piaotia', file: 'piaotia_chap1_utf8.html', pick: /<div class="toplink"[\s\S]*?<\/div>([\s\S]*?)将本书加入书架/, minCover: 0.8 }
];
for (const src of SRC) {
  const paras = paragraphsFromHtml(src.file, src.pick);
  let han = 0, phrase = 0;
  const tRun = Date.now();
  for (const p of paras) { const r = engine.translate(p); han += r.stats.hanChars; phrase += r.stats.phraseChars; }
  const ms = Date.now() - tRun;
  const cover = han ? phrase / han : 0;
  check(src.name + ': >=2 chu/thu van bao phu >= ' + (src.minCover * 100) + '%', cover >= src.minCover, (cover * 100).toFixed(1) + '% tren ' + han + ' ky tu');
  check(src.name + ': dich ca chapter < 3 giay', ms < 3000, ms + 'ms');
}

// ---------------------------------------------------------------- 5. DOM
if (!fast) {
  section('5. End-to-end lop DOM (content.js + jsdom)');
  const { JSDOM } = await import('jsdom');
  const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/;
  const HAN_G = /[㐀-䶿一-鿿豈-﫿]/g;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'OPTION', 'TITLE', 'IFRAME', 'TEMPLATE']);
  const contentSrc = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

  const CASES = [
    { name: 'uukanshu', file: 'uukanshu_chap1234.html', url: 'https://uukanshu.cc/book/21897/16209308.html', sel: '.readcotent' },
    { name: 'piaotia', file: 'piaotia_chap1_utf8.html', url: 'https://www.piaotia.com/html/16/16728/13058667.html', sel: null }
  ];

  for (const c of CASES) {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'fixtures', c.file), 'utf8'), { url: c.url, runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    const NF = window.NodeFilter;
    window.chrome = {
      runtime: {
        lastError: null,
        onMessage: { addListener(fn) { window.__vpOnMessage = fn; } },
        sendMessage: (msg, cb) => setTimeout(() => {
          if (msg.type === 'vp:translate') cb({ ok: true, results: msg.texts.map(t => engine.translate(t).vi) });
          else if (msg.type === 'vp:get-settings') cb({
            ok: true, viaServiceWorker: true,
            settings: { mode: 'vi', firstMeaning: true }, hostState: {},
            siteSelectors: { 'uukanshu.cc': '.readcotent, #content, article', 'piaotia.com': '#content, .content, td.tbd, #booktext' }
          });
          else cb({ ok: true });
        }, 0)
      }
    };
    const filter = {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName) || p.closest('.vp-orig')) return NF.FILTER_SKIP;
        return NF.FILTER_ACCEPT;
      }
    };
    const scopeOf = () => (c.sel ? window.document.querySelector(c.sel) : window.document.body);
    const hanOf = el => {
      if (!el) return 0;
      let t = 0;
      const w = window.document.createTreeWalker(el, NF.SHOW_TEXT, filter);
      for (let n = w.nextNode(); n; n = w.nextNode()) t += ((n.nodeValue || '').match(HAN_G) || []).length;
      return t;
    };

    const before = { page: hanOf(window.document.body), container: hanOf(scopeOf()), br: window.document.querySelectorAll('br').length, kids: window.document.body.childNodes.length };
    window.eval(contentSrc);

    const tRun = Date.now();
    let last = -1;
    while (Date.now() - tRun < 20000) {
      await new Promise(r => setTimeout(r, 100));
      const now = hanOf(scopeOf());
      if (now === last) break;
      last = now;
    }
    const afterContainer = hanOf(scopeOf());

    check(c.name + ': vung noi dung duoc convert hoan toan', before.container > 300 && afterContainer <= Math.ceil(before.container * 0.02), before.container + ' -> ' + afterContainer + ' chu Han (' + (Date.now() - tRun) + 'ms)');
    check(c.name + ': ca trang (ca menu/header/footer) gan sach chu Han', hanOf(window.document.body) / before.page < 0.02, hanOf(window.document.body) + '/' + before.page);
    check(c.name + ': khong pha markup (<br>, so con/body)', window.document.querySelectorAll('br').length === before.br && window.document.body.childNodes.length === before.kids,
      'br ' + window.document.querySelectorAll('br').length + '/' + before.br + ', kids ' + window.document.body.childNodes.length + '/' + before.kids);
    check(c.name + ': ket qua co chu cai Tieng Viet', /[a-zA-Zàáâãèéêìíòóôõùúýăđơư]/.test(scopeOf().textContent));

    // restore qua vp:command
    await new Promise(resolve => window.__vpOnMessage({ type: 'vp:command', action: 'disable' }, {}, resolve));
    check(c.name + ': restore tra lai dung nguyen van', hanOf(window.document.body) === before.page, hanOf(window.document.body) + ' (mong ' + before.page + ')');

    window.close();
  }

  // che do song ngu
  const domHan = new JSDOM(fs.readFileSync(path.join(root, 'fixtures', CASES[0].file), 'utf8'), { url: CASES[0].url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w2 = domHan.window;
  w2.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
      sendMessage: (msg, cb) => setTimeout(() => {
        if (msg.type === 'vp:translate') cb({ ok: true, results: msg.texts.map(t => engine.translate(t).vi) });
        else if (msg.type === 'vp:get-settings') cb({
          ok: true, viaServiceWorker: true,
          settings: { mode: 'vi-han', firstMeaning: true }, hostState: {},
          siteSelectors: { 'uukanshu.cc': '.readcotent, #content, article', 'piaotia.com': '#content, .content, td.tbd, #booktext' }
        });
        else cb({ ok: true });
      }, 0)
    }
  };
  w2.eval(contentSrc);
  // Chờ DOM ỔN ĐỊNH rồi mới đếm (đếm ngay khi span đầu xuất hiện là race: dict lớn hơn
  // làm nhịp batch chậm đi và số span đếm được phụ thuộc thời điểm, không phụ thuộc kết quả).
  const tHan = Date.now();
  let spanCount = 0, stableTicks = 0;
  while (Date.now() - tHan < 20000) {
    await new Promise(r => setTimeout(r, 100));
    const now = w2.document.querySelectorAll('.vp-orig').length;
    if (now > 0 && now === spanCount) stableTicks++; else stableTicks = 0;
    spanCount = now;
    if (spanCount > 0 && stableTicks >= 5) break;   // 500ms không mọc thêm span nào
  }
  check('vi-han: chen span .vp-orig chua nguyen van', spanCount >= 100, spanCount + ' span');
  check('vi-han: span nguyen van that su con chu Han', HAN_RE.test(w2.document.querySelector('.vp-orig') ? w2.document.querySelector('.vp-orig').textContent : ''));
  domHan.window.close();
}

// ---------------------------------------------------------------- 6. Goi package
section('6. Cau truc goi MV3 (Firefox)');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
check('manifest_version = 3', manifest.manifest_version === 3);
// Firefox khong biet quyen "offscreen" (API do Chrome/Edge them) — neu de trong permissions
// thi AMO/web-ext lint huy/tu choi goi. Engine page di qua background.scripts + iframe (xem
// background.js), khong can quyen do nua.
check('quyen: storage + unlimitedStorage + scripting (khong kem offscreen: Firefox/AMO tu choi coi la khong ton tai)',
  ['storage', 'unlimitedStorage', 'scripting'].every(p => manifest.permissions.includes(p))
    && !manifest.permissions.includes('offscreen'), manifest.permissions.join(','));
check('optional_host_permissions mo luong them site dong (khong phai quyen cung)',
  (manifest.optional_host_permissions || []).includes('*://*/*') && !manifest.permissions.includes('*://*/*'),
  JSON.stringify(manifest.optional_host_permissions));
check('khong dung <all_urls>', !manifest.host_permissions.includes('<all_urls>'));
check('host_permissions == matches cua content_scripts', JSON.stringify(manifest.host_permissions) === JSON.stringify(manifest.content_scripts[0].matches));

// Dual background (MDN background): Firefox chi dung service_worker KHONG load duoc gi
// (BCD: background.service_worker = false tren Firefox) -> phai co background.scripts cho
// event page; Chrome 121+ bo qua background.scripts trong MV3. Can ca hai.
check('background dual: service_worker (Chrome) + scripts (Firefox)',
  manifest.background && manifest.background.service_worker === 'background.js'
    && Array.isArray(manifest.background.scripts) && manifest.background.scripts.includes('background.js'),
  JSON.stringify(manifest.background));
check('browser_specific_settings.gecko: id + strict_min_version >= 140 + khai khong thu thap du lieu',
  manifest.browser_specific_settings && manifest.browser_specific_settings.gecko
    && /^[\w.-]+@[\w.-]+$/.test(manifest.browser_specific_settings.gecko.id || '')
    && Number(String(manifest.browser_specific_settings.gecko.strict_min_version || 0).split('.')[0]) >= 140
    && JSON.stringify((manifest.browser_specific_settings.gecko.data_collection_permissions || {}).required) === '["none"]'
    && manifest.browser_specific_settings.gecko_android
    && Number(String(manifest.browser_specific_settings.gecko_android.strict_min_version || 0).split('.')[0]) >= 142,
  JSON.stringify(manifest.browser_specific_settings));

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  ...manifest.content_scripts[0].js,
  ...manifest.content_scripts[0].css,
  'offscreen.html', 'offscreen.js'
];
for (const f of referenced) check('ton tai ' + f, fs.existsSync(path.join(root, f)));

// Thuong hien TuiRead (doi ten 2026-11-09): ten goi + icon phai that, khong chi la chu trong README.
// Ten va mo ta dung chuoi nguoi dung chot (2026-11-09 buoi 2): khong kem phan giai thich.
check('manifest mang ten TuiRead', manifest.name === 'TuiRead' && manifest.action.default_title === 'TuiRead', manifest.name);
check('mo ta ngan gon dung chuoi chot', manifest.description === 'Đọc raw truyện tiếng Trung', manifest.description);
check('icon sinh tu logo goc nguoi dung cap (RGBA, goc trong suot)',
  fs.existsSync(path.join(root, 'icons/tuiread_logo.png'))
    && fs.readFileSync(path.join(root, 'icons/icon128.png'))[25] === 6);
const pngSize = f => {
  const b = fs.readFileSync(path.join(root, f));
  return b.length > 24 && b.toString('ascii', 1, 4) === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
};
for (const [size, file] of Object.entries({ ...(manifest.icons || {}), ...(manifest.action.default_icon || {}) })) {
  const dim = fs.existsSync(path.join(root, file)) ? pngSize(file) : null;
  check('icon ' + size + 'px ton tai va dung kich thuoc', !!dim && dim[0] === Number(size) && dim[1] === Number(size), file + ' ' + JSON.stringify(dim));
}
check('popup + options mang wordmark TuiRead + icon that',
  /Tui<span>Read<\/span>/.test(read('popup.html')) && /Tui<span>Read<\/span>/.test(read('options.html'))
    && /icons\/icon32\.png/.test(read('popup.html')) && /icons\/icon48\.png/.test(read('options.html')));
check('khong con ten cu "VietPhrase Reader" trong manifest/popup/options',
  !/VietPhrase Reader/.test(read('manifest.json') + read('popup.html') + read('options.html')));
check('options co o nhap URL + nut Tai tu URL (giu nguyen Nhap file)',
  /id="ovUrl"/.test(read('options.html')) && /id="ovUrlLoad"/.test(read('options.html'))
    && /id="ovImport"/.test(read('options.html')) && /ovUrlLoad'\)\.addEventListener\('click'/.test(read('options.js')));
check('tai URL co fallback xin quyen mien khi server kin CORS',
  /permissions\.contains/.test(read('options.js')) && /permissions[\s\S]{0,30}request/.test(read('options.js'))
    && /callP\(chrome\.permissions, 'request'/.test(read('options.js')));
check('URL tai thanh cong duoc nho lai cho lan sau',
  /storeSet\(\{ ovUrl: url\.href \}\)/.test(read('options.js')) && /loadUrlPref\(\)/.test(read('options.js')));

// background + engine page phai tham chieu dung duong dan that
const bg = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
check('background tro toi offscreen.html (iframe engine page)', /OFFSCREEN_PATH\s*=\s*'offscreen\.html'/.test(bg));
check('iframe engine page chi tro den trang extension (getURL), khong URL ben ngoai',
  /createElement\(\s*'iframe'[\s\S]{0,600}?getURL\(\s*OFFSCREEN_PATH\s*\)/.test(bg)
    && !/createElement\(\s*'iframe'[\s\S]{0,600}?(src|url)\s*[:=]\s*(['"`])(https?:|javascript:|data:)/i.test(bg));
const offHtml = fs.readFileSync(path.join(root, 'offscreen.html'), 'utf8');
check('offscreen.html nap offscreen.js kiieu module', /type="module"[^>]*offscreen\.js/.test(offHtml) || /offscreen\.js"[^>]*type="module/.test(offHtml));
for (const f of Object.values(FILES)) {
  check('dict/' + f + ' co trong goi', fs.existsSync(path.join(root, 'dict', f)) && fs.statSync(path.join(root, 'dict', f)).size > 1000);
}
// content script khong duoc la ES module (Chrome content_scripts khong ho tro import o doan nay)
check('content.js khong dung import/export', !/^\s*(import|export)\s/m.test(fs.readFileSync(path.join(root, 'content.js'), 'utf8')));
// Font (fonts/sf-pro/*.otf) PHẢI nằm trong web_accessible_resources để FontFace API của
// content script tải được từ trang (CSS content script resolve URL tương đối theo trang —
// bị chặn). Chỉ mở đúng thư mục font cho đúng site; engine/ và dict/ vẫn KHÔNG được lộ.
check('engine/ khong thuoc web_accessible_resources (chi offscreen doc duoc)',
  !(manifest.web_accessible_resources || []).some(r => (r.resources || []).some(p => p.startsWith('engine') || p.startsWith('dict'))));

// Duyen het cac loai tin nhan vp:* duoc gui -> phai co noi xu ly.
// vp:command di qua chrome.tabs.sendMessage (content script tra loi); cac loai khac qua
// runtime. Senders KHONG gom background: no la nguoi TIEU THU vp:get-settings/vp:set/...
// (tu popup/options/content) va push vp:settings/vp:overrides ra cho engine — offscreen.js
// (nguoi nhan do) da tinh du o handlerFiles duoi day.
const senders = ['content.js', 'popup.js', 'options.js'];
const handlerFiles = ['background.js', 'offscreen.js', 'content.js'];
const sent = new Set();
for (const f of senders) for (const m of read(f).matchAll(/type:\s*'(vp:[a-z-]+)'/g)) sent.add(m[1]);
const handled = new Map();
for (const f of handlerFiles) for (const m of read(f).matchAll(/msg\.type\s*[!=]==\s*'(vp:[a-z-]+)'/g)) {
  if (!handled.has(m[1])) handled.set(m[1], []);
  handled.get(m[1]).push(f);
}
for (const type of sent) check('co noi xu ly tin nhan ' + type, handled.has(type), 'gui tu ' + senders.join('/') + ' | xu ly o ' + (handled.get(type) || []).join(','));
check('vp:ensure + vp:status + vp:translate + vp:rebuild + vp:reload + vp:tokens deu qua runtime',
  ['vp:ensure', 'vp:status', 'vp:translate', 'vp:rebuild', 'vp:reload', 'vp:tokens'].every(t => handled.has(t)),
  [...handled.keys()].join(','));
// Lenh background GUI cho engine (push settings/override moi) phai co nguoi nhan la offscreen.js.
check('background push vp:settings + vp:overrides -> offscreen.js nhan',
  ['vp:settings', 'vp:overrides'].every(t => read('background.js').includes("type: '" + t + "'"))
    && ['vp:settings', 'vp:overrides'].every(t => handled.has(t) && handled.get(t).includes('offscreen.js')),
  JSON.stringify({ vp_settings: handled.get('vp:settings'), vp_overrides: handled.get('vp:overrides') }));
// Ping keepalive: content script giu port 'vp:keepalive' mo de background/event page khong
// unload khi user dang doc (MDN Background_scripts); background phai nhan port do.
check('content.js mo port keepalive vp:keepalive', /connect\(\s*\{\s*name:\s*'vp:keepalive'\s*\}/.test(read('content.js')));
check('background.js lang nghe port vp:keepalive + tra pong', /onConnect\.addListener/.test(bg) && /'vp:keepalive'/.test(bg) && /'pong'/.test(bg));

// ---------------------------------------------------------------- 6a. Thước đo: bộ lột comment
// Mục 6b và `npm run audit` đều quét trên code đã lột comment. Bản lột bằng regex cũ
// gặp `// dict/*.txt` là tưởng mở block comment, nuốt ~1.700 ký tự code thật của
// options.js (gồm dòng chrome.storage.onChanged) -> cả hai PASS GIẢ. Nên chính bộ lột
// phải được kiểm trước khi tin kết quả của nó.
section('6a. Bo lot comment: khuon duoc tin de quet code that');
const STRIP_CASES = [
  ['comment // chứa /*', '// dict/*.txt giữ nguyên\nchrome.storage.onChanged.addListener(f);', 'chrome.storage.onChanged'],
  ['chuỗi chứa /* và //', 'const u = "https://x.dev/*không phải comment*/";\nkeep();', 'https://x.dev/*không phải comment*/'],
  ['regex chứa \\/\\/', 'const re = /https?:\\/\\//g;\nkeep2();', 'keep2();'],
  ['regex chứa / trong class', 'const re2 = /[/]x/g; q();', 'q();'],
  ['block comment nhiều dòng', 'a /* block\nspan */ b();', 'b();'],
  ['template lồng + comment trong ${}', 'const t = `a${ /* c */ x + `inner${y}` }b`;\nz();', 'z();'],
  ['chuỗi có escape nháy', "const s = 'it\\'s /* fine */';\nw();", 'w();'],
  ['phép chia không phải regex', 'x / y / z; // trailing /*\nr();', 'r();']
];
for (const [label, src, want] of STRIP_CASES) {
  check('lot comment: ' + label, stripComments(src).includes(want), JSON.stringify(stripComments(src).trim().slice(0, 70)));
}
// Code đã lột phải còn là JS hợp lệ: lột nuốt mất code thật thì thường vỡ cú pháp.
const CONTEXT_FILES = ['background.js', 'offscreen.js', 'content.js', 'popup.js', 'options.js', 'db.js'];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuiread-strip-'));
for (const f of CONTEXT_FILES) {
  const tmp = path.join(tmpDir, f.replace(/\.js$/, '.mjs'));
  fs.writeFileSync(tmp, stripComments(read(f)));
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  check('code ' + f + ' sau khi lot comment van parse duoc', r.status === 0, (r.stderr || '').split('\n').slice(0, 3).join(' ').slice(0, 160));
}
fs.rmSync(tmpDir, { recursive: true, force: true });

// ---------------------------------------------------------------- 6b. Ai duoc cham chrome.storage
// Edge 155 khong cap chrome.storage cho offscreen document (do bang probe /tmp/vp-probe).
// Nen bat buoc: chi background.js duoc viet doc; ai khong phai SW thi phai hoi bang tin nhan.
// Doi tuong kiem tra la PHAN CODE (da cat comment), vi comment co quyen noi ve chrome.storage.
section('6b. Luu tru: chi background (event page/SW) duoc cham chrome.storage');
const STORAGE_RE = /chrome\.storage\s*\./;
for (const f of ['offscreen.js', 'content.js', 'popup.js', 'options.js', 'db.js']) {
  check(f + ' khong cham chrome.storage trong code', !STORAGE_RE.test(codeOf(f)), (codeOf(f).match(/.{0,50}chrome\.storage\s*\..{0,20}/) || [])[0]);
}
check('background.js XU LY vp:get-settings + vp:set + vp:status-push',
  ['vp:get-settings', 'vp:set', 'vp:status-push'].every(t => new RegExp("msg\\.type === '" + t + "'").test(bg)),
  (bg.match(/msg\.type === '(vp:[a-z-]+)'/g) || []).join(','));
check('background.js la noi DUY NHAT viet chrome.storage', STORAGE_RE.test(codeOf('background.js')));
check('options dong bo ban va qua tin nhan SW phat (khong tu nghe storage)',
  /vp:store-changed/.test(codeOf('options.js')) && /vp:store-changed/.test(codeOf('background.js'))
    && /storage\.onChanged/.test(codeOf('background.js')));
check('moi noi dung/luu deu hoi SW qua vp:get-settings',
  ['content.js', 'popup.js', 'options.js'].every(f => /vp:get-settings/.test(read(f))));

// Selector khu vực truyện phải là CẤU HÌNH (storage qua SW), không code cứng trong content.js.
// uukanshu.cc=.readcotent chỉ được phép nằm ở background (giá trị mặc định seed cho config).
check('content.js khong code cung selector site', !/readcotent|td\.tbd/.test(codeOf('content.js')),
  (codeOf('content.js').match(/.{0,40}(?:readcotent|td\.tbd).{0,20}/) || ['?'])[0]);
check('background giu selector mac dinh (seed cho 2 site goc)',
  /DEFAULT_SITE_SELECTORS\s*=\s*\{[^}]*uukanshu\.cc/.test(codeOf('background.js')));
check('popup co luong them site (permissions.request + vp:site-add)',
  /callP\(chrome\.permissions, 'request'/.test(codeOf('popup.js')) && /vp:site-add/.test(codeOf('popup.js')));
check('background xu ly vp:site-add + vp:site-remove + vp:sites (registerContentScripts)',
  ['vp:site-add', 'vp:site-remove', 'vp:sites'].every(t => new RegExp("msg\\.type === '" + t + "'").test(bg))
    && /registerContentScripts/.test(codeOf('background.js')));

// Khong duoc nap 6 file tu dien dong nghit bang Promise.all (nguyen nhan treo offscreen)
check('offscreen nap dict tuan tu (khong Promise.all 6 fetch)', !/Promise\.all\(\s*\[[\s\S]{0,200}readDict|Promise\.all\([^)]*fetchDict/.test(read('offscreen.js')));
check('offscreen co timeout cho fetch dict', /AbortController/.test(read('offscreen.js')) && /controller\.abort\(\)/.test(read('offscreen.js')));
check('offscreen bao tien do tung file (popup nhin thay ket o dau)', /progress:\s*\(i \/ total\)/.test(read('offscreen.js')) && /progress:\s*\(i \+ 0\.5\) \/ total/.test(read('offscreen.js')));

// ---------------------------------------------------------------- 7. Chinh file offscreen.js
if (!fast) {
  section('7. offscreen.js (engine page) nap tu dien + luu tru qua background');

  // Gia lap DUNG rang buoc cua Edge 155 da do bang probe:
  //   offscreen document KHONG co chrome.storage / tabs / offscreen / runtime.getManifest,
  //   chi co runtime.sendMessage + getURL + onMessage. Nen moi thu luu tru phai di qua background.
  const listeners = [];
  const kv = { settings: { mode: 'vi', firstMeaning: true, useRules: true, useNames: true } };
  let swUp = true;                       // tai thi offscreen goi duoc background hay khong

  globalThis.chrome = {
    runtime: {
      id: 'check-fake',
      getURL: p => 'chrome-extension://check-fake/' + p,
      onMessage: { addListener: fn => listeners.push(fn) },
      sendMessage: (msg, cb) => setTimeout(() => {
        if (!swUp) { if (cb) cb(undefined); return; }
        if (msg.type === 'vp:get-settings') { if (cb) cb({ ok: true, viaServiceWorker: true, settings: kv.settings, hostState: kv.hostState || {} }); return; }
        if (msg.type === 'vp:status-push') { kv.engineStatus = msg.status; if (cb) cb({ ok: true }); return; }
        if (cb) cb({ ok: true });
      }, 0)
    }
  };
  check('offscreen.khong co chrome.storage trong bo cai nay', globalThis.chrome.storage === undefined);

  globalThis.fetch = async url => {
    const abs = path.join(root, String(url).replace(/^chrome-extension:\/\/check-fake\//, ''));
    if (!fs.existsSync(abs)) return { ok: false, status: 404 };
    const buf = fs.readFileSync(abs);
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  const ask = msg => new Promise(resolve => { for (const fn of listeners) if (fn(msg, {}, resolve) === true) return; });

  await import(pathToFileURL(path.join(root, 'offscreen.js')).href);

  let st = null;
  const tPoll = Date.now();
  while (Date.now() - tPoll < 60000) {
    st = await ask({ type: 'vp:status' });
    if (st && (st.state === 'ready' || st.state === 'error')) break;
    await new Promise(r => setTimeout(r, 150));
  }
  check('offscreen dat state=ready khi khong co chrome.storage', st && st.state === 'ready', st ? st.state + ' / ' + st.message : 'khong tra loi');
  check('offscreen bao cao dung so muc tu', st && st.info && st.info.vp === engine.info.vp && st.info.pa === engine.info.pa, st && JSON.stringify(st.info));
  check('offscreen lay settings TU background (khong tu doc storage)', st && st.settingsSource === 'background', st && st.settingsSource);
  // Push chay qua setTimeout cua mock nen phai CHO: poll vong tren thay ready trong khi
  // push "ready" van dang doi trong hang doi timer (createEngine chan dong bo ~2s truoc do).
  let kvStatus = null;
  const tKv = Date.now();
  while (Date.now() - tKv < 15000) {
    kvStatus = kv.engineStatus || null;
    if (kvStatus && kvStatus.state === 'ready') break;
    await new Promise(r => setTimeout(r, 100));
  }
  check('engineStatus duoc day sang storage qua background', kvStatus && kvStatus.state === 'ready', kvStatus && kvStatus.state);
  const tr = await ask({ type: 'vp:translate', texts: ['這是系統', '第三章'] });
  check('vp:translate qua offscreen dung ket qua engine', tr && tr.ok && tr.results[0] === 'Đây là hệ thống' && tr.results[1] === 'Chương 3:', tr && JSON.stringify(tr.results));
  const rb = await ask({ type: 'vp:rebuild', reason: 'check' });
  check('vp:rebuild chay duoc lan 2 (khong chai hang)', rb && rb.ok && rb.status.state === 'ready');

  // Regression 1: chrome.storage === undefined trong offscreen (loi that tren Edge cua user).
  // Truong day setStatus() goi chrome.storage.local -> TypeError dong bo -> .catch() khong cuu ->
  // boot chet TRUOC khi kip doc cai tu dien nao, popup dinh mai o "Đang đọc từ điển".
  // Regression 2: background bi MV3 kill / khong tra loi -> offscreen van phai boot duoc.
  listeners.length = 0;
  swUp = false;
  await import(pathToFileURL(path.join(root, 'offscreen.js')).href + '?sw-down');
  const ask2 = msg => new Promise(resolve => { for (const fn of listeners) if (fn(msg, {}, resolve) === true) return; });
  let st2 = null;
  const t2 = Date.now();
  while (Date.now() - t2 < 60000) {
    st2 = await ask2({ type: 'vp:status' });
    if (st2 && (st2.state === 'ready' || st2.state === 'error')) break;
    await new Promise(r => setTimeout(r, 150));
  }
  check('offscreen van boot khi background khong tra loi', st2 && st2.state === 'ready', st2 ? st2.state + ' / ' + st2.message : 'khong tra loi');
  const tr2 = await ask2({ type: 'vp:translate', texts: ['這是系統'] });
  check('dich duoc ma khong can chrome.storage', tr2 && tr2.ok && (tr2.results[0] === 'Đây là hệ thống' || tr2.results[0].startsWith('Đây là hệ thống/')), tr2 && JSON.stringify(tr2.results));
  check('canh bao ro le khi mat nguon settings', st2 && /background/i.test(st2.warning || ''), st2 && st2.warning);
  check('khong treo vi thieu storage: co timeout khi goi background', /setTimeout\(\(\) => finish\(null\)/.test(read('offscreen.js')));
  swUp = true;
}

// ---------------------------------------------------------------- 8. background.js (Firefox): iframe + keepalive
// Section 7 test ENGINE (offscreen.js). Section nay test NGUOC LAI background.js theo kieu
// Firefox that su: khong chrome.offscreen, khong document -> vp:ensure phai TRA LOI OK ma van
// khong tao duoc engine page (guong quan ly loi), vp:set/override-set ghi duoc storage (callP
// callback), port keepalive ping/pong, va storage.onChanged broadcast vp:store-changed.
if (!fast) {
  section('8. background.js tren Firefox (khong offscreen API): luu tru + keepalive');
  const listenersBg = [];
  const onChangeBg = [];
  const mockStore = { settings: { mode: 'vi' } };
  const vmChrome = {
    runtime: {
      id: 'check-bg',
      getURL: p => 'moz-extension://check-bg/' + p,
      getManifest: () => ({
        permissions: ['storage', 'unlimitedStorage', 'scripting'],
        content_scripts: [{ matches: ['*://uukanshu.cc/*', '*://*.uukanshu.cc/*', '*://www.piaotia.com/*', '*://piaotia.com/*'] }]
      }),
      lastError: null,
      onMessage: { addListener: fn => listenersBg.push(fn) },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onConnect: { addListener() {} },
      // runtime.sendMessage that su: den TAT CA context khac (test lang nghe vp:store-changed),
      // roi callback tra loi (khong ai tra loi = ack {ok:true}). Khong giong Chrome: khong phai
      // chi goi cb ma khong gianh cho listener — neu khong, broadcast vp:store-changed mat.
      sendMessage: (msg, cb) => {
        let responded = false;
        const respond = resp => { if (!responded) { responded = true; if (cb) cb(resp); } };
        for (const fn of listenersBg) {
          try { fn(msg, { id: 'bg-sender' }, respond); } catch { /* listener loi bo qua */ }
        }
        if (!responded) respond({ ok: true });
      }
    },
    storage: {
      local: {
        get: keys => Promise.resolve(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, mockStore[k]]))),
        set: obj => { Object.assign(mockStore, obj); return Promise.resolve(); }
      },
      onChanged: { addListener: fn => onChangeBg.push(fn) }
    },
    scripting: {
      getRegisteredContentScripts: () => Promise.resolve([]),
      registerContentScripts: () => Promise.resolve(),
      unregisterContentScripts: () => Promise.resolve()
    },
    permissions: { remove: () => Promise.resolve(), request: () => Promise.resolve(true) }
  };
  vm.runInNewContext(stripComments(read('background.js')), {
    chrome: vmChrome, console, setTimeout, clearTimeout, Promise
  });

  const askBg = msg => new Promise(resolve => {
    let answered = false;
    const respond = r => { if (!answered) { answered = true; resolve(r); } };
    let asyncWait = 0;
    for (const fn of listenersBg) if (fn(msg, { id: 'check-bg' }, respond) === true) asyncWait++;
    if (!asyncWait && !answered) setTimeout(() => respond(undefined), 0);
    setTimeout(() => respond({ __timeout: true }), 5000);
  });

  const ensured = await askBg({ type: 'vp:ensure' });
  check('vp:ensure tra loi OK ma van bao khong tao duoc engine page (khong cam/sai loi)',
    ensured && ensured.ok === false && ensured.error && /không tạo được engine page|khong tao duoc engine page/.test(ensured.error),
    JSON.stringify(ensured));

  const got = await askBg({ type: 'vp:get-settings' });
  check('vp:get-settings tra settings + siteSelectors mac dinh 2 site goc',
    got && got.ok && got.settings && got.siteSelectors && /\.readcotent/.test(got.siteSelectors['uukanshu.cc'])
      && /td\.tbd/.test(got.siteSelectors['piaotia.com']), JSON.stringify(got && got.siteSelectors));

  const setResp = await askBg({ type: 'vp:set', patch: { settings: { mode: 'vi-han' } } });
  check('vp:set ghi vao chrome.storage qua callP (mac dinh Firefox khong tra promise)',
    setResp && setResp.ok && mockStore.settings.mode === 'vi-han', JSON.stringify({ setResp, mode: mockStore.settings.mode }));

  const ov = await askBg({ type: 'vp:override-set', han: '这是系统', vi: 'Bản vá test' });
  check('vp:override-set luu override + bump version + push sang engine',
    ov && ov.ok && mockStore.overrides && mockStore.overrides['这是系统'] === 'Bản vá test' && ov.version >= 1,
    JSON.stringify({ ov, overrides: mockStore.overrides }));

  // storage.onChanged (background la noi duy nghe) -> background broadcast vp:store-changed cho options.
  const seenStore = [];
  listenersBg.push(msg => { if (msg && msg.type === 'vp:store-changed') seenStore.push(msg); return false; });
  onChangeBg.forEach(fn => fn({ overrides: { oldValue: {}, newValue: { 新: 'mới' } } }, 'local'));
  await new Promise(r => setTimeout(r, 50));
  check('storage.onChanged -> background phat vp:store-changed cho options dang mo',
    seenStore.length >= 1, JSON.stringify(seenStore[0] || null));

  onChangeBg.forEach(fn => fn({ overrides: { oldValue: { 新: 'mới' }, newValue: { 更新: 'cập nhật' } } }, 'local'));
  await new Promise(r => setTimeout(r, 50));
  check('broadcast lan 2 (override doi lan 2 van phat)', seenStore.length >= 2, seenStore.length);

  // Sua loi TDZ da gap: section 6a su dung codeOf truoc khi no duoc khai bao.
  let tdzCaught = null;
  try { void codeOf; } catch (e) { tdzCaught = String(e); }
  check('codeOf duoc khai bao TRUOC khi section 6a dung (khong TDZ ReferenceError)', tdzCaught === null, tdzCaught);
}

// ---------------------------------------------------------------- Ket
console.log('\n' + '='.repeat(60));
if (failures.length) {
  console.log('THAT BAI: ' + passed + ' ok / ' + failures.length + ' fail');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('TAT CA PASS: ' + passed + ' kiem tra' + (fast ? ' (--fast, bo qua DOM)' : '') + ' | nap engine ' + loadMs + 'ms');
