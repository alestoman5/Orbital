// Host side of the "viewer" studio tab: 3D structures and trajectories
// (multi-XYZ, ORCA .allxyz relaxed scans with .relaxscanact.dat, the
// geometry steps of a .out, .hess reference geometries), normal modes,
// MO energies / composition / excited states from a .out, and isosurface
// meshes of cube files. Brings photoswitch scripts/{plot_orbitals,
// mo_character}.py and the scan-envelope views into the studio. Never
// imports 'vscode' — everything goes through the HostContext.

import * as fs from 'fs';
import * as path from 'path';
import type { HostContext, TabHost } from '../../context';
import { isAllowedPath, isInside } from '../../paths';
import { parseOrcaOutput } from '../../../outparser/parse';
import { parseHessFile } from '../../../chem/hess';
import { vibrationalDataFromJob } from '../../../chem/vibrations';
import { BOHR_TO_ANGSTROM, EV_NM } from '../../../chem/elements';
import { cubeStats, moFromCubeName, parseCube, type CubeGrid } from '../../../chem/cube';
import { isosurface, type IsoMesh } from '../../../chem/marchingCubes';
import { moComposition, parseOrbitalData, planeNormal, type OrbitalData } from '../../../chem/orbitals';
import { readOutStructure, readXyzStructure, type Structure } from '../../../chem/trajectory3d';
import { combineGlobs, globToRegExp, inferBonds, shortLabels } from '../geom/analysis';
import type {
  CubeRef,
  IsoMeshView,
  IsoParams,
  IsoResult,
  LevelRow,
  ModeInfo,
  ModeResult,
  OrbitalsParams,
  OrbitalsResult,
  PlotsBlockParams,
  PlotsBlockResult,
  SourceFile,
  SourceKind,
  SourceList,
  StructureResult
} from './types';

export const DEFAULTS = {
  viewerGlobs: ['**/*.xyz', '**/*.allxyz', '**/*.out', '**/*.hess', '**/*.cube'],
  viewerExcludeGlobs: ['**/geom_*/**', '**/slurm-*.out'],
  maxListedFiles: 3000,
  maxFrames: 5000,
  iso: 0.03
};

/** Largest file the viewer parses as a whole (.out / .cube / .hess). */
const MAX_TEXT_BYTES = 256 * 1024 * 1024;

// ------------------------------------------------------------------ caches

interface Cached<T> {
  key: string;
  value: T;
}
const MAX_CACHE = 16;
function cache<T>(): Map<string, Cached<T>> {
  return new Map();
}
const outCache = cache<{ text: string; parsed: ReturnType<typeof parseOrcaOutput> }>();
const orbCache = cache<OrbitalData>();
const cubeCache = cache<CubeGrid>();
const isoCache = cache<IsoResult>();
const structCache = cache<StructureResult>();
const picked = new Set<string>();

function remember<T>(m: Map<string, Cached<T>>, p: string, key: string, make: () => T): T {
  const hit = m.get(p);
  if (hit && hit.key === key) return hit.value;
  const value = make();
  m.delete(p);
  m.set(p, { key, value });
  while (m.size > MAX_CACHE) m.delete(m.keys().next().value as string);
  return value;
}

export function clearCaches(): void {
  for (const m of [outCache, orbCache, cubeCache, isoCache, structCache] as Map<string, unknown>[]) m.clear();
  picked.clear();
}

const fileKey = (p: string) => {
  const st = fs.statSync(p);
  return `${st.mtimeMs}:${st.size}`;
};

// ------------------------------------------------------------------ validation

const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

export function checkFile(p: unknown, ctx: HostContext): string {
  if (typeof p !== 'string' || p.trim() === '') throw new Error('Expected a file path.');
  const abs = path.resolve(p);
  if (!picked.has(norm(abs)) && !isAllowedPath(ctx, abs)) throw new Error(`${p} is outside the workspace.`);
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error(`${p} does not exist.`);
  if (st.size > MAX_TEXT_BYTES && !/\.(xyz|allxyz)$/i.test(abs)) throw new Error(`${path.basename(abs)} is larger than ${MAX_TEXT_BYTES >> 20} MB.`);
  return abs;
}

export function kindOf(p: string): SourceKind | undefined {
  const n = p.toLowerCase();
  if (n.endsWith('.allxyz')) return 'allxyz';
  if (n.endsWith('.xyz')) return 'xyz';
  if (n.endsWith('.out') || n.endsWith('.log')) return 'out';
  if (n.endsWith('.hess')) return 'hess';
  if (n.endsWith('.cube') || n.endsWith('.cub')) return 'cube';
  return undefined;
}

function relTo(ctx: HostContext, p: string): string {
  const f = ctx.workspaceFolders().find(w => isInside(p, w));
  return f ? path.relative(f, p).replace(/\\/g, '/') : p;
}

