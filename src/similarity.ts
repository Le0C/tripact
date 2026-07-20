// Faithful port of Python difflib.SequenceMatcher(autojunk=False), char-level.
// ratio() reproduces difflib's values with autojunk disabled, so a long atom's
// same-meaning reword scores on its full text at any length. The Python spike's
// golden is regenerated with autojunk=False too, keeping both sides comparable. UAC §3.3.

interface Block {
  a: number;
  b: number;
  size: number;
}

export class SequenceMatcher {
  private a: string;
  private b: string;
  private b2j = new Map<string, number[]>();
  private blocks: Block[] | null = null;

  constructor(a: string, b: string) {
    this.a = a;
    this.b = b;
    this.chainB();
  }

  private chainB(): void {
    const b = this.b;
    const b2j = this.b2j;
    for (let i = 0; i < b.length; i++) {
      const ch = b[i] as string;
      const idxs = b2j.get(ch);
      if (idxs) idxs.push(i);
      else b2j.set(ch, [i]);
    }
    // No autojunk: popular-character dropping never applies at any length (UAC §3.3).
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Block {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const idxs = b2j.get(a[i] as string);
      if (idxs) {
        for (const j of idxs) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }
    // extend the match on both sides (no junk classes to defer since autojunk is disabled)
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return { a: besti, b: bestj, size: bestsize };
  }

  getMatchingBlocks(): Block[] {
    if (this.blocks) return this.blocks;
    const la = this.a.length;
    const lb = this.b.length;
    const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
    const matching: Block[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
      const m = this.findLongestMatch(alo, ahi, blo, bhi);
      if (m.size) {
        matching.push(m);
        if (alo < m.a && blo < m.b) queue.push([alo, m.a, blo, m.b]);
        if (m.a + m.size < ahi && m.b + m.size < bhi) queue.push([m.a + m.size, ahi, m.b + m.size, bhi]);
      }
    }
    matching.sort((x, y) => x.a - y.a || x.b - y.b);
    // merge adjacent blocks
    const merged: Block[] = [];
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    for (const { a: i2, b: j2, size: k2 } of matching) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) merged.push({ a: i1, b: j1, size: k1 });
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1) merged.push({ a: i1, b: j1, size: k1 });
    merged.push({ a: la, b: lb, size: 0 });
    this.blocks = merged;
    return merged;
  }

  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((s, bl) => s + bl.size, 0);
    const t = this.a.length + this.b.length;
    return t ? (2 * matches) / t : 1;
  }
}

/** difflib.SequenceMatcher(None, a, b).ratio() */
export function similarityRatio(a: string, b: string): number {
  return new SequenceMatcher(a, b).ratio();
}

/** Matched chars relative to the shorter string, for split/merge & extension detection. */
export function containment(a: string, b: string): number {
  const m = new SequenceMatcher(a, b);
  const matched = m.getMatchingBlocks().reduce((s, bl) => s + bl.size, 0);
  return matched / Math.max(1, Math.min(a.length, b.length));
}
