// Host side of the "inputs" studio tab (Input Builder). The ORCA/PySCF text is
// generated in the webview from the same pure modules (src/inputs); the host
// reads geometry files, writes inputs and batches, and builds NEA commands.
// Must not import 'vscode' — everything goes through the HostContext.

import * as fs from 'fs';
import * as path from 'path';
import type { HostContext, TabHost } from '../../context';
import { isAllowedPath, isInside } from '../../paths';
import type { GeometryAtom } from '../../../outparser/types';
import { parseOrcaOutput } from '../../../outparser/parse';
import { parseOrcaInput, parseXyz } from '../../../chem/inputFile';
import { EnsembleFrame, planBatch, splitEnsemble } from '../../../inputs/batch';
import { writeBatch } from '../../../inputs/batchFs';
import { NEA_SCRIPTS, NeaScript, buildNeaCommand } from '../../../inputs/nea';
import { InputSpec, Program, normalizeSpec } from '../../../inputs/spec';
import type {
  BatchFileInfo, BatchPlanParams, BatchPlanResult, BatchSource, LoadGeometryParams, LoadedGeometry, NeaCommandParams,
  NeaCommandResult, NeaInfo, SaveInputParams, SaveInputResult, WriteBatchParams, WriteBatchResult
} from './types';

// --- path policy ------------------------------------------------------------

/** Files the user picked in a dialog this session (allowed even outside the workspace). */
const picked = new Set<string>();
const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

export { isInside };

/** Throws unless `p` is an absolute path inside a workspace folder or below something the user picked. */
export function checkPath(p: unknown, ctx: HostContext): string {
  if (typeof p !== 'string' || !p.trim()) {
    throw new Error('Missing file path.');
  }
  if (!path.isAbsolute(p)) {
    throw new Error(`Not an absolute path: ${p}`);
  }
  const abs = path.resolve(p);
  const ok = isAllowedPath(ctx, abs) || [...picked].some(f => isInside(abs, f));
  if (!ok) {
    throw new Error(`${abs} is outside the workspace.`);
  }
  return abs;
}

function addPicked(paths: string[]): void {
  paths.forEach(p => picked.add(path.resolve(p)));
}

// --- geometry ---------------------------------------------------------------

interface CachedFrames {
  mtimeMs: number;
  size: number;
  frames: EnsembleFrame[];
}
const frameCache = new Map<string, CachedFrames>();

/** Frames of a (multi-)XYZ file, cached by (path, mtime). */
export function xyzFrames(file: string): EnsembleFrame[] {
  const st = fs.statSync(file);
  const hit = frameCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return hit.frames;
  }
  const text = fs.readFileSync(file, 'utf8');
  let frames = splitEnsemble(text);
  if (frames.length === 0) {
    const atoms = parseXyz(text);
    frames = atoms.length > 0 ? [{ index: 1, name: 'geom_0001', comment: '', atoms, xyz: text }] : [];
  }
  frameCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, frames });
  if (frameCache.size > 6) {
    frameCache.delete(frameCache.keys().next().value as string);
  }
  return frames;
}

const stripLine = (a: GeometryAtom & { line?: number }): GeometryAtom => ({ symbol: a.symbol, x: a.x, y: a.y, z: a.z });

