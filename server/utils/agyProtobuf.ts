// Minimal protobuf wire reader for Antigravity's stored step blobs
// (conversations/<id>.db `steps`/`gen_metadata` columns). Pure TypeScript,
// bounds-checked: a malformed or truncated field ends the field list of its
// message instead of throwing, so a torn row never aborts a read.
export interface WireField {
  tag: number
  wire: number // 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32
  v: bigint // wire 0 value
  buf: Uint8Array // wire 2 bytes; other wires: the raw field bytes
}

function varint(buf: Uint8Array, at: number): { v: bigint, next: number } | null {
  let v = 0n, s = 0n
  for (let n = 0; n < 10; n++) {
    if (at + n >= buf.length) return null
    const b = buf[at + n]!
    v |= BigInt(b & 0x7f) << s
    if (!(b & 0x80)) return { v, next: at + n + 1 }
    s += 7n
  }
  return null
}

export function wireFields(buf: Uint8Array | null | undefined): WireField[] {
  const out: WireField[] = []
  if (!buf || !buf.length) return out
  let i = 0
  while (i < buf.length) {
    const start = i
    const key = varint(buf, i)
    if (!key) break
    i = key.next
    const tag = Number(key.v >> 3n), wire = Number(key.v & 7n)
    if (tag <= 0) break
    if (wire === 0) {
      const r = varint(buf, i)
      if (!r) break
      out.push({ tag, wire, v: r.v, buf: buf.subarray(start, r.next) })
      i = r.next
    } else if (wire === 1) {
      if (i + 8 > buf.length) break
      out.push({ tag, wire, v: 0n, buf: buf.subarray(start, i + 8) })
      i += 8
    } else if (wire === 2) {
      const l = varint(buf, i)
      if (!l) break
      i = l.next
      const n = Number(l.v)
      if (!Number.isSafeInteger(n) || n < 0 || i + n > buf.length) break
      out.push({ tag, wire, v: 0n, buf: buf.subarray(i, i + n) })
      i += n
    } else if (wire === 5) {
      if (i + 4 > buf.length) break
      out.push({ tag, wire, v: 0n, buf: buf.subarray(start, i + 4) })
      i += 4
    } else break // groups and unknown wire types: stop at the first bad field
  }
  return out
}

export const fieldOf = (buf: Uint8Array | null | undefined, tag: number): WireField | undefined =>
  wireFields(buf).find(f => f.tag === tag)
export const fieldsOf = (buf: Uint8Array | null | undefined, tag: number): WireField[] =>
  wireFields(buf).filter(f => f.tag === tag)
export const subOf = (f: WireField | undefined): WireField[] => (f && f.wire === 2 ? wireFields(f.buf) : [])
export const textOf = (f: WireField | undefined): string =>
  (f && f.wire === 2 ? new TextDecoder('utf-8', { fatal: false }).decode(f.buf) : '')
export const numOf = (f: WireField | undefined): number | null => (f && f.wire === 0 ? Number(f.v) : null)

// google.protobuf.Timestamp { 1: int64 seconds, 2: int32 nanos } -> ms epoch.
export function tsOf(f: WireField | undefined): number | null {
  if (!f || f.wire !== 2) return null
  const fs = subOf(f)
  const sec = numOf(fs.find(x => x.tag === 1))
  const nanos = numOf(fs.find(x => x.tag === 2)) ?? 0
  return sec === null ? null : sec * 1000 + Math.floor(nanos / 1e6)
}
export const isoOf = (f: WireField | undefined): string | null => {
  const t = tsOf(f)
  return t === null ? null : new Date(t).toISOString()
}
