// Bootstrap: doc dict tu mot thu muc (Node dung fs, trinh duyet dung fetch).
// Tu phat hien ma hoa qua BOM: FF FE -> UTF-16LE, nguoi khac -> UTF-8.

import { parseDict, parseDictBuffer } from './dict.js';
import { parseT2S } from './t2s.js';
import { createRuleEngine } from './rules.js';
import { createEngine } from './translate.js';

const FILES = {
  vp: 'VietPhrase.txt',
  names: 'Names.txt',
  pa: 'ChinesePhienAmWords.txt',
  pronouns: 'Pronouns.txt',
  rules: 'rule.txt',
  t2s: 'TSCharacters.txt',
  supplement: 'Supplement.txt',
  pack: 'Pack-UuHoa.txt'
};

export function decode(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export async function loadEngine(readFile, settings = {}) {
  const t0 = Date.now();
  const [vpText, namesText, paText, pronounsText, rulesText, t2sText, supplementText, packText] = await Promise.all(
    Object.values(FILES).map(async f => {
      // Supplement là file tùy chọn: thiếu thì engine vẫn chạy với lớp rỗng.
      try { return await readFile(f); } catch { return null; }
    })
  );

  const vp = parseDict(decode(vpText));
  const names = parseDict(decode(namesText));
  const pa = parseDict(decode(paText), { singleChar: true });
  const pronouns = parseDict(decode(pronounsText));
  const t2s = parseT2S(decode(t2sText));
  const rules = createRuleEngine(decode(rulesText));
  // Lớp supplement gộp 2 nguồn: Pack-UuHoa (cộng đồng, nạp trước) < Supplement.txt (bản vá
  // tay của dự án, nạp sau -> thắng khi trùng key). Cả hai nằm dưới override của user.
  const pack = packText ? parseDict(decode(packText)) : new Map();
  const supplement = supplementText ? parseDict(decode(supplementText)) : new Map();
  const supplementMerged = new Map([...pack, ...supplement]);

  const engine = createEngine({ pa, vp, names, pronouns, t2s, rules, supplement: supplementMerged }, settings);
  engine.loadMs = Date.now() - t0;
  engine.ruleStats = rules.stats;
  engine.t2sSize = t2s.size;
  engine.supplementSize = supplementMerged.size;
  return engine;
}

export { createEngine, parseDict, parseDictBuffer, parseT2S, createRuleEngine, FILES };