/** Reads a geometry from .xyz (first frame), .inp (coordinate block) or .out (final geometry of the last job). */
export function readGeometry(file: string): LoadedGeometry {
  const ext = path.extname(file).toLowerCase();
  const name = path.basename(file);
  if (ext === '.xyz' || ext === '.trj') {
    const frames = xyzFrames(file);
    if (frames.length === 0) {
      throw new Error(`${name}: no XYZ geometry found.`);
    }
    return {
      path: file, kind: 'xyz', name, atoms: frames[0].atoms, frames: frames.length, comment: frames[0].comment, xyzPath: file,
      note: frames.length > 1 ? `ensemble of ${frames.length} geometries` : undefined
    };
  }
  if (ext === '.inp') {
    const inp = parseOrcaInput(fs.readFileSync(file, 'utf8'));
    const c = inp.coords;
    if (!c) {
      throw new Error(`${name}: no coordinate block ("* xyz ..." or "* xyzfile ...").`);
    }
    const base = { path: file, kind: 'inp' as const, name, charge: c.charge, multiplicity: c.multiplicity };
    if (c.type === 'xyz') {
      if (c.atoms.length === 0) {
        throw new Error(`${name}: the coordinate block has no atoms.`);
      }
      return { ...base, atoms: c.atoms.map(stripLine), frames: 1, note: 'coordinate block' };
    }
    if (c.type === 'xyzfile' && c.file) {
      const ref = path.resolve(path.dirname(file), c.file.replace(/^"|"$/g, ''));
      if (!fs.existsSync(ref)) {
        throw new Error(`${name} reads ${c.file}, which does not exist.`);
      }
      const frames = xyzFrames(ref);
      if (frames.length === 0) {
        throw new Error(`${c.file}: no XYZ geometry found.`);
      }
      return { ...base, atoms: frames[0].atoms, frames: 1, xyzPath: ref, note: `read from ${c.file} (* xyzfile)` };
    }
    throw new Error(`${name}: "* ${c.type}" coordinates are not supported here (use Cartesian xyz).`);
  }
  if (ext === '.out' || ext === '.log') {
    const out = parseOrcaOutput(fs.readFileSync(file, 'utf8'));
    const k = [...out.jobs.keys()].reverse().find(i => (out.jobs[i].finalGeometry?.length ?? 0) > 0);
    if (k === undefined) {
      throw new Error(`${name}: no CARTESIAN COORDINATES (ANGSTROEM) block found.`);
    }
    const echo = out.inputEcho.length > 0 ? parseOrcaInput(out.inputEcho.join('\n')).coords : undefined;
    const optimized = out.jobs[k].optConverged;
    return {
      path: file, kind: 'out', name, atoms: out.jobs[k].finalGeometry!.map(stripLine), frames: 1,
      charge: echo?.charge, multiplicity: echo?.multiplicity,
      note: `final geometry${out.jobs.length > 1 ? ` of job ${k + 1} of ${out.jobs.length}` : ''}${optimized === true ? ' (optimized)' : optimized === false ? ' (optimization NOT converged)' : ''}`
    };
  }
  throw new Error(`${name}: use an .xyz, .inp or .out file.`);
}

// --- saving -----------------------------------------------------------------

/** Where "Save" writes: the folder of the source geometry, else the first workspace folder. */
export function savePathFor(ctx: HostContext, fileName: string, sourcePath?: string): string {
  const name = path.basename(String(fileName ?? '').trim());
  if (!name || name === '.' || name === '..') {
    throw new Error('Missing file name.');
  }
  let dir: string | undefined;
  if (sourcePath) {
    dir = path.dirname(checkPath(sourcePath, ctx));
  } else {
    dir = ctx.workspaceFolders()[0];
  }
  if (!dir) {
    throw new Error('No workspace folder to save into; use "Save as…".');
  }
  return path.join(dir, name);
}

async function saveInput(p: SaveInputParams, ctx: HostContext): Promise<SaveInputResult> {
  if (typeof p?.text !== 'string') {
    throw new Error('Nothing to save.');
  }
  const name = path.basename(String(p.fileName ?? 'job.inp'));
  const isPy = /\.py$/i.test(name);
  const filters: Record<string, string[]> = isPy ? { 'Python script': ['py'] } : { 'ORCA input': ['inp'] };
  const written = p.dialog
    ? await ctx.saveFile({ defaultName: name, data: p.text, filters })
    : await ctx.saveFile({ defaultName: name, data: p.text, filters, path: savePathFor(ctx, name, p.sourcePath) });
  if (!written) {
    return {};
  }
  const result: SaveInputResult = { path: written };
  if (p.companion && typeof p.companion.content === 'string') {
    const cname = path.basename(String(p.companion.name ?? ''));
    const target = path.join(path.dirname(written), cname);
    if (cname && !fs.existsSync(target)) {
      fs.writeFileSync(target, p.companion.content);
      result.companionWritten = target;
    }
  }
  if (p.open) {
    await ctx.openFile({ path: written, beside: true });
  }
  return result;
}

// --- batches ----------------------------------------------------------------

function sourceFrames(src: BatchSource, ctx: HostContext): { frames: EnsembleFrame[]; file?: string } {
  if (src && 'path' in src && typeof src.path === 'string') {
    const file = checkPath(src.path, ctx);
    return { frames: xyzFrames(file), file };
  }
  if (src && 'text' in src && typeof src.text === 'string') {
    return { frames: splitEnsemble(src.text) };
  }
  throw new Error('Batch source must be { path } or { text }.');
}

const PROGRAMS: Program[] = ['orca', 'pyscf'];
const posInt = (v: unknown, fallback: number, max = 1e7) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), max) : fallback;

interface Plan {
  totalFrames: number;
  frames: EnsembleFrame[];
  files: ReturnType<typeof planBatch>;
  spec: InputSpec;
  program: Program;
  file?: string;
}

