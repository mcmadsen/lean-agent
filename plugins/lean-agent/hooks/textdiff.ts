// A small unified diff (pure, no process): common head and tail trimmed, the middle by LCS when it is small enough, else replaced whole.
// Enough for an auditor to read what an update changes.
export function unifiedDiff(a: string, b: string, nameA: string, nameB: string, context = 3): string {
  const A = a.split('\n')
  const B = b.split('\n')
  let head = 0
  while (head < A.length && head < B.length && A[head] === B[head]) head++
  let tail = 0
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++
  const ma = A.slice(head, A.length - tail)
  const mb = B.slice(head, B.length - tail)
  // ops over the middle: ' ' keep, '-' remove, '+' add
  const ops: [string, string][] = []
  if (ma.length * mb.length <= 4_000_000) {
    const L = Array.from({ length: ma.length + 1 }, () => new Uint32Array(mb.length + 1))
    for (let i = ma.length - 1; i >= 0; i--) for (let j = mb.length - 1; j >= 0; j--) L[i]![j] = ma[i] === mb[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!)
    let i = 0
    let j = 0
    while (i < ma.length && j < mb.length) {
      if (ma[i] === mb[j]) { ops.push([' ', ma[i]!]); i++; j++ }
      else if (L[i + 1]![j]! >= L[i]![j + 1]!) ops.push(['-', ma[i++]!])
      else ops.push(['+', mb[j++]!])
    }
    while (i < ma.length) ops.push(['-', ma[i++]!])
    while (j < mb.length) ops.push(['+', mb[j++]!])
  } else {
    for (const l of ma) ops.push(['-', l])
    for (const l of mb) ops.push(['+', l])
  }
  if (!ops.some(o => o[0] !== ' ')) return ''
  const all: [string, string][] = [...A.slice(0, head).map((l): [string, string] => [' ', l]), ...ops, ...A.slice(A.length - tail).map((l): [string, string] => [' ', l])]
  const out = [`--- ${nameA}`, `+++ ${nameB}`]
  // hunks: every change with `context` lines around it, nearby changes merged
  const keep = new Array<boolean>(all.length).fill(false)
  all.forEach((o, k) => {
    if (o[0] !== ' ') for (let d = -context; d <= context; d++) if (k + d >= 0 && k + d < all.length) keep[k + d] = true
  })
  let k = 0
  while (k < all.length) {
    if (!keep[k]) { k++; continue }
    let end = k
    while (end < all.length && keep[end]) end++
    const seg = all.slice(k, end)
    const startA = all.slice(0, k).filter(o => o[0] !== '+').length + 1
    const startB = all.slice(0, k).filter(o => o[0] !== '-').length + 1
    out.push(`@@ -${startA},${seg.filter(o => o[0] !== '+').length} +${startB},${seg.filter(o => o[0] !== '-').length} @@`)
    for (const [t, l] of seg) out.push(t + l)
    k = end
  }
  return out.join('\n') + '\n'
}
