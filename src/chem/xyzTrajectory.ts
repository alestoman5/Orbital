// Multi-XYZ trajectories and ensembles (MD geoms.xyz / movie.xyz, Wigner
// samples): a streaming frame reader that never holds the file as one
// string (10⁵ frames are tens of MB), watched internal coordinates per
// frame, frame counting, and the statistics the geometry views need —
// numpy-style histograms, Gaussian KDE (scipy.stats.gaussian_kde
// bandwidths), 2D histograms, summaries, and the integrated
// autocorrelation time / standard error of uv-vis scripts/spectra.py
// (autocorr_time, mean_with_error). Generalizes uv-vis
// 01-ground-state-sampling/plot_histograms.py (read_frames, metrics) to any
// molecule and coordinate. Pure Node (fs), no `vscode` import.

import * as fs from 'fs';
import { canonicalSymbol } from './elements';
import { WatchedCoordinate, measure } from './geometry';
import { GeometryAtom } from '../outparser/types';

const CHUNK = 1 << 20;

/**
 * Calls onLine(buf, start, end) for every line of the file (without the
 * line break; a trailing \r is excluded too). Reads in 1 MB chunks; a line
 * spanning chunks is passed from a small joined buffer. Return false from
 * onLine to stop. Splitting on byte 0x0A is safe for UTF-8.
 */
function forEachLine(
  file: string,
  onLine: (buf: Buffer, start: number, end: number) => boolean | void,
  onProgress?: (bytesRead: number, totalBytes: number) => void
): void {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry: Buffer | undefined;
    let pos = 0;
    const emit = (b: Buffer, s: number, e: number) => onLine(b, s, e > s && b[e - 1] === 13 ? e - 1 : e) !== false;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n === 0) break;
      pos += n;
      const data = buf.subarray(0, n);
      let start = 0;
      let nl = data.indexOf(10, 0);
      if (carry) {
        if (nl < 0) {
          carry = Buffer.concat([carry, data]);
          onProgress?.(pos, size);
          continue;
        }
        const joined = Buffer.concat([carry, data.subarray(0, nl)]);
        carry = undefined;
        if (!emit(joined, 0, joined.length)) return;
        start = nl + 1;
        nl = data.indexOf(10, start);
      }
      while (nl >= 0) {
        if (!emit(data, start, nl)) return;
        start = nl + 1;
        nl = data.indexOf(10, start);
      }
      if (start < n) carry = Buffer.from(data.subarray(start, n));
      onProgress?.(pos, size);
    }
    if (carry && carry.length) emit(carry, 0, carry.length);
  } finally {
    fs.closeSync(fd);
  }
}

/** Positive integer atom count of a count line, or undefined (blank lines give NaN). */
function parseCount(buf: Buffer, s: number, e: number): number {
  const t = buf.toString('latin1', s, e).trim();
  return t === '' ? NaN : /^\d+$/.test(t) ? parseInt(t, 10) : -1;
}

function parseAtomLine(line: string): GeometryAtom | undefined {
  const f = line.trim().split(/\s+/);
  if (f.length < 4) return undefined;
  const x = Number(f[1]);
  const y = Number(f[2]);
  const z = Number(f[3]);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { symbol: f[0], x, y, z } : undefined;
}

interface FrameEvents {
  /** Frame i is complete. `lines` holds the atom lines only when wantAtoms(i) was true. Return false to stop. */
  frame(i: number, natoms: number, comment: string, lines: string[] | undefined): boolean | void;
  wantAtoms(i: number): boolean;
}

interface FrameWalk {
  nFrames: number;
  /** A count line that is not a positive integer stopped the scan (0-based line number). */
  stoppedAtLine?: number;
  /** The file ends inside a frame (a trajectory still being written). */
  incompleteTail: boolean;
  stopped: boolean;
}

/**
 * Frame state machine over forEachLine. Blank lines between frames are
 * tolerated; a non-integer count line ends the scan (as countXyzFrames in
 * neaRun.ts). Atom lines are decoded only for frames the caller wants.
 */
