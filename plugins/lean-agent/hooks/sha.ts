// SHA-256 in plain JS: the hooks sandbox has no crypto.subtle.importKey. Shared by the review records (reviews.ts, HMAC) and the
// script store (recipe.ts, content hashes); a module of its own so neither pulls the other in.
const K = Array.from({ length: 64 }, (_, i) => { let p = 0; for (let n = 2, c = 0; c <= i; n++) if (Array.from({ length: n - 2 }, (_, d) => d + 2).every(d => n % d)) { p = n; c++ } return Math.floor((Math.cbrt(p) % 1) * 2 ** 32) >>> 0 })
export function sha256(m: Uint8Array): Uint8Array {
  const H = [2, 3, 5, 7, 11, 13, 17, 19].map(p => Math.floor((Math.sqrt(p) % 1) * 2 ** 32) >>> 0)
  const len = m.length
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6)
  padded.set(m)
  padded[len] = 0x80
  new DataView(padded.buffer).setUint32(padded.length - 4, (len * 8) >>> 0)
  new DataView(padded.buffer).setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32))
  const rot = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  const w = new Uint32Array(64)
  for (let o = 0; o < padded.length; o += 64) {
    const dv = new DataView(padded.buffer, o, 64)
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(i * 4)
    for (let i = 16; i < 64; i++) w[i] = (w[i - 16]! + (rot(w[i - 15]!, 7) ^ rot(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)) + w[i - 7]! + (rot(w[i - 2]!, 17) ^ rot(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10))) >>> 0
    let [a, b, c, d, e, f, g, h] = H as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    ;[a, b, c, d, e, f, g, h].forEach((x, i) => (H[i] = (H[i]! + x) >>> 0))
  }
  const out = new Uint8Array(32)
  H.forEach((x, i) => new DataView(out.buffer).setUint32(i * 4, x))
  return out
}
