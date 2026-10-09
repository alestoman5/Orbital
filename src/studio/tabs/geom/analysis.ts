// Pure helpers of the geom tab host: coordinate labels, bonds and a 2D
// projection for the molecule sketch, min/max decimation, drift statistics
// of MD column files, file labels and exclude globs. No `vscode`, no fs.

import { canonicalSymbol } from '../../../chem/elements';
import { WatchedCoordinate } from '../../../chem/geometry';
import { linearFit } from '../../../chem/datFile';
import { meanWithError } from '../../../chem/xyzTrajectory';
import type { CoordInfo, DatStats, MoleculeAtom } from './types';

// --- coordinates -----------------------------------------------------------------

/** Atom names like "O2" from 1-based indices and the element sequence (just "2" without symbols). */
function atomName(i: number, symbols?: string[]): string {
  const s = symbols?.[i - 1];
  return s ? `${canonicalSymbol(s)}${i}` : String(i);
}

/** Display info of a watched coordinate: kind, unit, "r(O2–O3)" and the axis label "r(O2–O3) / Å". */
export function coordInfo(c: WatchedCoordinate, spec: string, symbols?: string[]): CoordInfo {
  const kind = c.atoms.length === 2 ? 'bond' : c.atoms.length === 3 ? 'angle' : 'dihedral';
  const unit = kind === 'bond' ? 'Å' : '°';
  const sym = kind === 'bond' ? 'r' : kind === 'angle' ? '∠' : 'φ';
  const name = `${sym}(${c.atoms.map(i => atomName(i, symbols)).join('–')})`;
  return { spec, label: c.label, atoms: c.atoms, kind, unit, name, axis: `${name} / ${unit}` };
}

/** Default label for picked atoms, e.g. "O2–O3". */
export function autoLabel(atoms: number[], symbols?: string[]): string {
  return atoms.map(i => atomName(i, symbols)).join('–');
}

// --- molecule sketch ---------------------------------------------------------------

/** Covalent radii in Å (Cordero et al. 2008), H–Xe; others 1.5 Å. */
const COVALENT: Record<string, number> = {
  H: 0.31, He: 0.28, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66, F: 0.57, Ne: 0.58,
  Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, Ar: 1.06,
  K: 2.03, Ca: 1.76, Sc: 1.7, Ti: 1.6, V: 1.53, Cr: 1.39, Mn: 1.39, Fe: 1.32, Co: 1.26, Ni: 1.24, Cu: 1.32, Zn: 1.22,
  Ga: 1.22, Ge: 1.2, As: 1.19, Se: 1.2, Br: 1.2, Kr: 1.16,
  Rb: 2.2, Sr: 1.95, Y: 1.9, Zr: 1.75, Nb: 1.64, Mo: 1.54, Tc: 1.47, Ru: 1.46, Rh: 1.42, Pd: 1.39, Ag: 1.45, Cd: 1.44,
  In: 1.42, Sn: 1.39, Sb: 1.39, Te: 1.38, I: 1.39, Xe: 1.4
};

export function covalentRadius(symbol: string): number {
  return COVALENT[canonicalSymbol(symbol)] ?? 1.5;
}

interface Xyz {
  symbol: string;
  x: number;
  y: number;
  z: number;
}

/** Bonds where d < r_i + r_j + 0.45 Å (the usual covalent-radius rule). O(n²), fine for sketch-sized molecules. */
export function inferBonds(atoms: Xyz[], tolerance = 0.45): [number, number][] {
  const out: [number, number][] = [];
  const r = atoms.map(a => covalentRadius(a.symbol));
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const d = Math.hypot(atoms[i].x - atoms[j].x, atoms[i].y - atoms[j].y, atoms[i].z - atoms[j].z);
      if (d > 0.1 && d < r[i] + r[j] + tolerance) {
        out.push([i + 1, j + 1]);
      }
    }
  }
  return out;
}

