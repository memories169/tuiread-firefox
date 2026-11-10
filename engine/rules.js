// Rule engine QuickTranslate (subset): literal, (a|b), (a|b)?, <n:m-n>, <y:m-n>, <L>, {i}.
// Rule cần <ne> <pn> <vp> <hv> <w> bị bỏ qua (đếm ở stats.skipped).

import { isNumChar, isDigitChar, chineseNumberToArabic, digitByDigit, LABELS } from './numbers.js';

const CAPTURE_RE = /^<([nyL])(?::(\d+)(?:-(\d+))?)?>$/;

// <ne> <pn> <vp> <hv> <w> can tra tu dien khi match -> chưa hỗ trợ.
function hasUnsupportedToken(pattern) {
  for (const m of pattern.matchAll(/<([^>]*)>/g)) {
    const kind = m[1].split(':')[0];
    if (kind !== 'n' && kind !== 'y' && kind !== 'L') return true;
  }
  return false;
}

function tokenize(pattern) {
  const chars = [...pattern];
  const tokens = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === '<') {
      const close = chars.indexOf('>', i);
      if (close < 0) return null;
      const spec = chars.slice(i, close + 1).join('');
      const m = CAPTURE_RE.exec(spec);
      if (!m) return null;
      const kind = m[1];
      const min = m[2] ? Number(m[2]) : 1;
      const max = m[3] ? Number(m[3]) : (kind === 'L' ? 1 : (m[2] ? Number(m[2]) : 8));
      if (kind === 'L') tokens.push({ t: 'label' });
      else tokens.push({ t: kind === 'n' ? 'num' : 'year', min, max });
      i = close + 1;
      continue;
    }
    if (ch === '(') {
      const close = chars.indexOf(')', i);
      if (close < 0) return null;
      const alts = chars.slice(i + 1, close).join('').split('|').filter(a => a.length);
      let optional = false;
      let next = close + 1;
      if (chars[next] === '?') { optional = true; next++; }
      tokens.push({ t: 'group', alts, optional });
      i = next;
      continue;
    }
    tokens.push({ t: 'lit', v: ch });
    i++;
  }
  return tokens.length ? tokens : null;
}

function parseTemplate(template) {
  const parts = [];
  let i = 0;
  while (i < template.length) {
    const m = /\{(\d+)\}/.exec(template.slice(i));
    if (!m) { parts.push({ lit: template.slice(i) }); break; }
    if (m.index) parts.push({ lit: template.slice(i, i + m.index) });
    parts.push({ ref: Number(m[1]) });
    i += m.index + m[0].length;
  }
  return parts;
}

export function parseRules(text) {
  const rules = [];
  const stats = { total: 0, skippedUnsupported: 0, skippedInvalid: 0 };
  for (const raw of String(text || '').split('\n')) {
    let line = raw.trim();
    // "!" đầu dòng = rule mạnh: thắng cả khi HOÀ độ dài với key VietPhrase.
    // Dùng cho tiêu đề chương: dữ liệu 第X章 trong VietPhrase có ~15% mục sai số
    // (VD 第一千五百四十八章 ghi 1549) và thiếu mục số Ả Rập >= 1000 — rule tính
    // số chuẩn luôn đúng nên phải nhường KHÔNG cần dài hơn.
    const strong = line.startsWith('!');
    if (strong) line = line.slice(1).trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    stats.total++;
    const pattern = line.slice(0, eq).trim();
    const template = line.slice(eq + 1).trim();
    if (hasUnsupportedToken(pattern)) { stats.skippedUnsupported++; continue; }
    const tokens = tokenize(pattern);
    if (!tokens) { stats.skippedInvalid++; continue; }
    if (!tokens.some(t => t.t === 'lit' || (t.t === 'group' && !t.optional))) { stats.skippedInvalid++; continue; }
    const parts = parseTemplate(template);
    const refs = parts.filter(p => p.ref !== undefined).length;
    const captures = tokens.filter(t => t.t === 'num' || t.t === 'year' || t.t === 'label').length;
    if (refs !== captures) { stats.skippedInvalid++; continue; }
    rules.push({ pattern, parts, tokens, order: rules.length, strong });
  }
  return { rules, stats };
}

