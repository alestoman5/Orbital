// Scales, nice ticks (major + minor, linear and log), auto limits and the tick
// mapping of secondary axes. DOM-free.

/** Maps a data domain [d0, d1] onto a pixel range [r0, r1] (linear or log10). */
export class Scale {
  private readonly t0: number;
  private readonly k: number;
  constructor(readonly d0: number, readonly d1: number, readonly r0: number, readonly r1: number, readonly log = false) {
    this.t0 = this.tf(d0);
    const span = this.tf(d1) - this.t0;
    this.k = span === 0 ? 0 : (r1 - r0) / span;
  }
  private tf(v: number): number {
    return this.log ? Math.log10(v) : v;
  }
  map(v: number): number {
    return this.r0 + (this.tf(v) - this.t0) * this.k;
  }
  invert(p: number): number {
    const t = this.t0 + (p - this.r0) / (this.k || 1);
    return this.log ? 10 ** t : t;
  }
  /** Domain sorted ascending. */
  get lo(): number {
    return Math.min(this.d0, this.d1);
  }
  get hi(): number {
    return Math.max(this.d0, this.d1);
  }
  contains(v: number, eps = 1e-9): boolean {
    const span = Math.abs(this.tf(this.d1) - this.t0) || 1;
    const t = this.tf(v);
    return t >= Math.min(this.t0, this.tf(this.d1)) - eps * span && t <= Math.max(this.t0, this.tf(this.d1)) + eps * span;
  }
}

const MANTISSAS = [1, 2, 2.5, 5, 10];

/** Smallest "nice" step (1, 2, 2.5, 5 × 10^k) ≥ raw. 2.5 is skipped unless allowQuarter. */
export function niceStep(raw: number, allowQuarter = false): number {
  if (!(raw > 0) || !Number.isFinite(raw)) {
    return 1;
  }
  const e = Math.floor(Math.log10(raw));
  const base = 10 ** e;
  for (const m of MANTISSAS) {
    if (m === 2.5 && !allowQuarter) {
      continue;
    }
    if (m * base >= raw * (1 - 1e-9)) {
      return m * base;
    }
  }
  return 10 * base;
}

/** Next larger nice step after `step`. */
export function nextStep(step: number): number {
  return niceStep(step * 1.0001);
}

/** Multiples of `step` within [min, max] (inclusive, with float tolerance). */
export function ticksForStep(min: number, max: number, step: number): number[] {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const eps = step * 1e-6;
  const i0 = Math.ceil((lo - eps) / step);
  const i1 = Math.floor((hi + eps) / step);
  const out: number[] = [];
  for (let i = i0; i <= i1 && out.length < 1000; i++) {
    const v = i * step;
    // clean float noise (0.30000000000000004 -> 0.3)
    out.push(Math.abs(v) < eps ? 0 : Number(v.toPrecision(12)));
  }
  return out;
}

export interface Ticks {
  major: number[];
  minor: number[];
  step: number;
}

function countFor(lo: number, hi: number, step: number): number {
  const eps = step * 1e-6;
  return Math.floor((hi + eps) / step) - Math.ceil((lo - eps) / step) + 1;
}

/**
 * Nice major ticks over [min, max]: the smallest step of 1, 2, 5 × 10^k that
 * gives at most `maxTicks` ticks (as matplotlib's MaxNLocator). A 2.5 step is
 * used only when the 1-2-5 choice would leave fewer than 4 ticks.
 */
export function linearTicks(min: number, max: number, maxTicks = 6): Ticks {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) {
    return { major: Number.isFinite(min) ? [min] : [], minor: [], step: 1 };
  }
  const limit = Math.max(2, Math.floor(maxTicks));
  let step = niceStep(span / limit / 1.0001 / 4);
  for (let guard = 0; guard < 40 && countFor(lo, hi, step) > limit; guard++) {
    step = nextStep(step);
  }
  // short axes: never fewer than two labelled ticks
  for (let guard = 0; guard < 6 && countFor(lo, hi, step) < 2; guard++) {
    const e = Math.floor(Math.log10(step) + 1e-9);
    const m = Math.round(step / 10 ** e);
    step = (m === 1 ? 0.5 : m === 2 ? 1 : 2) * 10 ** e;
  }
  if (countFor(lo, hi, step) < 4) {
    const e = Math.floor(Math.log10(step) + 1e-9);
    const quarter = 2.5 * 10 ** (Math.abs(step / 10 ** e - 5) < 1e-9 ? e : e - 1);
    if (quarter < step && countFor(lo, hi, quarter) <= limit && countFor(lo, hi, quarter) >= 4) {
      step = quarter;
    }
  }
  const major = ticksForStep(lo, hi, step);
  return { major, minor: minorTicks(lo, hi, step), step };
}

/** Minor subdivisions as matplotlib's AutoMinorLocator: 5 for steps 1/2.5/5, 4 for 2. */
export function minorDivisions(step: number): number {
  const m = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
  return Math.abs(m - 2) < 1e-6 ? 4 : 5;
}

export function minorTicks(min: number, max: number, step: number): number[] {
  const n = minorDivisions(step);
  const ms = step / n;
  return ticksForStep(min, max, ms).filter(v => {
    const r = v / step;
    return Math.abs(r - Math.round(r)) > 1e-6;
  });
}