/** Eigenvectors (columns, by descending eigenvalue) of a symmetric 3×3 matrix, cyclic Jacobi. */
function eigenSym3(m: number[][]): { values: number[]; vectors: number[][] } {
  const a = m.map(r => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-20) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  return { values: order.map(i => a[i][i]), vectors: order.map(i => [v[0][i], v[1][i], v[2][i]]) };
}

/**
 * Atoms of the sketch: positions projected onto the two largest principal
 * axes (so a planar molecule is seen face-on), depth along the third.
 */
export function sketchAtoms(atoms: Xyz[]): MoleculeAtom[] {
  const n = atoms.length || 1;
  const c = [0, 0, 0];
  atoms.forEach(a => { c[0] += a.x / n; c[1] += a.y / n; c[2] += a.z / n; });
  const d = atoms.map(a => [a.x - c[0], a.y - c[1], a.z - c[2]]);
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  d.forEach(p => { for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += p[i] * p[j]; });
  const { vectors } = eigenSym3(cov);
  const dotv = (p: number[], v: number[]) => p[0] * v[0] + p[1] * v[1] + p[2] * v[2];
  return atoms.map((a, i) => ({
    index: i + 1,
    symbol: a.symbol,
    x: a.x,
    y: a.y,
    z: a.z,
    px: dotv(d[i], vectors[0]),
    py: dotv(d[i], vectors[1]),
    depth: dotv(d[i], vectors[2]),
    radius: covalentRadius(a.symbol)
  }));
}

// --- decimation --------------------------------------------------------------------

/**
 * Min/max decimation of points i0..i1-1: at most maxPoints points, keeping
 * the extremes of each bucket in their original order (spikes survive).
 * Returns all points when they fit.
 */
export function decimateMinMax(x: ArrayLike<number>, y: ArrayLike<number>, i0: number, i1: number, maxPoints: number): { x: number[]; y: number[] } {
  const n = i1 - i0;
  const ox: number[] = [];
  const oy: number[] = [];
  if (n <= maxPoints) {
    for (let i = i0; i < i1; i++) {
      ox.push(x[i]);
      oy.push(y[i]);
    }
    return { x: ox, y: oy };
  }
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  for (let b = 0; b < buckets; b++) {
    const s = i0 + Math.floor((b * n) / buckets);
    const e = i0 + Math.floor(((b + 1) * n) / buckets);
    let lo = -1;
    let hi = -1;
    for (let i = s; i < e; i++) {
      const v = y[i];
      if (!Number.isFinite(v)) continue;
      if (lo < 0 || v < y[lo]) lo = i;
      if (hi < 0 || v > y[hi]) hi = i;
    }
    if (lo < 0) continue;
    const [a, c] = lo <= hi ? [lo, hi] : [hi, lo];
    ox.push(x[a]);
    oy.push(y[a]);
    if (c !== a) {
      ox.push(x[c]);
      oy.push(y[c]);
    }
  }
  return { x: ox, y: oy };
}

/** First index with x[i] >= v (x ascending). */
export function lowerBound(x: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = x.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (x[m] < v) lo = m + 1; else hi = m;
  }
  return lo;
}

// --- MD column files -----------------------------------------------------------------

/** "Time[fs]" → true; slopes of such files are reported per ps. */
export function isFs(name: string): boolean {
  return /fs/i.test(name);
}

const KNOWN_AXES: [RegExp, string][] = [
  [/^time\s*\[?\(?fs\)?\]?$/i, 't / fs'],
  [/^time\s*\[?\(?ps\)?\]?$/i, 't / ps'],
  [/^temperature$/i, 'T / K'],
  [/^t-average$/i, '⟨T⟩ / K']
];

/** Axis label from a column name: "Time[fs]" → "t / fs", "E-pot[eV]" → "E-pot / eV", others unchanged. */
export function axisFromName(name: string): string {
  for (const [re, label] of KNOWN_AXES) {
    if (re.test(name.trim())) return label;
  }
  const m = /^(.*?)\s*[[(]([^\])]+)[\])]\s*$/.exec(name);
  return m && m[1] ? `${m[1]} / ${m[2]}` : name;
}

