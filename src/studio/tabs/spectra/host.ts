// Host side of the "spectra" studio tab: library of spectrum files,
// experiments and stick sources; plot-ready series on the chosen axis;
// band statistics and the consistency test; CSV export. Heavy work
// (parsing, broadening, comparison) happens here, the webview only renders.
// Must not import 'vscode' — everything goes through the HostContext.

import type { Disposable, HostContext, TabHost } from '../../context';
import { broadenCrossSection, energyGrid } from './crossSection';
import {
  CONFIDENCE,
  Curve,
  THRESHOLD_PCT,
  autoRange,
  cropForPlot,
  cropSticks,
  curvesCsv,
  differences,
  normalize,
  scaleExperiments,
  statsRows,
  toAxis,
  toRelative
} from './analysis';
import { buildLibrary, itemsForPath, parseId, readExperiment, readNea, readSettings, readSticks, spectrumStem, validateExtraPath } from './sources';
import { convertEnergy } from '../../../chem/spectrum';
import * as path from 'path';
import type {
  AddFilesResult,
  CsvParams,
  CsvResult,
  LibraryResult,
  LoadParams,
  LoadResult,
  PlotParams,
  StatsResult,
  XAxis
} from './types';

const AXES: XAxis[] = ['nm', 'eV', 'cm-1'];
const MAX_IDS = 64;

/** Paths added by the user or a command (outside-workspace paths need to be here). */
const allowed = new Set<string>();

function checkParams(p: any): Required<Pick<PlotParams, 'ids' | 'axis'>> & PlotParams {
  if (!p || typeof p !== 'object') throw new Error('missing parameters');
  if (!Array.isArray(p.ids) || p.ids.some((i: unknown) => typeof i !== 'string')) throw new Error('ids must be a list of strings');
  if (p.ids.length > MAX_IDS) throw new Error(`at most ${MAX_IDS} series at once`);
  if (!AXES.includes(p.axis)) throw new Error(`axis must be one of ${AXES.join(', ')}`);
  const out: PlotParams = { ids: [...new Set<string>(p.ids)], axis: p.axis };
  if (p.experiment !== undefined) {
    if (!Array.isArray(p.experiment)) throw new Error('experiment must be a list of ids');
    out.experiment = p.experiment.filter((i: unknown) => typeof i === 'string');
  }
  if (typeof p.refId === 'string' && out.ids.includes(p.refId)) out.refId = p.refId;
  if (p.range !== undefined && p.range !== null) {
    const r = p.range;
    if (!Array.isArray(r) || r.length !== 2 || !r.every((v: unknown) => typeof v === 'number' && Number.isFinite(v)) || !(r[0] < r[1])) {
      throw new Error('range must be [min, max] with min < max');
    }
    out.range = [r[0], r[1]];
  }
  if (p.h !== undefined && p.h !== null) {
    if (typeof p.h !== 'number' || !(p.h >= 0.001 && p.h <= 5)) throw new Error('h must be between 0.001 and 5 eV');
    out.h = p.h;
  }
  out.normalize = !!p.normalize;
  out.yScale = p.yScale === 'relative' ? 'relative' : 'sigma';
  out.expScale = p.expScale === 'ref' ? 'ref' : 'none';
  return out as Required<Pick<PlotParams, 'ids' | 'axis'>> & PlotParams;
}