function walkFrames(file: string, ev: FrameEvents, onProgress?: (read: number, total: number) => void): FrameWalk {
  let lineNo = -1;
  let natoms = 0;
  let need = 0; // remaining atom lines of the current frame
  let inFrame = false;
  let haveComment = false;
  let comment = '';
  let lines: string[] | undefined;
  let nFrames = 0;
  let stoppedAtLine: number | undefined;
  let stopped = false;
  forEachLine(file, (buf, s, e) => {
    lineNo++;
    if (!inFrame) {
      const c = parseCount(buf, s, e);
      if (Number.isNaN(c)) return true;
      if (c <= 0) {
        stoppedAtLine = lineNo;
        return false;
      }
      natoms = c;
      need = c;
      inFrame = true;
      haveComment = false;
      lines = ev.wantAtoms(nFrames) ? [] : undefined;
      return true;
    }
    if (!haveComment) {
      haveComment = true;
      comment = lines ? buf.toString('utf8', s, e) : '';
    } else {
      if (lines) lines.push(buf.toString('latin1', s, e));
      need--;
    }
    if (haveComment && need === 0) {
      inFrame = false;
      const i = nFrames++;
      if (ev.frame(i, natoms, comment, lines) === false) {
        stopped = true;
        return false;
      }
    }
    return true;
  }, onProgress);
  return { nFrames, stoppedAtLine, incompleteTail: inFrame, stopped };
}

export interface XyzFrame {
  natoms: number;
  symbols: string[];
  atoms: GeometryAtom[];
  comment: string;
}

/** First frame of a (multi-)XYZ file; throws when the file has no complete frame. */
export function readFirstFrame(file: string): XyzFrame {
  let out: XyzFrame | undefined;
  walkFrames(file, {
    wantAtoms: () => true,
    frame: (_i, natoms, comment, lines) => {
      const atoms = (lines ?? []).map(parseAtomLine);
      if (atoms.some(a => a === undefined)) {
        throw new Error(`${file}: malformed atom line in the first frame.`);
      }
      const ok = atoms as GeometryAtom[];
      out = { natoms, symbols: ok.map(a => a.symbol), atoms: ok, comment };
      return false;
    }
  });
  if (!out) {
    throw new Error(`${file}: no complete XYZ frame (count line, comment line, atoms).`);
  }
  return out;
}

/** Number of complete frames; decodes only the count lines. */
export function countFrames(file: string): number {
  return walkFrames(file, { wantAtoms: () => false, frame: () => true }).nFrames;
}

export interface ScanOptions {
  /** Use every stride-th frame (frames 0, stride, 2·stride, …). Default 1. */
  stride?: number;
  /** Stop after this many sampled frames. */
  maxFrames?: number;
  /** Called after every 1 MB chunk. */
  onProgress?: (bytesRead: number, totalBytes: number) => void;
  /** Number of comment lines of sampled frames to return (default 5). */
  sampleComments?: number;
}

export interface TrajectoryScan {
  /** Frames read from the file (all of them unless maxFrames stopped the scan). */
  nFrames: number;
  /** Frames measured (values[k].length). */
  nSampled: number;
  stride: number;
  /** Element symbols of the first frame. */
  symbols: string[];
  /** values[k][j] = coords[k] in sampled frame j (Å or degrees); NaN when an index is out of range or the frame is malformed. */
  values: Float64Array[];
  /** Sampled frames whose element sequence differs from the first frame (their values are still measured). */
  orderMismatches: number;
  /** 0-based file frame index of the first such frame. */
  firstMismatchFrame?: number;
  /** Sampled frames with unparseable atom lines. */
  malformedFrames: number;
  /** maxFrames stopped the scan before the end of the file. */
  truncated: boolean;
  /** The file ends inside a frame (still being written). */
  incompleteTail: boolean;
  /** A count line that is not a positive integer ended the scan (0-based line). */
  stoppedAtLine?: number;
  /** Comment lines of the first sampled frames. */
  comments: string[];
}

class Growable {
  private a = new Float64Array(1024);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done(): Float64Array {
    return this.a.slice(0, this.n);
  }
}