/** Log10 ticks: decades (every k-th when many), minors at 2…9 × decade. Short ranges get 1-2-5 majors. */
export function logTicks(min: number, max: number, target = 6): Ticks {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (!(lo > 0) || !(hi > lo)) {
    return { major: lo > 0 ? [lo] : [], minor: [], step: 1 };
  }
  const e0 = Math.floor(Math.log10(lo) + 1e-9);
  const e1 = Math.ceil(Math.log10(hi) - 1e-9);
  const decades = e1 - e0;
  const inRange = (v: number) => v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9);
  if (decades <= 1 || Math.log10(hi / lo) < 1.2) {
    // less than ~a decade: 1, 2, 5 × 10^k, or linear ticks if that gives too few
    const major: number[] = [];
    const minor: number[] = [];
    for (let e = e0; e <= e1; e++) {
      for (let m = 1; m <= 9; m++) {
        const v = Number((m * 10 ** e).toPrecision(12));
        if (!inRange(v)) {
          continue;
        }
        (m === 1 || m === 2 || m === 5 ? major : minor).push(v);
      }
    }
    if (major.length >= 3) {
      return { major, minor, step: 1 };
    }
    // few ticks: linear steps bunch up at the top of a log axis
    const lin = linearTicks(lo, hi, Math.min(target, 4));
    return lin;
  }
  const every = Math.max(1, Math.ceil(decades / Math.max(1, target)));
  const major: number[] = [];
  const minor: number[] = [];
  for (let e = e0; e <= e1; e++) {
    const v = Number((10 ** e).toPrecision(12));
    if (e % every === 0 && inRange(v)) {
      major.push(v);
    } else if (inRange(v)) {
      minor.push(v);
    }
    if (every === 1 && decades <= 10) {
      for (let m = 2; m <= 9; m++) {
        const w = Number((m * 10 ** e).toPrecision(12));
        if (inRange(w)) {
          minor.push(w);
        }
      }
    }
  }
  return { major, minor, step: every };
}

export function ticksFor(min: number, max: number, log: boolean, target: number): Ticks {
  return log ? logTicks(min, max, target) : linearTicks(min, max, target);
}

// --- auto limits -----------------------------------------------------------------

export interface AutoDomainOptions {
  /** Include zero; when all data ≥ 0 the domain starts exactly at 0. */
  zero?: boolean;
  log?: boolean;
  /** Fractional margin on each side (default 0.05). */
  margin?: number;
  /** Margin at the low/high end overriding `margin`. */
  marginLo?: number;
  marginHi?: number;
}

/** Limits from the data range with a small margin (see AxisSpec.min/max/zero). */
export function autoDomain(lo: number, hi: number, o: AutoDomainOptions = {}): [number, number] {
  const m = o.margin ?? 0.05;
  const mLo = o.marginLo ?? m;
  const mHi = o.marginHi ?? m;
  if (o.log) {
    if (!(hi > 0) || !Number.isFinite(hi)) {
      return [1, 10];
    }
    if (!(lo > 0) || !Number.isFinite(lo)) {
      lo = hi / 100;
    }
    let a = Math.log10(lo);
    let b = Math.log10(hi);
    if (b - a < 1e-9) {
      a -= 0.5;
      b += 0.5;
    }
    const s = b - a;
    return [10 ** (a - mLo * s), 10 ** (b + mHi * s)];
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return [0, 1];
  }
  if (o.zero) {
    if (lo >= 0) {
      if (hi === 0) {
        return [0, 1];
      }
      return [0, hi + mHi * hi];
    }
    if (hi <= 0) {
      return [lo + mLo * lo, 0];
    }
  }
  if (hi - lo <= Math.abs(hi) * 1e-12) {
    const d = Math.abs(hi) * 0.05 || 1;
    return [lo - d, hi + d];
  }
  const s = hi - lo;
  return [lo - mLo * s, hi + mHi * s];
}

// --- secondary axis ------------------------------------------------------------------

export interface SecondaryTick {
  /** Value in the secondary unit (label). */
  value: number;
  /** Position in the primary unit. */
  at: number;
}

/**
 * Ticks of a secondary axis (eV above nm): nice ticks in the secondary unit,
 * placed at fromSecondary(value) — non-linear when the mapping is.
 */
export function secondaryTicks(d0: number, d1: number, toSecondary: (v: number) => number, fromSecondary: (v: number) => number, target = 5, explicit?: number[]): { major: SecondaryTick[]; minor: number[]; step: number } {
  const s0 = toSecondary(d0);
  const s1 = toSecondary(d1);
  const lo = Math.min(s0, s1);
  const hi = Math.max(s0, s1);
  const pLo = Math.min(d0, d1);
  const pHi = Math.max(d0, d1);
  const inside = (p: number) => Number.isFinite(p) && p >= pLo - 1e-9 * (pHi - pLo) && p <= pHi + 1e-9 * (pHi - pLo);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { major: [], minor: [], step: 1 };
  }
  const t = explicit ? { major: explicit, minor: [], step: explicit.length > 1 ? Math.abs(explicit[1] - explicit[0]) : 1 } : linearTicks(lo, hi, target);
  return {
    major: t.major.map(value => ({ value, at: fromSecondary(value) })).filter(m => inside(m.at)),
    minor: t.minor.map(v => fromSecondary(v)).filter(inside),
    step: t.step
  };
}