// ------------------------------------------------------------------ sources

async function listSources(ctx: HostContext, extra: string[]): Promise<SourceList> {
  const include = ctx.config<string[]>('studio.viewerGlobs', DEFAULTS.viewerGlobs);
  const exclude = ctx.config<string[]>('studio.viewerExcludeGlobs', DEFAULTS.viewerExcludeGlobs);
  const base = ctx.config<string>('runs.exclude', '**/{node_modules,.git}/**');
  const excludeGlob = combineGlobs([base, ...exclude]);
  const excludeRe = exclude.map(globToRegExp);
  const max = DEFAULTS.maxListedFiles;
  const found = new Set<string>();
  let capped = false;
  for (const g of Array.isArray(include) ? include : DEFAULTS.viewerGlobs) {
    const hits = await ctx.findFiles(g, { exclude: excludeGlob, max: max + 1 });
    for (const h of hits) {
      if (kindOf(h) && !excludeRe.some(re => re.test(relTo(ctx, h)))) found.add(path.resolve(h));
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
      // stale entry
    }
  }
  const paths = [...found];
  const labels = shortLabels(paths);
  const files: SourceFile[] = [];
  paths.forEach((p, i) => {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    const kind = kindOf(p);
    if (st && kind) {
      const rel = relTo(ctx, p);
      files.push({ path: p, label: labels[i], rel, kind, size: st.size, mtimeMs: st.mtimeMs, folder: path.posix.dirname(rel) });
    }
  });
  files.sort((a, b) => a.folder.localeCompare(b.folder, undefined, { numeric: true }) || a.rel.localeCompare(b.rel, undefined, { numeric: true }));
  return { files, capped };
}

/** Cube files in the same folder whose name starts with the base name of `file` (trans.out → trans_mo33.cube). */
export function cubesFor(file: string): CubeRef[] {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext).replace(/_trj$/, '');
  if (/\.cube?$/i.test(ext)) {
    const m = moFromCubeName(path.basename(file));
    return [{ path: file, name: path.basename(file), mo: m?.mo, spin: m?.spin }];
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(n => /\.cube?$/i.test(n) && n.startsWith(base) && /^[._-]/.test(n.slice(base.length)))
    .map(n => {
      const m = moFromCubeName(n.slice(base.length));
      return { path: path.join(dir, n), name: n, mo: m?.mo, spin: m?.spin };
    })
    .sort((a, b) => (a.mo ?? 1e9) - (b.mo ?? 1e9) || a.name.localeCompare(b.name));
}

function readOut(p: string) {
  return remember(outCache, p, fileKey(p), () => {
    const text = fs.readFileSync(p, 'utf8');
    return { text, parsed: parseOrcaOutput(text) };
  });
}

function readCube(p: string): CubeGrid {
  return remember(cubeCache, p, fileKey(p), () => parseCube(fs.readFileSync(p, 'utf8')));
}

function modesOf(freqs: number[] | undefined): ModeInfo[] | undefined {
  if (!freqs?.length) return undefined;
  const m = freqs.map((freq, index) => ({ index, freq })).filter(x => Math.abs(x.freq) > 1e-3);
  return m.length ? m : undefined;
}