/**
 * Streams a multi-XYZ file and measures the watched coordinates (measure()
 * from geometry.ts) in every stride-th frame. Each sampled frame's element
 * sequence is compared with the first frame (labels normalized, "C1" =
 * "C"); mismatches are counted, not skipped, so the caller can warn that
 * the indices may point at different atoms. Memory is one Float64Array per
 * coordinate plus a 1 MB read buffer.
 */
export function scanTrajectory(file: string, coords: WatchedCoordinate[], options: ScanOptions = {}): TrajectoryScan {
  const stride = Math.max(1, Math.floor(options.stride ?? 1));
  const maxFrames = options.maxFrames ?? Infinity;
  const nComments = options.sampleComments ?? 5;
  const cols = coords.map(() => new Growable());
  const comments: string[] = [];
  let ref: string[] | undefined;
  let refCanon: string[] = [];
  let symbols: string[] = [];
  let mismatches = 0;
  let firstMismatch: number | undefined;
  let malformed = 0;
  let sampled = 0;
  let truncated = false;
  let full = false;
  const walk = walkFrames(file, {
    wantAtoms: i => i % stride === 0 && !full,
    frame: (i, _natoms, comment, lines) => {
      if (full) {
        // one more complete frame exists after the last sampled one
        truncated = true;
        return false;
      }
      if (!lines) return true;
      const parsed = lines.map(parseAtomLine);
      const bad = parsed.some(a => a === undefined);
      const atoms = parsed.filter((a): a is GeometryAtom => a !== undefined);
      if (bad) malformed++;
      if (!ref) {
        ref = atoms.map(a => a.symbol);
        symbols = ref;
        refCanon = ref.map(canonicalSymbol);
      } else {
        let same = atoms.length === ref.length;
        for (let k = 0; same && k < atoms.length; k++) {
          same = atoms[k].symbol === ref[k] || canonicalSymbol(atoms[k].symbol) === refCanon[k];
        }
        if (!same) {
          mismatches++;
          if (firstMismatch === undefined) firstMismatch = i;
        }
      }
      for (let k = 0; k < coords.length; k++) {
        cols[k].push(bad ? NaN : measure(atoms, coords[k]) ?? NaN);
      }
      if (comments.length < nComments) comments.push(comment);
      sampled++;
      full = sampled >= maxFrames;
      return true;
    }
  }, options.onProgress);
  return {
    nFrames: truncated ? walk.nFrames - 1 : walk.nFrames,
    nSampled: sampled,
    stride,
    symbols,
    values: cols.map(c => c.done()),
    orderMismatches: mismatches,
    firstMismatchFrame: firstMismatch,
    malformedFrames: malformed,
    truncated,
    incompleteTail: walk.incompleteTail && !truncated,
    stoppedAtLine: walk.stoppedAtLine,
    comments
  };
}

/**
 * LRU cache of scanTrajectory results keyed by (path, mtimeMs, size,
 * coordinates, stride, maxFrames). A changed file (new mtime or size) is
 * rescanned.
 */
export class TrajectoryCache {
  private readonly entries = new Map<string, TrajectoryScan>();
  constructor(private readonly maxEntries = 4) {}

  scan(file: string, coords: WatchedCoordinate[], options: ScanOptions = {}): TrajectoryScan {
    const st = fs.statSync(file);
    const key = JSON.stringify([file, st.mtimeMs, st.size, coords.map(c => c.atoms), options.stride ?? 1, options.maxFrames ?? null, options.sampleComments ?? 5]);
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const result = scanTrajectory(file, coords, options);
    this.entries.set(key, result);
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
    return result;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------- statistics

type Num = ArrayLike<number>;

function finite(values: Num): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) out.push(values[i]);
  return out;
}

function minMax(values: Num): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** numpy edges: linspace(lo, hi, bins+1); a zero-width range becomes (lo-0.5, hi+0.5). */
function edgesFor(lo: number, hi: number, bins: number): number[] {
  if (!(Number.isFinite(lo) && Number.isFinite(hi))) {
    lo = 0;
    hi = 1;
  }
  if (lo === hi) {
    lo -= 0.5;
    hi += 0.5;
  }
  const n = Math.max(1, Math.floor(bins));
  const step = (hi - lo) / n;
  const e = Array.from({ length: n + 1 }, (_, i) => lo + i * step);
  e[n] = hi;
  return e;
}