function walk(tokens, ti, text, pos, captures) {
  if (ti === tokens.length) return { end: pos, captures };
  const tok = tokens[ti];
  if (tok.t === 'lit') {
    if (!text.startsWith(tok.v, pos)) return null;
    return walk(tokens, ti + 1, text, pos + tok.v.length, captures);
  }
  if (tok.t === 'group') {
    for (const alt of tok.alts) {
      if (text.startsWith(alt, pos)) {
        const hit = walk(tokens, ti + 1, text, pos + alt.length, captures);
        if (hit) return hit;
      }
    }
    if (tok.optional) return walk(tokens, ti + 1, text, pos, captures);
    return null;
  }
  if (tok.t === 'label') {
    const label = LABELS[text[pos]];
    if (!label) return null;
    return walk(tokens, ti + 1, text, pos + 1, captures.concat([label]));
  }
  const pred = tok.t === 'num' ? isNumChar : isDigitChar;
  let run = 0;
  while (pos + run < text.length && pred(text[pos + run])) run++;
  if (pos + run < text.length && pred(text[pos + run])) return null; // chuỗi số dài hơn max
  if (run < tok.min) return null;
  const limit = Math.min(run, tok.max);
  for (let take = limit; take >= tok.min; take--) {
    const value = text.slice(pos, pos + take);
    const conv = tok.t === 'num' ? chineseNumberToArabic(value) : digitByDigit(value);
    if (!conv) continue;
    const hit = walk(tokens, ti + 1, text, pos + take, captures.concat([conv]));
    if (hit) return hit;
  }
  return null;
}

function render(parts, captures) {
  let out = '';
  for (const p of parts) out += p.ref === undefined ? p.lit : (captures[p.ref] ?? '');
  return out;
}

export function createRuleEngine(ruleText) {
  const { rules, stats } = parseRules(ruleText);
  const direct = new Map();
  const anchors = new Map();
  let maxLookahead = 0;

  for (const rule of rules) {
    const first = rule.tokens[0];
    if (first.t === 'lit') pushIndex(direct, first.v[0], rule);
    else if (first.t === 'group' && !first.optional) for (const alt of first.alts) pushIndex(direct, alt[0], rule);
    else {
      let min = 0, max = 0, anchorToken = null;
      for (const tok of rule.tokens) {
        if (tok.t === 'lit') { anchorToken = { v: tok.v }; break; }
        if (tok.t === 'group' && !tok.optional) { anchorToken = { v: tok.alts[0], alts: tok.alts }; break; }
        if (tok.t === 'label') { min += 1; max += 1; continue; }
        min += tok.min; max += tok.max;
      }
      if (!anchorToken) continue;
      maxLookahead = Math.max(maxLookahead, max);
      const keys = anchorToken.alts ? anchorToken.alts.map(a => a[0]) : [anchorToken.v[0]];
      for (const key of keys) {
        if (!anchors.has(key)) anchors.set(key, []);
        anchors.get(key).push({ rule, min, max });
      }
    }
  }

  function pushIndex(map, key, rule) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(rule);
  }

  // Trả về { end, text } nếu có rule khớp tại start, ngược lại null.
  function matchAt(text, start) {
    const candidates = (direct.get(text[start]) || []).slice();
    if (anchors.size && maxLookahead) {
      const seen = new Set(candidates);
      for (const item of anchors.get(text[start]) || []) {
        if (!seen.has(item.rule)) { seen.add(item.rule); candidates.push(item.rule); }
      }
      const limit = Math.min(maxLookahead, text.length - start - 1);
      for (let offset = 1; offset <= limit; offset++) {
        const list = anchors.get(text[start + offset]);
        if (!list) continue;
        for (const item of list) {
          if (offset < item.min || offset > item.max || seen.has(item.rule)) continue;
          seen.add(item.rule);
          candidates.push(item.rule);
        }
      }
    }
    if (candidates.length > 1) candidates.sort((a, b) => a.order - b.order);
    for (const rule of candidates) {
      const hit = walk(rule.tokens, 0, text, start, []);
      if (!hit || hit.end === start) continue;
      return { end: hit.end, text: render(rule.parts, hit.captures), rule: rule.pattern, strong: !!rule.strong };
    }
    return null;
  }

  return { matchAt, count: rules.length, stats };
}
