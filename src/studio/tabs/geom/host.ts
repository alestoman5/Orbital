// Host side of the "geom" studio tab: the geometry library (multi-XYZ
// trajectories and ensembles), watched internal coordinates measured over
// every frame (histograms with common bins, KDE, traces, 2D histograms,
// τ-corrected summary statistics), and MD column files (.dat) with drift
// statistics of the visible range. Generalizes uv-vis webapp/v_geom.py and
// replaces the old .dat plot (src/features/mdPlot.ts). Never imports
// 'vscode' — everything goes through the HostContext.

import * as fs from 'fs';
import * as path from 'path';
import type { HostContext, TabHost } from '../../context';
import { isAllowedPath, isInside } from '../../paths';
import { parseDat, DatTable } from '../../../chem/datFile';
import { WatchedCoordinate, parseWatchSpec } from '../../../chem/geometry';
import {
  TrajectoryCache,
  TrajectoryScan,
  commonEdges,
  histogram,
  histogram2d,
  kde,
  meanWithError,
  readFirstFrame,
  scanTrajectory,
  summary
} from '../../../chem/xyzTrajectory';
import {
  axisFromName,
  combineGlobs,
  coordInfo,
  datStats,
  decimateMinMax,
  globToRegExp,
  inferBonds,
  isFs,
  lowerBound,
  medianStep,
  shortLabels,
  sketchAtoms
} from './analysis';
import type {
  CoordInfo,
  DatColumnView,
  DatInfo,
  DatViewParams,
  DatViewResult,
  DistParams,
  DistResult,
  FileScanInfo,
  Hist2dPlot,
  HistogramPlot,
  LibraryFile,
  ListResult,
  MoleculeResult,
  ParseParams,
  ParseResult,
  ProgressEvent,
  SummaryRow,
  TracePlot,
  XyzInfo
} from './types';

export const DEFAULTS = {
  geometryGlobs: ['**/*.xyz'],
  geometryExcludeGlobs: ['**/geom_*/**'],
  datGlobs: ['**/*.dat'],
  datExcludeGlobs: ['**/geom_*/**', '**/*.cross.dat', '**/*.molar.dat'],
  maxListedFiles: 2000
};

/** Above this many frames (at stride 1) the UI suggests a stride. */
export const STRIDE_HINT_FRAMES = 200_000;
/** Largest .dat file read (bytes). */
const MAX_DAT_BYTES = 512 * 1024 * 1024;

// ------------------------------------------------------------------ state

const trajectories = new TrajectoryCache(24);
const xyzInfoCache = new Map<string, { key: string; info: XyzInfo }>();
const datCache = new Map<string, { key: string; table: DatTable; monotonic: boolean; partialTail: boolean }>();
/** Files the user picked through the dialog (allowed even outside the workspace). */
const picked = new Set<string>();

/** Forget cached scans (tests). */
export function clearCaches(): void {
  trajectories.clear();
  xyzInfoCache.clear();
  datCache.clear();
  picked.clear();
}

// ------------------------------------------------------------------ validation

const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** Absolute path of an existing file inside a workspace folder (or picked by the user); throws otherwise. */
export function checkFile(p: unknown, ctx: HostContext): string {
  if (typeof p !== 'string' || p.trim() === '') {
    throw new Error('Expected a file path.');
  }
  const abs = path.resolve(p);
  if (!picked.has(norm(abs)) && !isAllowedPath(ctx, abs)) {
    throw new Error(`${p} is outside the workspace.`);
  }
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st?.isFile()) {
    throw new Error(`${p} does not exist.`);
  }
  return abs;
}

function stringList(v: unknown, what: string, max = 1000): string[] {
  if (!Array.isArray(v) || v.some(s => typeof s !== 'string')) {
    throw new Error(`${what}: expected a list of strings.`);
  }
  return (v as string[]).slice(0, max);
}

function int(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.max(lo, Math.min(hi, n));
}

function relTo(ctx: HostContext, p: string): string {
  const f = ctx.workspaceFolders().find(w => isInside(p, w));
  return f ? path.relative(f, p).replace(/\\/g, '/') : p;
}

// ------------------------------------------------------------------ library

