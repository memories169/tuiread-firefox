// Pipeline convert Trung -> Việt: punct -> 繁→簡 -> rule -> name -> VP -> PA -> ghép/tua hoa.
// Khong dong DOM o day; chay duoc trong Node lan trong trinh duyet.

import { toSimplified } from './t2s.js';
import { firstMeaning, maxKeyLength } from './dict.js';

const PUNCT_MAP = {
  '，': ',', '、': ',', '。': '.', '．': '.', '？': '?', '！': '!',
  '；': ';', '：': ':', '（': '(', '）': ')', '【': '[', '】': ']',
  '“': '"', '”': '"', '「': '"', '」': '"', '『': '"', '』': '"',
  '‘': "'", '’': "'", '—': '-', '－': '-', '…': '...'
};
const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/;
const LETTER_RE = /[\p{L}]/u;
const OPEN = new Set('([「《〈"\'');
const CLOSE_NO_SPACE = new Set('.,!?:;)]}》〉"\'');

export function normalizePunct(text) {
  let out = '';
  for (const ch of text) {
    if (PUNCT_MAP[ch] !== undefined) out += PUNCT_MAP[ch];
    else if (ch === '　' || ch === '\xa0') out += ' ';
    else out += ch;
  }
  return out;
}

function needsSpace(a, b) {
  if (!a || !b) return false;
  if (OPEN.has(a)) return false;
  if (CLOSE_NO_SPACE.has(b)) return false;
  if (a === '.' || a === '!' || a === '?' || a === ',' || a === ';' || a === ':') return true;
  if (a === '-' && b === '-') return false;
  const la = LETTER_RE.test(a), lb = LETTER_RE.test(b);
  const da = /[0-9]/.test(a), db = /[0-9]/.test(b);
  if ((la || da) && (lb || db)) return true;
  return false;
}

function autoUpperCase(text) {
  return text.replace(/(^|[.!?]\s+|\n+\s*)([a-zà-ỹả~])/g, (m, pre, ch) => pre + ch.toLocaleUpperCase('vi'));
}