/**
 * Drift statistics of rows i0..i1-1: least-squares slope (×1000 = per ps
 * when x is in fs, as the old .dat plot), end − start, mean ± sd (ddof 1),
 * min/max, τ_int and the τ-corrected standard error.
 */
export function datStats(x: number[], y: number[], i0: number, i1: number, xName: string): DatStats {
  const fs = isFs(xName);
  const fit = linearFit(x, y, i0, i1);
  const seg = y.slice(i0, i1);
  let min = Infinity;
  let max = -Infinity;
  for (const v of seg) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const n = seg.length;
  const e = n >= 2 ? meanWithError(seg) : { mean: n ? seg[0] : NaN, sd: NaN, tau: NaN, se: NaN };
  const xUnit = /\[([^\]]+)\]/.exec(xName)?.[1] ?? xName;
  return {
    n,
    slope: fs ? fit.slope * 1000 : fit.slope,
    slopeUnit: fs ? 'ps' : xUnit,
    slopeX: fit.slope,
    intercept: fit.intercept,
    delta: n ? seg[n - 1] - seg[0] : NaN,
    mean: e.mean,
    sd: e.sd,
    min: n ? min : NaN,
    max: n ? max : NaN,
    tau: e.tau,
    sem: e.se
  };
}

/** Median of successive differences (the time step), 0 for fewer than two rows. */
export function medianStep(x: number[]): number {
  if (x.length < 2) return 0;
  const n = Math.min(x.length - 1, 2001);
  const d: number[] = [];
  for (let i = 0; i < n; i++) d.push(x[i + 1] - x[i]);
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

// --- files ---------------------------------------------------------------------------

/** Shortest unique path suffixes ("CMD_PBEPBE/geoms.xyz"), at least the file name. */
export function shortLabels(paths: string[]): string[] {
  const parts = paths.map(p => p.replace(/\\/g, '/').split('/').filter(Boolean));
  const depth = parts.map(() => 1);
  const label = (i: number) => parts[i].slice(-depth[i]).join('/');
  for (let round = 0; round < 32; round++) {
    const seen = new Map<string, number[]>();
    parts.forEach((_, i) => {
      const l = label(i);
      seen.set(l, [...(seen.get(l) ?? []), i]);
    });
    let changed = false;
    for (const idx of seen.values()) {
      if (idx.length < 2) continue;
      for (const i of idx) {
        if (depth[i] < parts[i].length) {
          depth[i]++;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return parts.map((_, i) => label(i));
}

/** "a/{b,c}/d" → ["a/b/d", "a/c/d"] (all brace groups, not nested). */
export function expandBraces(glob: string): string[] {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  const head = glob.slice(0, m.index);
  const tail = glob.slice(m.index + m[0].length);
  return m[1].split(',').flatMap(alt => expandBraces(head + alt + tail));
}

/** One brace glob for FindFilesOptions.exclude from several (brace) globs: "{a,b,c}". */
export function combineGlobs(globs: string[]): string | undefined {
  const all = [...new Set(globs.flatMap(expandBraces).map(g => g.trim()).filter(Boolean))];
  return all.length === 0 ? undefined : all.length === 1 ? all[0] : `{${all.join(',')}}`;
}

/** RegExp for a path glob (*, **, ?, {a,b}); matched against '/'-separated relative paths. */
export function globToRegExp(glob: string): RegExp {
  const alts = expandBraces(glob).map(g => {
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const ch = g[i];
      if (ch === '*') {
        if (g[i + 1] === '*') {
          i++;
          if (g[i + 1] === '/') {
            i++;
            re += '(?:.*/)?';
          } else {
            re += '.*';
          }
        } else {
          re += '[^/]*';
        }
      } else if (ch === '?') {
        re += '[^/]';
      } else {
        re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
      }
    }
    return re;
  });
  return new RegExp(`^(?:${alts.join('|')})$`);
}
