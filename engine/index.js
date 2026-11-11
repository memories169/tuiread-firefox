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
  luatNhan: 'LuatNhan.txt',
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
  // Nạp theo KEY (không destructure theo thứ tự values) — thêm file mới không lệch.
  const bufs = {};
  await Promise.all(Object.entries(FILES).map(async ([key, file]) => {
    // Supplement/Pack/LuatNhan là file tùy chọn: thiếu thì engine vẫn chạy với lớp rỗng.
    try { bufs[key] = await readFile(file); } catch { bufs[key] = null; }
  }));

  const vp = parseDict(decode(bufs.vp));
  const names = parseDict(decode(bufs.names));
  const pa = parseDict(decode(bufs.pa), { singleChar: true });
  const pronouns = parseDict(decode(bufs.pronouns));
  const t2s = parseT2S(decode(bufs.t2s));
  // VP/sup nạp trước để kiểm capture <e>: {0} của LuatNhan là TÊN — đoạn có nghĩa
  // trong VP/sup thì rule nhường (tránh '个很<e>的人' nuốt '很厉害' giữ Hán).
  const vpEarly = parseDict(decode(bufs.vp));
  const supEarly = new Map([
    ...(bufs.pack ? parseDict(decode(bufs.pack)) : []),
    ...(bufs.supplement ? parseDict(decode(bufs.supplement)) : [])
  ]);
  const rejectCapture = cap => {
    return vpEarly.has(cap) || supEarly.has(cap);   // CHỈ whole capture là từ có nghĩa
  };
  const rules = createRuleEngine(decode(bufs.rules) + '\n' + (bufs.luatNhan ? decode(bufs.luatNhan) : ''), { rejectCapture });
  // Lớp supplement gộp 2 nguồn: Pack-UuHoa (cộng đồng, nạp trước) < Supplement.txt (bản vá
  // tay của dự án, nạp sau -> thắng khi trùng key). Cả hai nằm dưới override của user.
  const pack = bufs.pack ? parseDict(decode(bufs.pack)) : new Map();
  const supplement = bufs.supplement ? parseDict(decode(bufs.supplement)) : new Map();
  const supplementMerged = new Map([...pack, ...supplement]);

  const engine = createEngine({ pa, vp, names, pronouns, t2s, rules, supplement: supplementMerged }, settings);
  engine.loadMs = Date.now() - t0;
  engine.ruleStats = rules.stats;
  engine.t2sSize = t2s.size;
  engine.supplementSize = supplementMerged.size;
  return engine;
}

export { createEngine, parseDict, parseDictBuffer, parseT2S, createRuleEngine, FILES };