export function createEngine(dicts, settings = {}) {
  const opt = {
    firstMeaning: true,
    separator: '/',
    useRules: true,
    useNames: true,
    skipParticles: false,
    ...settings
  };
  const { pa, vp, names, t2s } = dicts;
  const overrides = dicts.overrides && dicts.overrides.size ? dicts.overrides : null;
  const ovMax = overrides ? maxKeyLength(overrides) : 0;
  // Supplement dict: lớp bổ trợ gắn theo gói (sửa order/mục thiếu của dict cộng đồng),
  // thấp hơn override của user, cao hơn rule/Names/VP/PA.
  const supplement = dicts.supplement && dicts.supplement.size ? dicts.supplement : null;
  const supMax = supplement ? maxKeyLength(supplement) : 0;
  // Glossary RIÊNG theo từng truyện (F4): từ điển nhỏ user nhập cho một sách, THẮNG từ
  // điển gốc (VP/Names/rules) nhưng thua override toàn cục. Engine nhận dict "glossary"
  // theo bookKey của trang đang dịch (background/offscreen chọn lớp đúng).
  const glossary = dicts.glossary && dicts.glossary.size ? dicts.glossary : null;
  const glMax = glossary ? maxKeyLength(glossary) : 0;
  const ruleEngine = opt.useRules && dicts.rules ? dicts.rules : null;
  // MaxKeyLength tính sẵn từ lúc parse (offscreen gửi kèm): rebuild sau mỗi lần Lưu
  // không phải quét lại hơn 1 triệu key (~200ms + đỉnh cấp phát) nữa.
  const vpMax = dicts.vpMax || maxKeyLength(vp);
  const namesMax = names && names.size ? (dicts.namesMax || maxKeyLength(names)) : 0;
  const PARTICLES = new Set(['的', '了', '着', '著']);

  function vpAt(text, start) {
    const limit = Math.min(vpMax, text.length - start);
    for (let len = limit; len > 1; len--) {
      const key = text.substr(start, len);
      const value = vp.get(key);
      if (value !== undefined) return { key, value, len };
    }
    const one = vp.get(text[start]);
    if (one !== undefined) return { key: text[start], value: one, len: 1 };
    return null;
  }

  function longestVPLen(text, start) {
    const hit = vpAt(text, start);
    return hit ? hit.len : 0;
  }

  function nameAt(text, start) {
    if (!opt.useNames || !namesMax) return null;
    const limit = Math.min(namesMax, text.length - start);
    for (let len = limit; len > 1; len--) {
      const key = text.substr(start, len);
      const value = names.get(key);
      if (value !== undefined) return { key, value, len };
    }
    return null;
  }

  // Layer override (từ điển vá của user): tra TRƯỚC mọi tầng để ý của user luôn thắng
  // rule/Names/VP/PA. Key là chữ đã 繁→簡 vì matching chạy trên văn bản đã chuẩn hoá.
  function segmentOverrides(text) {
    if (!ovMax) return [{ kind: 'plain', text }];
    const out = [];
    let plainStart = 0, pos = 0;
    while (pos < text.length) {
      const limit = Math.min(ovMax, text.length - pos);
      let hit = null;
      for (let len = limit; len >= 1; len--) {
        const value = overrides.get(text.substr(pos, len));
        if (value !== undefined) { hit = { value, len }; break; }
      }
      if (hit) {
        if (plainStart < pos) out.push({ kind: 'plain', text: text.slice(plainStart, pos) });
        out.push({ kind: 'ov', text: hit.value, han: text.slice(pos, pos + hit.len) });
        pos += hit.len;
        plainStart = pos;
        continue;
      }
      pos++;
    }
    if (plainStart < text.length) out.push({ kind: 'plain', text: text.slice(plainStart) });
    return out;
  }

  // Layer glossary per-book (F4): tra NGAY SAU override toàn cục, TRƯỚC supplement/
  // rule/Names/VP/PA -> từ điển riêng của truyện thắng từ điển gốc.
  function segmentGlossary(text) {
    if (!glossary) return [{ kind: 'plain', text }];
    const out = [];
    let plainStart = 0, pos = 0;
    while (pos < text.length) {
      const limit = Math.min(glMax, text.length - pos);
      let hit = null;
      for (let len = limit; len >= 1; len--) {
        const value = glossary.get(text.substr(pos, len));
        if (value !== undefined) { hit = { value, len }; break; }
      }
      if (hit) {
        if (plainStart < pos) out.push({ kind: 'plain', text: text.slice(plainStart, pos) });
        out.push({ kind: 'gl', text: hit.value, han: text.slice(pos, pos + hit.len) });
        pos += hit.len;
        plainStart = pos;
        continue;
      }
      pos++;
    }
    if (plainStart < text.length) out.push({ kind: 'plain', text: text.slice(plainStart) });
    return out;
  }

  // Layer supplement (đi kèm gói): tra sau override của user, trước rule/Names/VP/PA.
  // Key là chữ đã 繁→簡 vì matching chạy trên văn bản đã chuẩn hoá.
  function segmentSupplement(text) {
    if (!supplement) return [{ kind: 'plain', text }];
    const out = [];
    let plainStart = 0, pos = 0;
    while (pos < text.length) {
      const limit = Math.min(supMax, text.length - pos);
      let hit = null;
      for (let len = limit; len >= 1; len--) {
        const value = supplement.get(text.substr(pos, len));
        if (value !== undefined) { hit = { value, len }; break; }
      }
      if (hit) {
        if (plainStart < pos) out.push({ kind: 'plain', text: text.slice(plainStart, pos) });
        out.push({ kind: 'sup', text: hit.value, han: text.slice(pos, pos + hit.len) });
        pos += hit.len;
        plainStart = pos;
        continue;
      }
      pos++;
    }
    if (plainStart < text.length) out.push({ kind: 'plain', text: text.slice(plainStart) });
    return out;
  }

  function segmentRules(text) {
    if (!ruleEngine) return [{ kind: 'plain', text }];
    const out = [];
    let plainStart = 0, pos = 0;
    while (pos < text.length) {
      const hit = ruleEngine.matchAt(text, pos);
      // Rule thường chỉ thắng VP khi DÀI hơn; rule mạnh ("!" đầu dòng trong rule.txt)
      // thắng cả khi HOÀ độ dài — dữ liệu 第X章 trong VP có ~15% mục sai số, rule tính
      // số chuẩn luôn đúng nên phải thắng khi hoà.
      if (hit && (hit.strong || longestVPLen(text, pos) < hit.end - pos)) {
        if (plainStart < pos) out.push({ kind: 'plain', text: text.slice(plainStart, pos) });
        out.push({ kind: 'rule', text: hit.text, han: text.slice(pos, hit.end) });
        pos = hit.end;
        plainStart = pos;
        continue;
      }
      pos++;
    }
    if (plainStart < text.length) out.push({ kind: 'plain', text: text.slice(plainStart) });
    return out;
  }

  function segmentNames(text) {
    const out = [];
    let plainStart = 0, pos = 0;
    while (pos < text.length) {
      const hit = nameAt(text, pos);
      if (hit) {
        // Trọng tài Names-vs-VP (giống userscript GPL tham chiếu): nếu VP có mục
        // tại đúng vị trí này dài >= tên thì nhường VP — không thì cụm VP chứa
        // chuỗi trùng tên bị tên cắt vụn (负能量 vỡ thành 负+能量 vì Names có 能量).
        let vpLen = 0;
        const vpLimit = Math.min(vpMax, text.length - pos);
        for (let len = vpLimit; len >= hit.len; len--) {
          if (vp.get(text.substr(pos, len)) !== undefined) { vpLen = len; break; }
        }
        if (vpLen >= hit.len) { pos++; continue; }
        if (plainStart < pos) out.push({ kind: 'plain', text: text.slice(plainStart, pos) });
        out.push({ kind: 'name', text: hit.value, han: hit.key });
        pos += hit.len;
        plainStart = pos;
        continue;
      }
      pos++;
    }
    if (plainStart < text.length) out.push({ kind: 'plain', text: text.slice(plainStart) });
    return out;
  }

  function tokenizePlain(text) {
    const tokens = [];
    let pos = 0;
    while (pos < text.length) {
      const hit = vpAt(text, pos);
      if (hit) {
        const value = opt.firstMeaning ? firstMeaning(hit.value, opt.separator) : hit.value;
        tokens.push({ han: hit.key, vi: value, kind: hit.len > 1 ? 'vp' : 'vp1' });
        pos += hit.len;
        continue;
      }
      const ch = text[pos];
      if (!HAN_RE.test(ch)) {
        let end = pos;
        while (end < text.length && !HAN_RE.test(text[end])) end++;
        const run = text.slice(pos, end);
        tokens.push({ han: run, vi: run, kind: 'raw' });
        pos = end;
        continue;
      }
      if (opt.skipParticles && PARTICLES.has(ch)) { pos++; continue; }
      const paValue = pa.get(ch);
      tokens.push({ han: ch, vi: paValue || ch, kind: 'pa' });
      pos++;
    }
    return tokens;
  }

  function translate(source) {
    const original = String(source || '').normalize('NFC');
    if (!original.trim() || !HAN_RE.test(original)) return { vi: original, tokens: [], spans: [], stats: null };

    const simplified = toSimplified(normalizePunct(original), t2s);
    let tokens = [];
    for (const piece of segmentOverrides(simplified)) {
      if (piece.kind === 'ov') { tokens.push({ han: piece.han, vi: piece.text, kind: 'ov' }); continue; }
      for (const gseg of segmentGlossary(piece.text)) {
        if (gseg.kind === 'gl') { tokens.push({ han: gseg.han, vi: gseg.text, kind: 'gl' }); continue; }
        for (const seg of segmentSupplement(gseg.text)) {
          if (seg.kind === 'sup') { tokens.push({ han: seg.han, vi: opt.firstMeaning ? firstMeaning(seg.text, opt.separator) : seg.text, kind: 'sup' }); continue; }
          for (const part of segmentRules(seg.text)) {
            if (part.kind === 'rule') { tokens.push({ han: part.han, vi: part.text, kind: 'rule' }); continue; }
            for (const sub of segmentNames(part.text)) {
              if (sub.kind === 'name') tokens.push({ han: sub.han, vi: sub.text, kind: 'name' });
              else tokens = tokens.concat(tokenizePlain(sub.text));
            }
          }
        }
      }
    }

    // spans[i] = [vi tri trong chuoi vi, chi so token]: dung de map vi tri bam chuot ve token
    // (tokenMap click-to-edit). Toan bo buoc "rua" lam trong vong lap nay tren tung token
    // (`:.`->':', gom khoang trang, viet hoa dau cau) de spans dung tren chuoi cuoi cung -
    // neu rua sau khi ghep thi moi lan rut bot ky tu deu lam spans lech cho cac token phia sau.
    let out = '';
    const spans = [];
    let sentenceStart = true;
    for (let i = 0; i < tokens.length; i++) {
      let vi = tokens[i].vi;
      if (vi === undefined || vi === '') continue;
      vi = vi.replace(/:\./g, ':').replace(/ {2,}/g, ' ')
        // Raw run giữ \n (giữ xuống dòng) nhưng space/thụt đầu dòng SAU \n là khoảng
        // trắng in đầu của đoạn gốc (　　) — HTML không hiển thị nó ở đầu dòng, giữ
        // lại sẽ thành "khoảng trống đầu dòng" trên bản dịch.
        .replace(/\n[\s\u3000]+/g, '\n');
      if (sentenceStart) vi = autoUpperCase(vi);
      else vi = vi.replace(/([.!?]\s+|\n+\s*)([a-zà-ỹả~])/g, (m, pre, ch) => pre + ch.toLocaleUpperCase('vi'));
      tokens[i].vi = vi;   // token trả về phải là nghĩa đã rửa: card click-to-edit hiện đúng những gì đang trên màn hình
      const prev = out[out.length - 1];
      if (needsSpace(prev, vi[0])) {
        out += ' ';
        vi = vi.replace(/^ +/, '');   // space vừa chèn thay cho space đầu token -> không bao giờ có 2 space liền (tương đương rửa toàn cục cũ)
      }
      if (vi.trim()) spans.push([out.length, i]);   // token whitespace-thuan: không có span (text có thể bị trim mất -> span lac)
      out += vi;
      sentenceStart = /[.!?]\s*$/.test(vi) || /\n\s*$/.test(vi);
    }
    // spans ghi trên chuỗi TRƯỚC trim; nếu trim cắt/gọt thì DỊCH toàn bộ offset
    // (highlight/click-map của content script trỏ nhầm chữ — lỗi "lệch 1 chữ" trên
    // truyện mở đầu đoạn bằng fullwidth space). Tính lượng cắt ở ĐẦU, dồn spans về
    // chuỗi sau trim; đuôi cắt không ảnh hưởng offset nào vì không có span sau nó.
    const cut = out.length - out.trimStart().length;
    if (cut > 0) {
      for (const sp of spans) sp[0] = Math.max(0, sp[0] - cut);
      out = out.trimStart();
    }
    out = out.trimEnd();

    const han = tokens.filter(t => HAN_RE.test(t.han));
    const stats = {
      hanChars: han.reduce((n, t) => n + [...t.han].length, 0),
      phraseChars: han.filter(t => [...t.han].length > 1).reduce((n, t) => n + [...t.han].length, 0),
      paChars: tokens.filter(t => t.kind === 'pa').reduce((n, t) => n + [...t.han].length, 0)
    };
    return { vi: out, tokens, spans, stats };
  }

  // Âm Hán Việt TỪNG CHỮ cho card sửa (F-âm): đọc từ lớp pa (ChinesePhienAmWords.txt).
  // '一' -> 'nhất'; chữ không có trong pa thì trả về chính nó (card tự ẩn dòng này).
  function phienOf(han) {
    let out = '';
    for (const ch of String(han || '')) {
      if (!HAN_RE.test(ch)) { out += ch; continue; }
      out += (pa.get(ch) || ch) + ' ';
    }
    return out.trim();
  }

  return { translate, phienOf, vpMax, namesMax, info: { vp: vp.size, names: names ? names.size : 0, pa: pa.size, rules: ruleEngine ? ruleEngine.count : 0, ov: overrides ? overrides.size : 0, gl: glossary ? glossary.size : 0, sup: supplement ? supplement.size : 0 } };
}