function makePlan(p: BatchPlanParams, ctx: HostContext): Plan {
  if (!PROGRAMS.includes(p?.program)) {
    throw new Error(`Unknown program "${p?.program}".`);
  }
  const { frames: all, file } = sourceFrames(p.source, ctx);
  if (all.length === 0) {
    throw new Error('The ensemble has no readable XYZ frames.');
  }
  const frames = all.slice(0, posInt(p.maxFrames, all.length));
  const spec = normalizeSpec(p.spec ?? {});
  spec.geometry = { atoms: frames[0].atoms };
  const files = planBatch(spec, frames, p.program, { dirPrefix: String(p.dirPrefix ?? ''), slurm: p.slurm !== false });
  return { totalFrames: all.length, frames, files, spec, program: p.program, file };
}

function defaultTarget(ctx: HostContext, program: Program, file?: string): string | undefined {
  if (file) {
    return path.join(path.dirname(file), `${path.basename(file).replace(/\.[^.]*$/, '')}_${program}_batch`);
  }
  const ws = ctx.workspaceFolders()[0];
  return ws ? path.join(ws, `batch_${program}`) : undefined;
}

const FILE_LIST_LIMIT = 240;

export function planBatchSummary(p: BatchPlanParams, ctx: HostContext): BatchPlanResult {
  let plan: Plan;
  try {
    plan = makePlan(p, ctx);
  } catch (e) {
    const total = (() => {
      try {
        return sourceFrames(p.source, ctx).frames.length;
      } catch {
        return 0;
      }
    })();
    return { totalFrames: total, frames: 0, files: [], fileCount: 0, totalBytes: 0, error: e instanceof Error ? e.message : String(e) };
  }
  const infos: BatchFileInfo[] = plan.files.map(f => ({ relPath: f.relPath, size: Buffer.byteLength(f.content), ...(f.executable ? { executable: true } : {}) }));
  const shown = infos.length <= FILE_LIST_LIMIT ? infos : [...infos.slice(0, FILE_LIST_LIMIT - 40), ...infos.slice(-40)];
  const byPath = (rel: string) => plan.files.find(f => f.relPath === rel)?.content;
  const first = plan.files.find(f => /\/(job\.inp|run\.py)$/.test(f.relPath)) ?? plan.files[0];
  return {
    totalFrames: plan.totalFrames,
    frames: plan.frames.length,
    files: shown,
    fileCount: infos.length,
    totalBytes: infos.reduce((a, f) => a + f.size, 0),
    sampleJob: { relPath: first.relPath, content: first.content },
    runAll: byPath('run_all.sh'),
    slurm: byPath('submit_slurm.sh'),
    defaultTarget: defaultTarget(ctx, plan.program, plan.file)
  };
}

