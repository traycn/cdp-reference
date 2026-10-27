/**
 * Seeded PRNG (sfc32, seeded through splitmix32). Integer arithmetic only, so
 * the same seed gives the same sequence on every platform and Node version.
 * Never use Math.random in the generator.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  /**
   * `stream` picks an independent sequence for the same seed. Stream 0 is the
   * generator's main stream and is the same sequence as before streams existed.
   */
  constructor(seed: number, stream = 0) {
    let s = seed >>> 0;
    const splitmix = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = splitmix();
    this.b = splitmix();
    this.c = (splitmix() ^ stream) >>> 0;
    this.d = splitmix();
    for (let i = 0; i < 12; i++) this.u32();
  }

  /** Uniform 32-bit unsigned integer. */
  u32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.u32() / 4294967296;
  }

  /** Uniform integer in [lo, hi], inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  bool(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Picks a key with probability proportional to its weight. */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K {
    const entries = Object.entries(weights) as [K, number][];
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let x = this.float() * total;
    for (const [k, w] of entries) {
      x -= w;
      if (x < 0) return k;
    }
    return entries[entries.length - 1]![0];
  }

  /** Number of failures before the first success; mean (1 - p) / p. */
  geometric(p: number): number {
    let n = 0;
    while (!this.bool(p)) n++;
    return n;
  }

  /** In-place Fisher–Yates. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [items[i], items[j]] = [items[j] as T, items[i] as T];
    }
    return items;
  }

  hex(chars: number): string {
    let out = "";
    while (out.length < chars) out += this.u32().toString(16).padStart(8, "0");
    return out.slice(0, chars);
  }

  /** UUIDv4-shaped string; used for anonymous device IDs. */
  uuid(): string {
    const h = this.hex(32);
    const variant = "89ab"[this.int(0, 3)] as string;
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}