/** Reads every requested entry onto the axis; failures are reported per id. */
async function loadCurves(ctx: HostContext, p: PlotParams): Promise<{ curves: Curve[]; errors: { id: string; message: string }[] }> {
  const settings = readSettings(ctx);
  const exp = new Set(p.experiment ?? []);
  const curves: Curve[] = [];
  const errors: { id: string; message: string }[] = [];
  for (const id of p.ids) {
    try {
      const { source, path: file } = parseId(ctx, id, allowed);
      if (source === 'file') {
        const label = spectrumStem(file);
        if (exp.has(id)) {
          const e = readExperiment(file);
          const c = toAxis({ x: e.x, y: e.y }, e.unit, p.axis);
          curves.push({ id, label, kind: 'exp', ...c, states: [] });
        } else {
          const d = readNea(file);
          const c = toAxis(d, d.unit, p.axis);
          curves.push({ id, label, kind: 'nea', ...c });
        }
      } else {
        const set = await readSticks(ctx, source, file);
        const h = p.h ?? (set.nGeometries > 1 ? set.silverman : settings.singleH);
        const grid = energyGrid(set.sticks, h, 2000);
        const b = broadenCrossSection(set.sticks, grid, h, set.nGeometries, 'sigma', set.nStates);
        const c = toAxis({ x: b.energy, y: b.total, states: b.states }, 'eV', p.axis);
        const stickX = set.sticks.map(s => (p.axis === 'eV' ? s.energyEv : convertEnergy(s.energyEv, 'eV', p.axis)));
        const label = source === 'out' ? path.basename(file).replace(/(\.inp)?\.out$/i, '') : path.basename(file) === 'geoms' ? path.basename(path.dirname(file)) : path.basename(file);
        curves.push({
          id, label, kind: 'sticks', ...c, h, silverman: set.silverman, nGeometries: set.nGeometries,
          sticks: { x: stickX, f: set.sticks.map(s => s.weight) }
        });
      }
    } catch (e) {
      errors.push({ id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { curves, errors };
}

/** Units, normalization, window and experiment scaling, shared by load / stats / csv. */
async function prepare(ctx: HostContext, raw: unknown) {
  const p = checkParams(raw);
  const { curves, errors } = await loadCurves(ctx, p);
  for (const c of curves) {
    if (p.yScale === 'relative') toRelative(c);
    if (p.normalize) normalize(c);
  }
  const window = p.range ?? autoRange(curves, p.axis);
  const ref = curves.find(c => c.id === p.refId) ?? undefined;
  if (p.expScale === 'ref' && !p.normalize) {
    scaleExperiments(curves, ref ?? curves.find(c => c.kind !== 'exp'), window);
  }
  return { p, curves, errors, window, ref };
}

export const host: TabHost = {
  id: 'spectra',
  methods: {
    async library(params: unknown, ctx): Promise<LibraryResult> {
      const extra = Array.isArray((params as any)?.extra) ? ((params as any).extra as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
      const lib = await buildLibrary(ctx, extra);
      lib.allowed.forEach(a => allowed.add(a));
      const { allowed: _a, ...rest } = lib;
      return rest;
    },

    async addFiles(params: unknown, ctx): Promise<AddFilesResult> {
      const paths = (params as any)?.paths;
      if (!Array.isArray(paths)) throw new Error('paths must be a list');
      const settings = readSettings(ctx);
      const out: AddFilesResult = { ids: [], accepted: [], errors: [] };
      for (const raw of paths.slice(0, 200)) {
        const v = validateExtraPath(ctx, raw);
        if (!v.path) {
          out.errors.push(v.error ?? 'invalid path');
          continue;
        }
        try {
          const items = await itemsForPath(ctx, v.path, settings);
          if (items.length === 0) {
            out.errors.push(`${v.path}: no spectra, .out files or geom_NNNN/result.json sets found`);
            continue;
          }
          allowed.add(v.path);
          out.accepted.push(v.path);
          for (const it of items) {
            if (it.error) out.errors.push(`${it.name}: ${it.error}`);
            out.ids.push(it.id);
          }
        } catch (e) {
          out.errors.push(`${v.path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return out;
    },

    async load(params: unknown, ctx): Promise<LoadResult> {
      const { p, curves, errors, window, ref } = await prepare(ctx, params);
      const lp = params as LoadParams;
      const series = curves.map(c => {
        const s = cropForPlot(c, window);
        if (!lp.states) delete s.states;
        if (lp.sticks && c.sticks) s.sticks = cropSticks(c.sticks, window);
        return s;
      });
      const res: LoadResult = { axis: p.axis, range: window, yScale: p.yScale ?? 'sigma', normalized: !!p.normalize, series, errors };
      if (lp.difference && ref) res.difference = differences(ref, curves, window);
      return res;
    },

    async stats(params: unknown, ctx): Promise<StatsResult> {
      const { p, curves, errors, window, ref } = await prepare(ctx, params);
      const exp = curves.find(c => c.kind === 'exp' && c !== ref);
      return {
        axis: p.axis, window, rows: statsRows(curves, ref, window), refId: ref?.id, experimentLabel: exp?.label,
        thresholdPct: THRESHOLD_PCT, confidence: CONFIDENCE, errors
      };
    },

    async csv(params: unknown, ctx): Promise<CsvResult> {
      const { p, curves, window } = await prepare(ctx, params);
      if (curves.length === 0) throw new Error('nothing to export: no series could be read');
      const step = (params as CsvParams).step;
      if (step !== undefined && !(typeof step === 'number' && step > 0 && (window[1] - window[0]) / step <= 200000)) {
        throw new Error('step must be > 0 and give at most 200 000 rows');
      }
      const out = curvesCsv(curves, p.axis, window, step);
      const unit = p.axis === 'cm-1' ? 'cm-1' : p.axis;
      const saved = await ctx.saveFile({
        defaultName: `spectra_${round(window[0])}-${round(window[1])}${unit}.csv`,
        data: out.text,
        filters: { 'CSV table': ['csv'] }
      });
      return { path: saved, rows: out.rows, columns: out.columns };
    }
  },

  activate(ctx: HostContext): Disposable {
    const s = readSettings(ctx);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = '';
    const fire = (p: string) => {
      last = p;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => ctx.post('changed', { path: last }), 400);
    };
    const watchers = [...s.spectraGlobs, ...s.experimentGlobs].map(g => ctx.watch(g, fire));
    return {
      dispose() {
        if (timer) clearTimeout(timer);
        watchers.forEach(w => w.dispose());
      }
    };
  }
};

function round(v: number): string {
  return String(Math.round(v * 100) / 100);
}