export async function writeBatchMethod(p: WriteBatchParams, ctx: HostContext): Promise<WriteBatchResult> {
  const plan = makePlan(p, ctx);
  let target: string;
  if (p.target) {
    target = checkPath(p.target, ctx);
  } else {
    const chosen = await ctx.pickFiles({ title: 'Folder for the batch (job directories are created inside)', canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
    if (!chosen || chosen.length === 0) {
      return { status: 'cancelled' };
    }
    addPicked(chosen);
    target = path.resolve(chosen[0]);
  }
  const existing = plan.files.map(f => f.relPath).filter(rel => fs.existsSync(path.join(target, ...rel.split('/'))));
  let overwrite = false;
  if (existing.length > 0) {
    const shown = existing.slice(0, 12).join('\n') + (existing.length > 12 ? `\n… and ${existing.length - 12} more` : '');
    overwrite = await ctx.confirm({
      message: `${existing.length} of ${plan.files.length} files already exist in ${target}. Overwrite them?`,
      detail: shown,
      action: 'Overwrite'
    });
    if (!overwrite) {
      return { status: 'cancelled' };
    }
  }
  const written = writeBatch(target, plan.files, { overwrite });
  ctx.log(`inputs: wrote ${written.length} batch files to ${target}`);
  return { status: 'written', folder: target, written: written.length };
}

// --- NEA command ------------------------------------------------------------

export async function neaInfo(ctx: HostContext): Promise<NeaInfo> {
  const workspaceFolders = ctx.workspaceFolders();
  const configured = String(ctx.config<string>('nea.scriptsDir', '') ?? '').trim();
  if (configured) {
    const dir = path.isAbsolute(configured) ? configured : path.resolve(workspaceFolders[0] ?? '.', configured);
    return { scriptsDir: dir, root: path.dirname(dir), source: 'setting', workspaceFolders };
  }
  const hits = await ctx.findFiles('**/scripts/from_geometry.py', { max: 1, exclude: '**/{node_modules,.git}/**' });
  if (hits.length > 0) {
    const dir = path.dirname(hits[0]);
    return { scriptsDir: dir, root: path.dirname(dir), source: 'search', workspaceFolders };
  }
  return { source: 'none', workspaceFolders };
}

const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
const int = (v: unknown, lo: number, hi: number) => {
  const n = num(v, lo, hi);
  return n === undefined ? undefined : Math.round(n);
};
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export async function neaCommandMethod(p: NeaCommandParams, ctx: HostContext): Promise<NeaCommandResult> {
  if (!NEA_SCRIPTS.includes(p?.script as NeaScript)) {
    throw new Error(`Unknown NEA script "${p?.script}".`);
  }
  const info = await neaInfo(ctx);
  const inputs = (Array.isArray(p.inputs) ? p.inputs : []).filter((s): s is string => typeof s === 'string' && path.isAbsolute(s));
  const cwd = info.root ?? ctx.workspaceFolders()[0] ?? (inputs[0] ? path.dirname(inputs[0]) : '.');
  const placeholder = inputs.length === 0;
  const used = placeholder ? [path.join(cwd, p.script === 'from_ensemble.py' ? 'geoms.xyz' : 'geom.xyz')] : inputs;
  const command = buildNeaCommand({
    script: p.script as NeaScript,
    root: cwd,
    inputs: p.script === 'compare_ensembles.py' ? used : used.slice(0, 1),
    sampling: p.sampling === 'md' ? 'md' : p.sampling === 'wigner' ? 'wigner' : undefined,
    nsamples: int(p.nsamples, 1, 1e7),
    sampleMethod: str(p.sampleMethod),
    sampleBasis: str(p.sampleBasis),
    temperature: num(p.temperature, 0, 1e5),
    skip: int(p.skip, 0, 1e9),
    stride: int(p.stride, 1, 1e9),
    beads: int(p.beads, 1, 1e4),
    method: str(p.method),
    basis: str(p.basis),
    nstates: int(p.nstates, 1, 1000),
    jobs: int(p.jobs, 1, 10000),
    outDir: str(p.outDir)
  });
  return { command, cwd, found: info.source !== 'none', ...(placeholder ? { placeholder: true } : {}) };
}

// --- tab host ---------------------------------------------------------------

export const host: TabHost = {
  id: 'inputs',
  methods: {
    /** LoadGeometryParams -> LoadedGeometry */
    loadGeometry: (p: LoadGeometryParams, ctx) => readGeometry(checkPath(p?.path, ctx)),

    /** Open dialog for a geometry -> LoadedGeometry | null (cancelled). */
    async pickGeometry(_p: unknown, ctx) {
      const files = await ctx.pickFiles({ title: 'Geometry (.xyz, ORCA .inp or .out)', canSelectMany: false, filters: { Geometry: ['xyz', 'inp', 'out'] } });
      if (!files || files.length === 0) {
        return null;
      }
      addPicked(files);
      return readGeometry(path.resolve(files[0]));
    },

    /** { many?, folders? } -> absolute paths (NEA inputs). */
    async pickInputs(p: { many?: boolean; folders?: boolean }, ctx) {
      const files = await ctx.pickFiles({
        title: p?.many ? 'Geometry sets (.xyz or finished working directories)' : 'Input geometry / trajectory',
        canSelectMany: !!p?.many, canSelectFolders: !!p?.folders, canSelectFiles: true
      });
      addPicked(files ?? []);
      return (files ?? []).map(f => path.resolve(f));
    },

    /** { fileName, sourcePath? } -> absolute path "Save" would write. */
    savePath: (p: { fileName: string; sourcePath?: string }, ctx) => savePathFor(ctx, p?.fileName, p?.sourcePath),

    /** SaveInputParams -> SaveInputResult */
    saveInput,

    /** BatchPlanParams -> BatchPlanResult */
    planBatch: (p: BatchPlanParams, ctx) => planBatchSummary(p, ctx),

    /** WriteBatchParams -> WriteBatchResult */
    writeBatch: writeBatchMethod,

    /** -> NeaInfo */
    neaInfo: (_p: unknown, ctx) => neaInfo(ctx),

    /** NeaCommandParams -> NeaCommandResult. "Send to terminal" needs a studio method (see contrib/inputs.json notes). */
    neaCommand: neaCommandMethod
  }
};
