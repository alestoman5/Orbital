// Tick-label and value formatting. Labels may contain ^{…} markup (rendered by
// text.ts); readouts use Unicode superscripts. Negative numbers use the real
// minus sign U+2212. DOM-free.

export const MINUS = '−';

const SUP: Record<string, string> = { '-': '⁻', '−': '⁻', '+': '⁺', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

export function unicodeSuperscript(s: string): string {
  return [...s].map(c => SUP[c] ?? c).join('');
}

/** Replace the ASCII hyphen of negative numbers by U+2212. */
export function withMinus(s: string): string {
  return s.replace(/^-/, MINUS).replace(/e-/, `e${MINUS}`);
}

/** Decimals needed to show multiples of `step` exactly (0.25 -> 2, 50 -> 0). */
export function decimalsFor(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) {
    return 0;
  }
  let d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  while (d < 12 && Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) > 1e-6 * step * 10 ** d) {
    d++;
  }
  return d;
}

/** Fixed-decimal number with U+2212 and no negative zero. */
export function fixed(v: number, decimals: number): string {
  let s = v.toFixed(decimals);
  if (/^-0(\.0*)?$/.test(s)) {
    s = s.slice(1);
  }
  return withMinus(s);
}

export interface TickLabels {
  labels: string[];
  /** Values are shown divided by 10^exponent (0 = no factor). */
  exponent: number;
}

/** Use a ×10ⁿ factor when the largest tick is ≥ 1e5 or < 1e-3. */
export function needsFactor(maxAbs: number): boolean {
  return maxAbs > 0 && (maxAbs >= 1e5 || maxAbs < 1e-3);
}

/**
 * Labels for linear ticks: the shortest clean decimal; for very large/small
 * ranges the mantissas (0, 2, 4 …) plus a common exponent (×10⁻¹⁸).
 */
export function formatLinearTicks(ticks: number[], step?: number): TickLabels {
  if (!ticks.length) {
    return { labels: [], exponent: 0 };
  }
  const st = step ?? (ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : Math.abs(ticks[0]) || 1);
  const maxAbs = Math.max(st, ...ticks.map(Math.abs));
  let exponent = 0;
  if (needsFactor(maxAbs)) {
    exponent = Math.floor(Math.log10(st) + 1e-9);
    if (maxAbs / 10 ** exponent >= 100) {
      exponent += 1;
    }
  }
  const scale = 10 ** exponent;
  const d = decimalsFor(st / scale);
  return { labels: ticks.map(t => fixed(t / scale, d)), exponent };
}

/** Labels for log ticks: plain numbers for 0.01…10⁴, else 10^{n} markup. */
export function formatLogTicks(ticks: number[]): TickLabels {
  if (!ticks.length) {
    return { labels: [], exponent: 0 };
  }
  const min = Math.min(...ticks);
  const max = Math.max(...ticks);
  const plain = min >= 0.01 && max <= 1e4;
  return {
    exponent: 0,
    labels: ticks.map(t => {
      if (plain) {
        return withMinus(String(Number(t.toPrecision(6))));
      }
      const e = Math.log10(t);
      if (Math.abs(e - Math.round(e)) < 1e-9) {
        return `10^{${withMinus(String(Math.round(e)))}}`;
      }
      const ex = Math.floor(e + 1e-9);
      const m = Number((t / 10 ** ex).toPrecision(3));
      return `${m}×10^{${withMinus(String(ex))}}`;
    })
  };
}

/** "10^{−18}" markup for a factor exponent. */
export function factorMarkup(exponent: number): string {
  return `10^{${withMinus(String(exponent))}}`;
}

/**
 * Put the factor into a "quantity / unit" label: "σ / cm^{2}" -> "σ / 10^{−18} cm^{2}"
 * (IUPAC quantity calculus). Returns undefined when the label has no " / ".
 */
export function labelWithFactor(label: string, exponent: number): string | undefined {
  const i = label.indexOf(' / ');
  if (i < 0) {
    return undefined;
  }
  return `${label.slice(0, i + 3)}${factorMarkup(exponent)} ${label.slice(i + 3)}`;
}

/** Readout value with `sig` significant digits; ×10ⁿ (Unicode) for tiny/huge values. */
export function formatValue(v: number, sig = 4): string {
  if (!Number.isFinite(v)) {
    return '–';
  }
  if (v === 0) {
    return '0';
  }
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) {
    const [m, e] = v.toExponential(sig - 1).split('e');
    const mant = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m;
    return `${withMinus(mant)}×10${unicodeSuperscript(String(Number(e)))}`;
  }
  let s = v.toPrecision(sig);
  if (s.includes('e')) {
    s = String(Number(s));
  }
  if (s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return withMinus(s);
}

/** Short value for annotations (heatmap cells): 3 significant digits. */
export function formatShort(v: number): string {
  return formatValue(v, 3);
}