function openStructure(file: string, ctx: HostContext): StructureResult {
  return remember(structCache, file, fileKey(file), () => {
    const kind = kindOf(file);
    if (!kind) throw new Error(`${path.basename(file)}: not a structure file (.xyz, .allxyz, .out, .hess, .cube).`);
    let s: Structure;
    let modes: ModeInfo[] | undefined;
    let hasOrbitals = false;
    const maxFrames = Math.max(10, ctx.config<number>('studio.viewerMaxFrames', DEFAULTS.maxFrames));
    if (kind === 'xyz' || kind === 'allxyz') {
      s = readXyzStructure(file, maxFrames);
    } else if (kind === 'out') {
      const { text, parsed } = readOut(file);
      s = readOutStructure(text);
      const job = [...parsed.jobs].reverse().find(j => j.frequenciesCm1?.length && j.normalModes?.length);
      if (job && vibrationalDataFromJob(job)) modes = modesOf(job.frequenciesCm1);
      hasOrbitals = /^\s*ORBITAL ENERGIES\s*$/m.test(text);
    } else if (kind === 'hess') {
      const v = parseHessFile(fs.readFileSync(file, 'utf8'));
      if (!v) throw new Error(`${path.basename(file)}: no $atoms block.`);
      s = {
        symbols: v.atoms.map(a => a.symbol),
        frames: [v.atoms.flatMap(a => [a.xBohr * BOHR_TO_ANGSTROM, a.yBohr * BOHR_TO_ANGSTROM, a.zBohr * BOHR_TO_ANGSTROM])],
        comments: [path.basename(file)],
        totalFrames: 1,
        stride: 1,
        truncated: false,
        note: 'reference geometry of the Hessian'
      };
      if (v.normalModes.length === v.frequenciesCm1.length) modes = modesOf(v.frequenciesCm1);
    } else {
      const g = readCube(file);
      s = {
        symbols: g.atoms.map(a => a.symbol),
        frames: [g.atoms.flatMap(a => [a.x, a.y, a.z])],
        comments: [g.comments.join(' ').trim()],
        totalFrames: 1,
        stride: 1,
        truncated: false,
        note: `cube ${g.n.join('×')}`
      };
    }
    const first = s.symbols.map((symbol, i) => ({ symbol, x: s.frames[0][3 * i], y: s.frames[0][3 * i + 1], z: s.frames[0][3 * i + 2] }));
    return {
      path: file,
      kind,
      symbols: s.symbols,
      frames: s.frames.map(f => f.map(round4)),
      comments: s.comments,
      bonds: inferBonds(first),
      energies: s.energies,
      coordinate: s.coordinate,
      totalFrames: s.totalFrames,
      stride: s.stride,
      truncated: s.truncated,
      note: s.note,
      modes,
      hasOrbitals,
      cubes: cubesFor(file)
    };
  });
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

function modeOf(file: string, index: number): ModeResult {
  const kind = kindOf(file);
  let freqs: number[] | undefined;
  let modes: number[][] | undefined;
  if (kind === 'out') {
    const job = [...readOut(file).parsed.jobs].reverse().find(j => j.frequenciesCm1?.length && j.normalModes?.length);
    const v = job && vibrationalDataFromJob(job);
    freqs = v?.frequenciesCm1;
    modes = v?.normalModes;
  } else if (kind === 'hess') {
    const v = parseHessFile(fs.readFileSync(file, 'utf8'));
    freqs = v?.frequenciesCm1;
    modes = v?.normalModes;
  }
  if (!freqs || !modes || !modes[index]) throw new Error(`Mode ${index} not found in ${path.basename(file)}.`);
  return { index, freq: freqs[index], vector: modes[index].map(round4) };
}

// ------------------------------------------------------------------ orbitals

const SEMI_EMPIRICAL = /\b(ZINDO\/[S12]|ZINDO|NDDO\/[12]|MNDO|AM1|PM3|PM6|RM1)\b/i;

function orbitals(p: OrbitalsParams, ctx: HostContext): OrbitalsResult {
  const file = checkFile(p?.path, ctx);
  const { text, parsed } = readOut(file);
  const job = parsed.jobs[parsed.jobs.length - 1];
  const fosc = [...parsed.jobs].reverse().find(j => j.excitations?.length)?.excitations?.map(e => e.fosc);
  const data = remember(orbCache, file, fileKey(file), () => parseOrbitalData(text, fosc));
  const geom = [...parsed.jobs].reverse().find(j => j.finalGeometry?.length)?.finalGeometry ?? job?.finalGeometry ?? [];
  const xyz = geom.map(a => [a.x, a.y, a.z] as [number, number, number]);
  const plane = Array.isArray(p?.plane) && p.plane.length >= 3 && p.plane.length <= 4 && p.plane.every(i => Number.isInteger(i) && i >= 1 && i <= xyz.length) ? p.plane : undefined;
  const normal = plane ? planeNormal(xyz, plane.map(i => i - 1)) : undefined;
  const cubes = cubesFor(file);
  const bang = parsed.inputEcho.filter(l => l.trim().startsWith('!')).join(' ');
  const method = SEMI_EMPIRICAL.exec(bang)?.[1];
  const sets = data.sets.map(set => {
    const coef = data.coefficients.find(c => c.spin === set.spin);
    const levels: LevelRow[] = set.levels.map(l => {
      const row: LevelRow = { index: l.index, occ: l.occ, energyEv: l.energyEv };
      const spinTag = set.spin === 'beta' ? 'b' : 'a';
      row.cube = cubes.find(c => c.mo === l.index && (c.spin ?? 'a') === spinTag)?.path;
      const comp = coef && moComposition(coef, l.index, xyz.length || 1 + Math.max(0, ...coef.basis.map(b => b.atom)), normal);
      if (comp) {
        row.elements = roundRecord(comp.elements);
        row.shells = roundRecord(comp.shells);
        row.topAtoms = comp.atoms.map((w, i) => [i, Math.round(w * 1e4) / 1e4] as [number, number]).sort((a, b) => b[1] - a[1]).slice(0, 6).filter(x => x[1] >= 0.005);
        if (comp.pi !== undefined) row.pi = Math.round(comp.pi * 1e4) / 1e4;
      }
      return row;
    });
    return { spin: set.spin, homo: set.homo, levels };
  });
  const states = data.states.map(s => ({
    state: s.state,
    method: s.method,
    multiplicity: s.multiplicity,
    energyEv: s.energyEv,
    wavelengthNm: s.energyEv > 0 ? EV_NM / s.energyEv : NaN,
    fosc: s.fosc,
    s2: s.s2,
    contributions: s.contributions.map(c => ({ from: c.from, to: c.to, spin: c.fromSpin, weight: c.weight }))
  }));
  return { path: file, sets, states, hasCoefficients: data.coefficients.length > 0, plane: normal ? plane : undefined, orthogonalBasis: !!method, method };
}

function roundRecord(r: Record<string, number>): Record<string, number> {
  const o: Record<string, number> = {};
  for (const [k, v] of Object.entries(r)) if (v >= 0.0005) o[k] = Math.round(v * 1e4) / 1e4;
  return o;
}

function meshView(m: IsoMesh): IsoMeshView {
  return {
    positions: Array.from(m.positions, round4),
    normals: Array.from(m.normals, x => Math.round(x * 1e3) / 1e3),
    indices: Array.from(m.indices)
  };
}

function iso(p: IsoParams, ctx: HostContext): IsoResult {
  const file = checkFile(p?.path, ctx);
  const level = typeof p?.iso === 'number' && Number.isFinite(p.iso) && p.iso > 0 ? p.iso : DEFAULTS.iso;
  const maxTriangles = Math.max(1000, ctx.config<number>('studio.viewerMaxTriangles', 300_000));
  return remember(isoCache, `${file}@${level}`, fileKey(file), () => {
    const g = readCube(file);
    const stats = cubeStats(g);
    const pos = isosurface(g, level, 1, maxTriangles);
    const neg = isosurface(g, level, -1, maxTriangles);
    return {
      path: file,
      iso: level,
      positive: meshView(pos),
      negative: meshView(neg),
      absMax: stats.absMax,
      step: Math.max(pos.step, neg.step),
      atoms: g.atoms.map(a => ({ symbol: a.symbol, x: round4(a.x), y: round4(a.y), z: round4(a.z) })),
      comment: g.comments.join(' ').trim()
    };
  });
}

/** %plots block for the given MOs (as in photoswitch 06-orbitals/*.inp). */
export function plotsBlock(base: string, mos: number[], grid = 50, spin: 0 | 1 = 0): string {
  const lines = ['%plots', `  dim1 ${grid} dim2 ${grid} dim3 ${grid}`, '  Format Gaussian_Cube'];
  for (const mo of mos) lines.push(`  MO("${base}_mo${mo}${spin ? 'b' : ''}.cube",${mo},${spin});`);
  lines.push('end');
  return lines.join('\n');
}

// ------------------------------------------------------------------ host

export const host: TabHost = {
  id: 'viewer',
  methods: {
    list(p: { extra?: string[] }, ctx) {
      const extra = Array.isArray(p?.extra) ? p.extra.filter((s): s is string => typeof s === 'string').slice(0, 100) : [];
      return listSources(ctx, extra);
    },

    open(p: { path: string }, ctx): StructureResult {
      return openStructure(checkFile(p?.path, ctx), ctx);
    },

    mode(p: { path: string; index: number }, ctx): ModeResult {
      const file = checkFile(p?.path, ctx);
      if (!Number.isInteger(p?.index) || p.index < 0) throw new Error('Expected a mode index.');
      return modeOf(file, p.index);
    },

    orbitals: (p: OrbitalsParams, ctx) => orbitals(p, ctx),

    isosurface: (p: IsoParams, ctx) => iso(p, ctx),

    plotsBlock(p: PlotsBlockParams, ctx): PlotsBlockResult {
      const file = checkFile(p?.path, ctx);
      const mos = Array.isArray(p?.mos) ? [...new Set(p.mos.filter(m => Number.isInteger(m) && m >= 0))].sort((a, b) => a - b).slice(0, 200) : [];
      if (!mos.length) throw new Error('No MOs selected.');
      const grid = Number.isInteger(p?.grid) && p.grid! >= 10 && p.grid! <= 300 ? p.grid! : 50;
      const base = path.basename(file, path.extname(file));
      const inp = path.join(path.dirname(file), `${base}.inp`);
      return { text: plotsBlock(base, mos, grid), input: fs.existsSync(inp) ? inp : undefined };
    },

    async pick(_p, ctx) {
      const files = await ctx.pickFiles({
        title: 'Open structures, trajectories or cube files',
        canSelectMany: true,
        canSelectFiles: true,
        filters: { 'Structures': ['xyz', 'allxyz', 'out', 'hess', 'cube'], 'All files': ['*'] }
      });
      for (const f of files) picked.add(norm(f));
      return files.map(f => path.resolve(f));
    }
  }
};