async function listFiles(ctx: HostContext, includeKey: string, excludeKey: string, defInclude: string[], defExclude: string[], extra: string[]): Promise<ListResult> {
  const include = ctx.config<string[]>(`studio.${includeKey}`, defInclude);
  const exclude = ctx.config<string[]>(`studio.${excludeKey}`, defExclude);
  const base = ctx.config<string>('runs.exclude', '**/{node_modules,.git}/**');
  const excludeGlob = combineGlobs([base, ...exclude]);
  const excludeRe = exclude.map(globToRegExp);
  const max = DEFAULTS.maxListedFiles;
  const found = new Set<string>();
  let capped = false;
  for (const g of Array.isArray(include) ? include : defInclude) {
    const hits = await ctx.findFiles(g, { exclude: excludeGlob, max: max + 1 });
    for (const h of hits) {
      if (!excludeRe.some(re => re.test(relTo(ctx, h)))) {
        found.add(path.resolve(h));
      }
    }
    if (found.size > max) {
      capped = true;
      break;
    }
  }
  for (const e of extra) {
    try {
      found.add(checkFile(e, ctx));
    } catch {
      // stale entry (deleted or no longer in the workspace)
    }
  }
  const paths = [...found].slice(0, max + extra.length);
  const labels = shortLabels(paths);
  const files: LibraryFile[] = [];
  paths.forEach((p, i) => {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (st) {
      files.push({ path: p, label: labels[i], rel: relTo(ctx, p), size: st.size, mtimeMs: st.mtimeMs });
    }
  });
  return { files, capped };
}

const fileKey = (p: string) => {
  const st = fs.statSync(p);
  return `${st.mtimeMs}:${st.size}`;
};

/** Frames, atoms, element sequence and truncation of one XYZ file (one pass, cached by mtime/size). */
export function xyzInfoOf(p: string): XyzInfo {
  const key = fileKey(p);
  const hit = xyzInfoCache.get(p);
  if (hit && hit.key === key) {
    return hit.info;
  }
  let info: XyzInfo;
  try {
    const s = scanTrajectory(p, [], { stride: Number.MAX_SAFE_INTEGER, sampleComments: 0 });
    info = {
      path: p,
      frames: s.nFrames,
      atoms: s.symbols.length,
      symbols: s.symbols,
      incompleteTail: s.incompleteTail,
      stoppedAtLine: s.stoppedAtLine !== undefined ? s.stoppedAtLine + 1 : undefined,
      error: s.nFrames === 0 ? 'no complete XYZ frame' : undefined
    };
  } catch (e) {
    info = { path: p, frames: 0, atoms: 0, symbols: [], incompleteTail: false, error: e instanceof Error ? e.message : String(e) };
  }
  xyzInfoCache.set(p, { key, info });
  return info;
}

function loadDat(p: string): { table: DatTable; monotonic: boolean; partialTail: boolean } {
  const key = fileKey(p);
  const hit = datCache.get(p);
  if (hit && hit.key === key) {
    datCache.delete(p);
    datCache.set(p, hit);
    return hit;
  }
  if (fs.statSync(p).size > MAX_DAT_BYTES) {
    throw new Error(`${path.basename(p)} is larger than ${MAX_DAT_BYTES >> 20} MB.`);
  }
  let text = fs.readFileSync(p, 'utf8');
  // a file still being written (or cut off) ends inside a line: "-0.1" of "-0.1894E+03" would parse as a number
  const lastNl = text.lastIndexOf('\n');
  const partialTail = lastNl >= 0 && lastNl < text.length - 1 && text.slice(lastNl + 1).trim() !== '';
  if (partialTail) {
    text = text.slice(0, lastNl + 1);
  }
  const table = parseDat(text);
  const x = table.data[0] ?? [];
  let monotonic = true;
  for (let i = 1; i < x.length && monotonic; i++) {
    monotonic = x[i] >= x[i - 1];
  }
  const entry = { key, table, monotonic, partialTail };
  datCache.set(p, entry);
  while (datCache.size > 12) {
    datCache.delete(datCache.keys().next().value as string);
  }
  return entry;
}