/** Bin of v for ascending edges (right-open, last bin closed), -1 outside. */
function binOf(v: number, edges: number[]): number {
  const n = edges.length - 1;
  if (!(v >= edges[0] && v <= edges[n])) return -1;
  if (v === edges[n]) return n - 1;
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (edges[mid] <= v) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * np.histogram(values, bins, range, density): equal-width bins over
 * `range` (default min..max of the finite values), last bin closed. With
 * density the values integrate to 1 (counts / (n_in_range · width)). NaN
 * values are ignored (numpy would raise). Explicit edges can be passed as
 * `edges` (e.g. from commonEdges).
 */
export function histogram(values: Num, options: { bins?: number; range?: [number, number]; density?: boolean; edges?: number[] } = {}): { edges: number[]; values: number[] } {
  const data = finite(values);
  const edges = options.edges ?? (options.range
    ? edgesFor(options.range[0], options.range[1], options.bins ?? 10)
    : edgesFor(...minMax(data), options.bins ?? 10));
  const counts = new Array<number>(edges.length - 1).fill(0);
  let total = 0;
  for (const v of data) {
    const b = binOf(v, edges);
    if (b >= 0) {
      counts[b]++;
      total++;
    }
  }
  if (options.density) {
    return { edges, values: counts.map((c, i) => (total ? c / (total * (edges[i + 1] - edges[i])) : 0)) };
  }
  return { edges, values: counts };
}

/** Shared edges over several arrays (plot_histograms.draw): linspace(min, max, bins+1). */
export function commonEdges(arrays: Num[], bins: number): number[] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of arrays) {
    const [l, h] = minMax(finite(a));
    lo = Math.min(lo, l);
    hi = Math.max(hi, h);
  }
  return edgesFor(lo, hi, bins);
}

/** Population mean and sample sd (ddof = 1). */
function meanSd(data: number[], ddof: number): [number, number] {
  const n = data.length;
  let m = 0;
  for (const v of data) m += v;
  m /= n;
  let s = 0;
  for (const v of data) s += (v - m) * (v - m);
  return [m, Math.sqrt(s / (n - ddof))];
}

/**
 * Bandwidth of scipy.stats.gaussian_kde for 1D data: factor · sd (ddof 1),
 * Scott n^(-1/5) or Silverman (3n/4)^(-1/5).
 */
export function kdeBandwidth(values: Num, rule: 'scott' | 'silverman' = 'scott'): number {
  const data = finite(values);
  const n = data.length;
  const sd = meanSd(data, 1)[1];
  const factor = rule === 'scott' ? Math.pow(n, -1 / 5) : Math.pow((n * 3) / 4, -1 / 5);
  return factor * sd;
}

/**
 * Gaussian KDE on `grid`, normalized to unit area (scipy.stats.gaussian_kde
 * with equal weights). `bandwidth` is an absolute width in data units, or
 * a rule ('scott' by default, as scipy). Points farther than 9 bandwidths
 * from a grid point are skipped (relative error < 1e-17), so 10⁵ samples
 * stay fast.
 */
