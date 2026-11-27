// Hand-built Furnace modules (C64 chip), byte by byte from papers/format.md, independent of the SIDWave writer.
const le16 = (v) => [v & 255, (v >> 8) & 255];
const le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return [...b]; };
const str = (s) => [...Buffer.from(s, "utf8"), 0];
const block = (id, body) => [...Buffer.from(id, "latin1"), ...le32(body.length), ...body];

/** One C64 instrument (type 3): name, C64 data (pulse, AD 0x09, SR 0xA4, duty 0x800) and an arpeggio macro 0,+4,+7 (speed 2). */
export function insBlock(version = 228) {
  const feature = (code, body) => [...Buffer.from(code, "latin1"), ...le16(body.length), ...body];
  const c64 = [0x04, 0x00, 0x09, 0xa4, ...le16(0x800), ...le16(0), 0];
  const macro = [...le16(8), 1, 3, 255, 255, 0, 0x40 | 1, 0, 2, 0, 4, 7, 255];
  return block("INS2", [...le16(version), ...le16(3), ...feature("NA", str("lead")), ...feature("64", c64), ...feature("MA", macro), ...Buffer.from("EN", "latin1"), 0, 0]);
}
/** Pattern block: rows 0 (C-4 = 108, ins 0), 4 (E-4), 8 (G-4 vol 8), 12 (note off). */
export function patBlock(channel, index, withNotes, version = 228) {
  const body = [0, ...(version >= 240 ? le16(channel) : [channel]), ...le16(index), ...str("")];
  if (withNotes) {
    body.push(0x03, 108, 0); // note + instrument
    body.push(0x81, 0x01, 112, 0x81, 0x07, 115, 0, 8, 0x81, 0x01, 180); // 0x81 skips 3 rows
  } else body.push(0xff);
  if (withNotes) body.push(0xff);
  return block("PATN", body);
}

/** Version 228 module: INFO header, one 16-row pattern per channel (only channel 0 has notes). */
export function fur228({ chip = 0x47, speeds = [6], tick = 60, custom } = {}) {
  const info = [];
  info.push(0, speeds[0], speeds[0], 1, ...f32(tick), ...le16(16), ...le16(custom?.ordersLen ?? 1), 4, 16, ...le16(1), ...le16(0), ...le16(0), ...le32(custom ? custom.patterns.length : 3));
  info.push(chip, ...new Array(31).fill(0), ...new Array(32 + 32 + 128).fill(0));
  info.push(...str("Hand"), ...str("Tester"), ...f32(440), ...new Array(20).fill(0));
  const ptrAt = info.length;
  info.push(...new Array(4 * (1 + (custom ? custom.patterns.length : 3))).fill(0)); // 1 instrument + patterns
  info.push(...(custom?.orderBytes ?? [0, 0, 0])); // orders, channels outer
  info.push(1, 1, 1, 0, 0, 0, 0, 0, 0);
  info.push(...str(""), ...str(""), ...str(""), ...str(""), ...str(""), ...str(""), ...str(""), ...f32(1), ...new Array(28).fill(0));
  info.push(...le16(1), ...le16(1), ...str(""), ...str(""), 0, 0, 0, 0);
  for (let i = 0; i < 6; i++) info.push(...str(""));
  info.push(...f32(1), ...f32(0), ...f32(0), ...le32(0), 1, ...new Array(8).fill(0));
  info.push(speeds.length, ...speeds, ...new Array(16 - speeds.length).fill(0), 0, ...le32(0), ...le32(0), ...le32(0));
  const head = [...Buffer.from("-Furnace module-", "latin1"), ...le16(228), 0, 0, ...le32(32), ...new Array(8).fill(0)];
  const parts = [insBlock(), ...(custom ? custom.patterns.map((p) => block("PATN", [0, p.channel, ...le16(p.index), ...str(""), ...p.rows])) : [patBlock(0, 0, true), patBlock(1, 0, false), patBlock(2, 0, false)])];
  let at = 32 + 8 + info.length;
  parts.forEach((p, i) => { info.splice(ptrAt + 4 * i, 4, ...le32(at)); at += p.length; });
  return Buffer.from([...head, ...block("INFO", info), ...parts.flat()]);
}

/** Version 240 module: INF2 header with a SNG2 subsong element. */
export function fur240({ chip = 0x47 } = {}) {
  const sng = [...f32(60), 1, 1, ...le16(16), ...le16(1), 4, 16, ...le16(1), ...le16(1), 1, ...le16(6), ...new Array(15 * 2).fill(0), ...str(""), ...str(""), 0, 0, 0];
  const parts = [insBlock(240), patBlock(0, 0, true, 240), patBlock(1, 0, false, 240), patBlock(2, 0, false, 240)];
  const sngBlock = block("SNG2", sng);
  const inf = [...str("Hand2"), ...str("Tester"), ...str(""), ...str(""), ...str(""), ...str(""), ...str(""), ...str(""), ...f32(440), 1, ...f32(1), ...le16(3), ...le16(1), ...le16(chip), ...le16(3), ...f32(1), ...f32(0), ...f32(0), ...le32(0), 1];
  const elementsLen = 1 + 4 + 4 + 1 + 4 + 4 + 1 + 4 + 12 + 1;
  const base = 32 + 8 + inf.length + elementsLen;
  let at = base;
  const sngAt = at; at += sngBlock.length;
  const insAt = at; at += parts[0].length;
  const patAt = [];
  for (const p of parts.slice(1)) { patAt.push(at); at += p.length; }
  inf.push(1, ...le32(1), ...le32(sngAt), 4, ...le32(1), ...le32(insAt), 7, ...le32(3), ...patAt.flatMap(le32), 0);
  const head = [...Buffer.from("-Furnace module-", "latin1"), ...le16(240), 0, 0, ...le32(32), ...new Array(8).fill(0)];
  return Buffer.from([...head, ...block("INF2", inf), ...sngBlock, ...parts.flat()]);
}