export function datInfoOf(p: string): DatInfo {
  try {
    const { table, partialTail } = loadDat(p);
    const rows = table.data[0]?.length ?? 0;
    return { path: p, ok: table.columns.length >= 2 && rows >= 2, columns: table.columns, rows, skipped: table.skipped, partialTail };
  } catch (e) {
    return { path: p, ok: false, columns: [], rows: 0, skipped: 0, partialTail: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------ coordinates

function symbolsOf(file: string | undefined, ctx: HostContext): string[] | undefined {
  if (!file) return undefined;
  try {
    return xyzInfoOf(checkFile(file, ctx)).symbols;
  } catch {
    return undefined;
  }
}

export function parseCoords(specs: string[], symbols?: string[]): { coords: WatchedCoordinate[]; infos: CoordInfo[]; errors: string[] } {
  const coords: WatchedCoordinate[] = [];
  const infos: CoordInfo[] = [];
  const errors: string[] = [];
  for (const spec of specs) {
    const r = parseWatchSpec([spec]);
    if (r.coords.length) {
      coords.push(r.coords[0]);
      infos.push(coordInfo(r.coords[0], spec, symbols));
    } else {
      errors.push(...r.errors);
    }
  }
  return { coords, infos, errors };
}

// ------------------------------------------------------------------ distributions

const yieldLoop = () => new Promise<void>(r => setImmediate(r));

function finiteInOrder(v: Float64Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) if (Number.isFinite(v[i])) out.push(v[i]);
  return out;
}

async function distributions(p: DistParams, ctx: HostContext): Promise<DistResult> {
  const t0 = Date.now();
  const files = [...new Set(stringList(p?.files, 'files', 64).map(f => checkFile(f, ctx)))];
  const specs = stringList(p?.specs, 'specs', 64);
  const stride = int(p.stride, 1, 1, 1_000_000);
  const symbols = files.length ? xyzInfoOf(files[0]).symbols : undefined;
  const { coords, infos, errors } = parseCoords(specs, symbols);
  const labels = shortLabels(files);
  const result: DistResult = { coords: infos, errors, files: [], summary: [], ms: 0 };
  if (!files.length || !coords.length) {
    result.ms = Date.now() - t0;
    return result;
  }
  const scans: TrajectoryScan[] = [];
  for (let k = 0; k < files.length; k++) {
    const file = files[k];
    let last = -1;
    const progress = (fraction: number) => {
      const ev: ProgressEvent = { path: file, label: labels[k], fraction, index: k, count: files.length };
      ctx.post('progress', ev);
    };
    progress(0);
    await yieldLoop();
    const scan = trajectories.scan(file, coords, {
      stride,
      sampleComments: 0,
      onProgress: (read, total) => {
        const f = total ? read / total : 1;
        if (f - last >= 0.1) {
          last = f;
          progress(f);
        }
      }
    });
    progress(1);
    scans.push(scan);
    const maxIndex = Math.max(...coords.flatMap(c => c.atoms));
    result.files.push({
      path: file,
      label: labels[k],
      frames: scan.nFrames,
      sampled: scan.nSampled,
      stride: scan.stride,
      orderMismatches: scan.orderMismatches,
      firstMismatchFrame: scan.firstMismatchFrame,
      malformedFrames: scan.malformedFrames,
      incompleteTail: scan.incompleteTail,
      stoppedAtLine: scan.stoppedAtLine !== undefined ? scan.stoppedAtLine + 1 : undefined,
      outOfRange: maxIndex > scan.symbols.length,
      symbols: scan.symbols
    } satisfies FileScanInfo);
    if (stride === 1 && scan.nFrames > STRIDE_HINT_FRAMES) {
      result.suggestedStride = Math.max(result.suggestedStride ?? 1, Math.ceil(scan.nFrames / 100_000));
    }
  }
  for (let c = 0; c < coords.length; c++) {
    scans.forEach((s, k) => {
      const sm = summary(s.values[c]);
      const ordered = finiteInOrder(s.values[c]);
      const e = ordered.length >= 2 ? meanWithError(ordered) : { tau: NaN, se: NaN };
      result.summary.push({ path: files[k], label: labels[k], coord: c, n: sm.n, mean: sm.mean, sd: sm.sd, median: sm.median, min: sm.min, max: sm.max, tau: e.tau, sem: e.se } satisfies SummaryRow);
    });
  }
  const ci = int(p.coord, 0, 0, coords.length - 1);
  const bins = int(p.bins, 60, 2, 1000);
  if (p.mode === 'trace') {
    const maxPoints = int(p.maxPoints, 4000, 100, 100_000);
    const plot: TracePlot = { kind: 'trace', series: [] };
    scans.forEach((s, k) => {
      const v = s.values[ci];
      const x = Float64Array.from({ length: v.length }, (_, j) => j * s.stride);
      const d = decimateMinMax(x, v, 0, v.length, maxPoints);
      plot.series.push({ path: files[k], label: labels[k], x: d.x, y: d.y, mean: summary(v).mean });
    });
    result.plot = plot;
  } else if (p.mode === '2d') {
    const cj = int(p.coord2, coords.length > 1 ? 1 : 0, 0, coords.length - 1);
    const target = p.file2d ? checkFile(p.file2d, ctx) : files[0];
    let k = files.findIndex(f => norm(f) === norm(target));
    if (k < 0) k = 0;
    const s = scans[k];
    const h2 = histogram2d(s.values[ci], s.values[cj], bins, bins, { density: true });
    const z = h2.edgesB.slice(0, -1).map((_, iy) => h2.counts.map(row => row[iy]));
    const n = summary(s.values[ci]).n;
    result.plot = { kind: '2d', path: files[k], label: labels[k], xEdges: h2.edgesA, yEdges: h2.edgesB, z, n } satisfies Hist2dPlot;
  } else {
    const arrays = scans.map(s => s.values[ci]);
    const edges = commonEdges(arrays, bins);
    const plot: HistogramPlot = {
      kind: 'histogram',
      edges,
      series: arrays.map((v, k) => ({ path: files[k], label: labels[k], values: histogram(v, { edges, density: true }).values, mean: summary(v).mean }))
    };
    if (p.kde) {
      const lo = edges[0];
      const hi = edges[edges.length - 1];
      const pad = (hi - lo) * 0.04;
      const grid = Array.from({ length: 400 }, (_, i) => lo - pad + ((hi - lo + 2 * pad) * i) / 399);
      plot.kde = { grid, series: arrays.map(v => (summary(v).n >= 2 ? kde(v, grid) : grid.map(() => NaN))) };
    }
    result.plot = plot;
  }
  result.ms = Date.now() - t0;
  return result;
}

// ------------------------------------------------------------------ .dat view

export function datView(p: DatViewParams, ctx: HostContext): DatViewResult {
  const file = checkFile(p?.path, ctx);
  const { table, monotonic, partialTail } = loadDat(file);
  const rowsTotal = table.data[0]?.length ?? 0;
  if (table.columns.length < 2 || rowsTotal < 2) {
    throw new Error(`${path.basename(file)}: need at least two numeric columns and two rows.`);
  }
  const x = table.data[0];
  const xFull: [number, number] = monotonic ? [x[0], x[rowsTotal - 1]] : [Math.min(...x), Math.max(...x)];
  let i0 = 0;
  let i1 = rowsTotal;
  if (monotonic) {
    const a = typeof p.xMin === 'number' && Number.isFinite(p.xMin) ? p.xMin : xFull[0];
    const b = typeof p.xMax === 'number' && Number.isFinite(p.xMax) ? p.xMax : xFull[1];
    i0 = lowerBound(x, Math.min(a, b));
    i1 = lowerBound(x, Math.max(a, b) + Math.abs(Math.max(a, b)) * 1e-12 + 1e-12);
    if (i1 - i0 < 2) {
      // keep at least two rows so a slope exists
      i0 = Math.max(0, Math.min(i0, rowsTotal - 2));
      i1 = Math.min(rowsTotal, i0 + 2);
    }
  }
  const maxPoints = int(p.maxPoints, 4000, 50, 200_000);
  const wanted = Array.isArray(p.columns) && p.columns.length
    ? [...new Set(p.columns.filter(c => Number.isInteger(c) && c >= 1 && c < table.columns.length))]
    : table.columns.map((_, j) => j).slice(1);
  const series: DatColumnView[] = wanted.map(j => {
    const d = decimateMinMax(x, table.data[j], i0, i1, maxPoints);
    return { index: j, name: table.columns[j], axis: axisFromName(table.columns[j]), x: d.x, y: d.y, stats: datStats(x, table.data[j], i0, i1, table.columns[0]) };
  });
  return {
    path: file,
    label: path.basename(file),
    columns: table.columns,
    xLabel: axisFromName(table.columns[0]),
    xFull,
    xRange: [x[i0], x[i1 - 1]],
    rows: i1 - i0,
    totalRows: rowsTotal,
    skipped: table.skipped,
    partialTail,
    dx: medianStep(x),
    fs: isFs(table.columns[0]),
    full: i1 - i0 <= maxPoints,
    series
  };
}

// ------------------------------------------------------------------ host

export const host: TabHost = {
  id: 'geom',
  methods: {
    /** Settings the webview needs up front. */
    defaults(_p, ctx) {
      return {
        specs: ctx.config<string[]>('watchedCoordinates', []),
        strideHintFrames: STRIDE_HINT_FRAMES
      };
    },

    listXyz(p: { extra?: string[] }, ctx) {
      return listFiles(ctx, 'geometryGlobs', 'geometryExcludeGlobs', DEFAULTS.geometryGlobs, DEFAULTS.geometryExcludeGlobs, p?.extra ? stringList(p.extra, 'extra') : []);
    },

    listDat(p: { extra?: string[] }, ctx) {
      return listFiles(ctx, 'datGlobs', 'datExcludeGlobs', DEFAULTS.datGlobs, DEFAULTS.datExcludeGlobs, p?.extra ? stringList(p.extra, 'extra') : []);
    },

    /** Frame counts etc., computed lazily for the rows the webview shows. */
    async xyzInfo(p: { paths: string[] }, ctx) {
      const out: XyzInfo[] = [];
      for (const raw of stringList(p?.paths, 'paths', 200)) {
        try {
          out.push(xyzInfoOf(checkFile(raw, ctx)));
        } catch (e) {
          out.push({ path: raw, frames: 0, atoms: 0, symbols: [], incompleteTail: false, error: e instanceof Error ? e.message : String(e) });
        }
        await yieldLoop();
      }
      return out;
    },

    async datInfo(p: { paths: string[] }, ctx) {
      const out: DatInfo[] = [];
      for (const raw of stringList(p?.paths, 'paths', 400)) {
        try {
          out.push(datInfoOf(checkFile(raw, ctx)));
        } catch (e) {
          out.push({ path: raw, ok: false, columns: [], rows: 0, skipped: 0, partialTail: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return out;
    },

    /** First frame of a file as atoms + inferred bonds + 2D projection (atom picker). */
    molecule(p: { path: string }, ctx): MoleculeResult {
      const file = checkFile(p?.path, ctx);
      const f = readFirstFrame(file);
      return { path: file, comment: f.comment, atoms: sketchAtoms(f.atoms), bonds: inferBonds(f.atoms) };
    },

    parse(p: ParseParams, ctx): ParseResult {
      const { infos, errors } = parseCoords(stringList(p?.specs, 'specs', 64), symbolsOf(p?.file, ctx));
      return { coords: infos, errors };
    },

    distributions: (p: DistParams, ctx) => distributions(p, ctx),

    datView: (p: DatViewParams, ctx) => datView(p, ctx),

    /** "Add files…": the dialog runs on the host so picked files outside the workspace are allowed later. */
    async pick(p: { kind: 'xyz' | 'dat' }, ctx) {
      const kind = p?.kind === 'dat' ? 'dat' : 'xyz';
      const files = await ctx.pickFiles({
        title: kind === 'dat' ? 'Add MD column files (.dat)' : 'Add XYZ trajectories / ensembles',
        canSelectMany: true,
        canSelectFiles: true,
        filters: kind === 'dat' ? { 'Column data': ['dat', 'txt', 'out'], 'All files': ['*'] } : { 'XYZ': ['xyz'], 'All files': ['*'] }
      });
      for (const f of files) {
        picked.add(norm(f));
      }
      return files.map(f => path.resolve(f));
    }
  }
};