export function kde(values: Num, grid: Num, bandwidth: number | 'scott' | 'silverman' = 'scott'): number[] {
  const data = finite(values).sort((a, b) => a - b);
  const n = data.length;
  const out = new Array<number>(grid.length).fill(0);
  if (n === 0) return out;
  const h = typeof bandwidth === 'number' ? bandwidth : kdeBandwidth(data, bandwidth);
  if (!(h > 0)) return out.fill(NaN);
  const norm = 1 / (n * h * Math.sqrt(2 * Math.PI));
  const cut = 9 * h;
  const lower = (t: number) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (data[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  for (let g = 0; g < grid.length; g++) {
    const x = grid[g];
    let s = 0;
    for (let i = lower(x - cut); i < n && data[i] <= x + cut; i++) {
      const u = (x - data[i]) / h;
      s += Math.exp(-0.5 * u * u);
    }
    out[g] = s * norm;
  }
  return out;
}

/**
 * np.histogram2d(a, b, [binsA, binsB]): counts[i][j] for a in bin i and b
 * in bin j, equal-width bins over each range (default min..max), last bins
 * closed. Pairs with a non-finite member are ignored.
 */
export function histogram2d(
  a: Num,
  b: Num,
  binsA: number,
  binsB: number,
  options: { rangeA?: [number, number]; rangeB?: [number, number]; density?: boolean } = {}
): { edgesA: number[]; edgesB: number[]; counts: number[][] } {
  const pa: number[] = [];
  const pb: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      pa.push(a[i]);
      pb.push(b[i]);
    }
  }
  const edgesA = options.rangeA ? edgesFor(...options.rangeA, binsA) : edgesFor(...minMax(pa), binsA);
  const edgesB = options.rangeB ? edgesFor(...options.rangeB, binsB) : edgesFor(...minMax(pb), binsB);
  const counts = Array.from({ length: edgesA.length - 1 }, () => new Array<number>(edgesB.length - 1).fill(0));
  let total = 0;
  for (let i = 0; i < pa.length; i++) {
    const ia = binOf(pa[i], edgesA);
    const ib = binOf(pb[i], edgesB);
    if (ia >= 0 && ib >= 0) {
      counts[ia][ib]++;
      total++;
    }
  }
  if (options.density && total) {
    for (let i = 0; i < counts.length; i++) {
      for (let j = 0; j < counts[i].length; j++) {
        counts[i][j] /= total * (edgesA[i + 1] - edgesA[i]) * (edgesB[j + 1] - edgesB[j]);
      }
    }
  }
  return { edgesA, edgesB, counts };
}

export interface Summary {
  n: number;
  mean: number;
  /** Population sd (numpy std, ddof 0), as plot_histograms.py reports. */
  sd: number;
  min: number;
  max: number;
  median: number;
}

/** Mean, population sd, min, max, median of the finite values. */
export function summary(values: Num): Summary {
  const data = finite(values);
  const n = data.length;
  if (n === 0) return { n: 0, mean: NaN, sd: NaN, min: NaN, max: NaN, median: NaN };
  const [mean, sd] = meanSd(data, 0);
  const s = data.slice().sort((x, y) => x - y);
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { n, mean, sd, min: s[0], max: s[n - 1], median };
}

/** In-place iterative radix-2 FFT (length a power of two); inverse without the 1/N factor. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        // recompute the twiddle every 64 steps to bound the drift
        if ((k & 63) === 63) {
          cr = Math.cos(ang * (k + 1));
          ci = Math.sin(ang * (k + 1));
        } else {
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = t;
        }
      }
    }
  }
}

/**
 * Port of autocorr_time: integrated autocorrelation time in samples,
 * Sokal's self-consistent window (c = 5) over the full ACF (negative lobes
 * included); 0.5 = uncorrelated. The ACF is the zero-padded FFT
 * autocorrelation (identical to numpy's rfft of length 2n up to rounding).
 * NaN for a constant series or n < 2, as the Python gives.
 */
export function autocorrelationTime(x: Num): number {
  const n = x.length;
  if (n < 2) return NaN;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let size = 1;
  while (size < 2 * n) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = x[i] - mean;
  fft(re, im, false);
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft(re, im, true);
  const acf0 = re[0] / size;
  let tau = 0.5;
  for (let m = 1; m < n; m++) {
    tau += re[m] / size / acf0;
    if (m >= 5 * tau) return Math.max(tau, 0.5);
  }
  return tau;
}

/** Port of mean_with_error: mean, sd (ddof 1), tau, SE = sd·sqrt(2 tau / n), n — in time order. */
export function meanWithError(x: Num): { mean: number; sd: number; tau: number; se: number; n: number } {
  const data = Array.from(x);
  const n = data.length;
  const [mean, sd] = meanSd(data, 1);
  const tau = autocorrelationTime(data);
  return { mean, sd, tau, se: sd * Math.sqrt((2 * tau) / n), n };
}
