/** Bounded readers for TrueType cmap/loca/glyf. Unsupported font formats use image fallback. */
export function readTrueType(bytes: Uint8Array): { mapping: Map<number, number>; glyph(index: number): Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset);
  const i16 = (offset: number) => view.getInt16(offset);
  const u32 = (offset: number) => view.getUint32(offset);
  if (bytes.length > 32000000 || u32(0) !== 0x00010000 || u16(4) > 128) throw new Error("Unsupported font");
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < u16(4); i++) {
    const p = 12 + i * 16;
    const name = String.fromCharCode(...bytes.subarray(p, p + 4));
    const offset = u32(p + 8), length = u32(p + 12);
    if (offset + length > bytes.length) throw new Error("Invalid font table");
    tables.set(name, { offset, length });
  }
  const table = (name: string) => { const value = tables.get(name); if (!value) throw new Error("Missing font table"); return value; };
  const count = u16(table("maxp").offset + 4);
  const long = i16(table("head").offset + 50) !== 0;
  const loca = table("loca"), glyf = table("glyf"), cmap = table("cmap");
  if (loca.length < (count + 1) * (long ? 4 : 2)) throw new Error("Invalid glyph offsets");
  const location = (index: number) => long ? u32(loca.offset + index * 4) : u16(loca.offset + index * 2) * 2;
  const glyph = (index: number): Uint8Array => {
    if (index < 0 || index >= count) throw new Error("Invalid glyph index");
    const start = location(index), end = location(index + 1);
    if (start > end || end > glyf.length) throw new Error("Invalid glyph range");
    return bytes.subarray(glyf.offset + start, glyf.offset + end);
  };
  const mapping = new Map<number, number>();
  // Per-group/segment limits alone do not bound the total work: a crafted font can have many
  // groups that all map the same code range (repeated inserts never grow `mapping`). Keep a
  // hard iteration budget so a page-controlled font cannot freeze the isolated world.
  const MAX_CMAP_ITERATIONS = 2_000_000;
  let iterations = 0;
  const tick = (count: number) => { iterations += count; if (iterations > MAX_CMAP_ITERATIONS) throw new Error("Font character map too large"); };
  const insert = (code: number, index: number) => {
    if (code > 0x10ffff || mapping.size > 100000 || index >= count) throw new Error("Invalid character map");
    if (index) mapping.set(code, index);
  };
  if (u16(cmap.offset + 2) > 128) throw new Error("Too many character maps");
  const seen = new Set<number>();
  for (let i = 0; i < u16(cmap.offset + 2); i++) {
    const offset = cmap.offset + u32(cmap.offset + 4 + i * 8 + 4);
    if (seen.has(offset)) continue; seen.add(offset);
    const format = u16(offset);
    if (format === 12) {
      const groups = u32(offset + 12);
      if (groups > 65536) throw new Error("Too many font groups");
      for (let j = 0; j < groups; j++) {
        const p = offset + 16 + j * 12, first = u32(p), end = u32(p + 4), index = u32(p + 8);
        if (end - first > 65536) throw new Error("Font group too large");
        tick(end - first + 1);
        for (let code = first; code <= end; code++) insert(code, index + code - first);
      }
    } else if (format === 4) {
      const segments = u16(offset + 6) / 2;
      if (!Number.isInteger(segments) || segments > 8192) throw new Error("Invalid font segments");
      const end = offset + 14, start = end + segments * 2 + 2, delta = start + segments * 2, ranges = delta + segments * 2;
      for (let j = 0; j < segments; j++) {
        const first = u16(start + j * 2), last = u16(end + j * 2), range = u16(ranges + j * 2);
        tick(Math.max(0, last - first));
        for (let code = first; code <= last && code < 65535; code++) {
          let index = range ? u16(ranges + j * 2 + range + (code - first) * 2) : code;
          index = range && !index ? 0 : (index + i16(delta + j * 2)) & 65535;
          insert(code, index);
        }
      }
    }
  }
  if (!mapping.size) throw new Error("No supported character map");
  return { mapping, glyph };
}
