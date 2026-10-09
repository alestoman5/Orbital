// Library of the spectra tab: spectrum files found by globs, experiments,
// and stick sources (ORCA .out, folders of .out files, geom_NNNN/result.json
// sets) added by the user or a command. Parsed data is cached by
// (path, mtimeMs). No `vscode` import: everything goes through HostContext.

import * as fs from 'fs';
import * as path from 'path';
import type { HostContext } from '../../context';
import { findGeomSets } from '../../../chem/neaRun';
import { silvermanBandwidth } from '../../../chem/spectrum';
import {
  ExperimentSpectrum,
  NeaSpectrum,
  SpectrumXUnit,
  parseNeaSpectrum,
  parseSpectrumName,
  parseTwoColumn,
  unitFromFileName,
  detectXUnit
} from '../../../chem/spectrumSets';
import { parseOrcaOutput } from '../../../outparser/parse';
import type { StateStick } from './crossSection';
import type { ItemSource, LibraryItem, LibraryResult } from './types';

export const DEFAULT_SPECTRA_GLOBS = ['**/spectra_txt/*.dat', '**/*.cross.dat', '**/absspec*.dat'];
export const DEFAULT_EXPERIMENT_GLOBS = ['**/*_exp.{dat,txt,csv}', '**/exp*/*.{dat,txt,csv}', '**/experiment*.{dat,txt,csv}'];
export const DEFAULT_NAME_PATTERN = '^(?<sampling>.+?)-(?<geometry>.+?)_(?<method>[^-_]+)-(?<basis>.+?)_n(?<n>\\d+)$';
/** Largest spectrum file read (a PyNEAppLES file is ~0.1–1 MB). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const FILE_EXT = /\.(dat|txt|csv|tsv|xy|out)$/i;

// ---------------------------------------------------------------- settings

export interface Settings {
  spectraGlobs: string[];
  experimentGlobs: string[];
  pattern?: RegExp;
  fieldNames: string[];
  singleH: number;
  warnings: string[];
}

function stringArray(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : fallback;
}

export function readSettings(ctx: HostContext): Settings {
  const warnings: string[] = [];
  const spectraGlobs = stringArray(ctx.config<unknown>('studio.spectraGlobs', DEFAULT_SPECTRA_GLOBS), DEFAULT_SPECTRA_GLOBS);
  const experimentGlobs = stringArray(ctx.config<unknown>('studio.experimentGlobs', DEFAULT_EXPERIMENT_GLOBS), DEFAULT_EXPERIMENT_GLOBS);
  const raw = ctx.config<unknown>('studio.spectrumNamePattern', DEFAULT_NAME_PATTERN);
  let pattern: RegExp | undefined;
  let fieldNames: string[] = [];
  if (typeof raw === 'string' && raw) {
    try {
      pattern = new RegExp(raw);
      fieldNames = [...raw.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)].map(m => m[1]).filter(n => n !== 'name');
    } catch (e) {
      warnings.push(`studio.spectrumNamePattern is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const h = Number(ctx.config<unknown>('spectrum.singleGeometryBandwidth', 0.2));
  return { spectraGlobs, experimentGlobs, pattern, fieldNames, singleH: h > 0 && h < 5 ? h : 0.2, warnings };
}

// ---------------------------------------------------------------- paths

const norm = (p: string) => path.resolve(p);
const sameOrInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export function insideWorkspace(ctx: HostContext, p: string): boolean {
  return ctx.workspaceFolders().some(w => sameOrInside(norm(p), norm(w)));
}

/**
 * Paths the user picked (Add files…) or a command passed. Inside a workspace
 * folder anything that exists is fine; outside, only folders and files with
 * a spectrum / output extension (the HostContext cannot tell us whether the
 * webview really got the path from the file picker).
 */
export function validateExtraPath(ctx: HostContext, p: unknown): { path?: string; error?: string } {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) {
    return { error: 'not a path' };
  }
  if (!path.isAbsolute(p)) {
    return { error: `${p}: not an absolute path` };
  }
  const abs = norm(p);
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st) {
    return { error: `${abs}: does not exist` };
  }
  if (!st.isDirectory() && !st.isFile()) {
    return { error: `${abs}: not a file or folder` };
  }
  if (st.isFile() && st.size > MAX_FILE_BYTES) {
    return { error: `${abs}: larger than ${MAX_FILE_BYTES / 1048576} MB` };
  }
  if (!insideWorkspace(ctx, abs) && st.isFile() && !FILE_EXT.test(abs)) {
    return { error: `${abs}: outside the workspace and not a spectrum file (.dat, .txt, .csv, .out)` };
  }
  return { path: abs };
}

/** Parses `<source>:<path>`; the path must be inside the workspace or among `allowed`. */
export function parseId(ctx: HostContext, id: unknown, allowed: Set<string>): { source: ItemSource; path: string } {
  if (typeof id !== 'string') {
    throw new Error('invalid id');
  }
  const m = /^(file|out|outdir|geom):(.+)$/s.exec(id);
  if (!m) {
    throw new Error(`invalid id ${id}`);
  }
  const p = norm(m[2]);
  if (!insideWorkspace(ctx, p) && !allowed.has(p) && ![...allowed].some(a => sameOrInside(p, a))) {
    throw new Error(`${p} is outside the workspace; add it with "Add files…" first`);
  }
  return { source: m[1] as ItemSource, path: p };
}

export const makeId = (source: ItemSource, p: string) => `${source}:${p}`;

// ---------------------------------------------------------------- caches

interface CacheEntry<T> {
  key: string;
  value: T;
}
const caches = new Map<string, CacheEntry<unknown>>();

function cached<T>(kind: string, p: string, key: string, compute: () => T): T {
  const k = `${kind}|${p}`;
  const hit = caches.get(k);
  if (hit && hit.key === key) {
    return hit.value as T;
  }
  const value = compute();
  caches.set(k, { key, value });
  if (caches.size > 4000) {
    caches.delete(caches.keys().next().value as string);
  }
  return value;
}

/** For tests. */
export function clearCaches(): void {
  caches.clear();
}

function fileKey(p: string): { key: string; st: fs.Stats } {
  const st = fs.statSync(p);
  return { key: `${st.mtimeMs}:${st.size}`, st };
}

// ---------------------------------------------------------------- spectrum files

/** File stem without the PyNEAppLES suffixes (.nm.cross.dat → stem). */
export function spectrumStem(file: string): string {
  let b = path.basename(file);
  b = b.replace(/\.(cross|int)\.(dat|txt)$/i, '').replace(/\.(dat|txt|csv|tsv|xy)$/i, '');
  b = b.replace(/\.(nm|ev|cm|cm-1)$/i, '');
  return b;
}

export function readNea(p: string): NeaSpectrum {
  const { key } = fileKey(p);
  return cached('nea', p, key, () => parseNeaSpectrum(fs.readFileSync(p, 'utf8'), { unit: unitFromFileName(path.basename(p)) }));
}

export function readExperiment(p: string): ExperimentSpectrum & { unit: SpectrumXUnit } {
  const { key } = fileKey(p);
  return cached('exp', p, key, () => {
    const e = parseTwoColumn(fs.readFileSync(p, 'utf8'), { dropNonPositive: true });
    return { ...e, unit: unitFromFileName(path.basename(p)) ?? detectXUnit(e.x) };
  });
}

// ---------------------------------------------------------------- sticks

export interface StickSet {
  sticks: StateStick[];
  nGeometries: number;
  nStates: number;
  skipped: number;
  silverman: number;
  /** Per-geometry reasons for skipping (first few). */
  notes: string[];
}

function excitationsOf(text: string): { ok: boolean; sticks: StateStick[] } {
  const parsed = parseOrcaOutput(text);
  const job = [...parsed.jobs].reverse().find(j => j.excitations && j.excitations.length > 0);
  const sticks = (job?.excitations ?? []).map((e, i) => ({ energyEv: e.energyEv, weight: e.fosc, state: i }));
  return { ok: parsed.status === 'normal-termination', sticks };
}

/** One ORCA output: its last ABSORPTION SPECTRUM (electric dipole) table. */
export function readOut(p: string): StickSet {
  const { key } = fileKey(p);
  return cached('out', p, key, () => {
    const { sticks } = excitationsOf(fs.readFileSync(p, 'utf8'));
    if (sticks.length === 0) {
      throw new Error(`${path.basename(p)}: no ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS table`);
    }
    return { sticks, nGeometries: 1, nStates: sticks.length, skipped: 0, silverman: silvermanBandwidth(sticks), notes: [] };
  });
}

/**
 * Folder of per-geometry .out files (spectrumPanel's quick NEA average):
 * outputs that terminated normally and have an excitation table count as
 * geometries, everything else is skipped.
 */
export async function readOutFolder(ctx: HostContext, dir: string): Promise<StickSet> {
  const files = await ctx.findFiles('**/*.out', { base: dir });
  const keys = files.map(f => `${f}@${fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0}`).join('|');
  return cached('outdir', dir, `${files.length}:${hash(keys)}`, () => {
    const sticks: StateStick[] = [];
    let n = 0;
    let skipped = 0;
    let nStates = 0;
    const notes: string[] = [];
    for (const f of files) {
      let r: { ok: boolean; sticks: StateStick[] };
      try {
        const { key } = fileKey(f);
        r = cached('outparse', f, key, () => excitationsOf(fs.readFileSync(f, 'utf8')));
      } catch {
        r = { ok: false, sticks: [] };
      }
      if (!r.ok || r.sticks.length === 0) {
        skipped++;
        if (notes.length < 5) notes.push(`${path.relative(dir, f)}: ${r.ok ? 'no excitation table' : 'did not terminate normally'}`);
        continue;
      }
      n++;
      nStates = Math.max(nStates, r.sticks.length);
      sticks.push(...r.sticks);
    }
    if (n === 0) {
      throw new Error(`${path.basename(dir)}: no finished .out file with an excitation table (${files.length} .out files)`);
    }
    return { sticks, nGeometries: n, nStates, skipped, silverman: silvermanBandwidth(sticks), notes };
  });
}

interface AdcResult {
  converged?: boolean;
  excitation_energies_ev?: number[];
  oscillator_strengths?: number[];
}

/**
 * geom_NNNN/result.json set (same status rules as chem/neaRun readGeomSet:
 * missing = not started, invalid JSON = unreadable, converged false = not
 * converged), keeping the state index of every stick.
 */
export function readGeomSticks(dir: string): StickSet {
  const names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && /^geom_\d+$/.test(e.name)).map(e => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const stats = names.map(n => fs.statSync(path.join(dir, n, 'result.json'), { throwIfNoEntry: false }));
  const key = `${names.length}:${hash(stats.map(s => (s ? `${s.mtimeMs}:${s.size}` : '-')).join('|'))}`;
  return cached('geom', dir, key, () => {
    const sticks: StateStick[] = [];
    let n = 0;
    let skipped = 0;
    let nStates = 0;
    const counts = { 'not started': 0, unreadable: 0, 'not converged': 0 };
    names.forEach((name, i) => {
      if (!stats[i]) {
        counts['not started']++;
        skipped++;
        return;
      }
      let r: AdcResult;
      try {
        r = JSON.parse(fs.readFileSync(path.join(dir, name, 'result.json'), 'utf8'));
      } catch {
        counts.unreadable++;
        skipped++;
        return;
      }
      if (!r || !r.converged) {
        counts['not converged']++;
        skipped++;
        return;
      }
      const e = r.excitation_energies_ev ?? [];
      const f = r.oscillator_strengths ?? [];
      const k = Math.min(e.length, f.length);
      for (let s = 0; s < k; s++) {
        if (Number.isFinite(e[s]) && Number.isFinite(f[s])) sticks.push({ energyEv: e[s], weight: f[s], state: s });
      }
      nStates = Math.max(nStates, k);
      n++;
    });
    if (n === 0) {
      throw new Error(`${path.basename(dir)}: no converged geometry (${names.length} geom_* folders: ${Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'})`);
    }
    const notes = Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`);
    return { sticks, nGeometries: n, nStates, skipped, silverman: silvermanBandwidth(sticks), notes };
  });
}

export async function readSticks(ctx: HostContext, source: ItemSource, p: string): Promise<StickSet> {
  if (source === 'out') return readOut(p);
  if (source === 'outdir') return readOutFolder(ctx, p);
  if (source === 'geom') return readGeomSticks(p);
  throw new Error(`${p} is not a stick source`);
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------- library

function fieldsFor(stem: string, s: Settings): Record<string, string> {
  try {
    return parseSpectrumName(stem, s.pattern);
  } catch {
    return { name: stem };
  }
}

function fileItem(p: string, s: Settings, experiment: boolean, added: boolean): LibraryItem {
  const st = fs.statSync(p);
  const name = spectrumStem(p);
  const item: LibraryItem = {
    id: makeId('file', p), path: p, source: 'file', kind: experiment ? 'exp' : 'nea', name, fields: fieldsFor(name, s),
    xUnit: 'nm', size: st.size, mtimeMs: st.mtimeMs, hasCi: false, nStates: 0, added
  };
  try {
    if (experiment) {
      const e = readExperiment(p);
      item.xUnit = e.unit;
      if (e.x.length < 2) item.error = 'fewer than 2 data points';
    } else {
      const d = readNea(p);
      item.xUnit = d.unit;
      item.hasCi = !!d.lo;
      item.nStates = d.states.length;
      if (d.x.length < 2) item.error = 'fewer than 2 data points';
    }
  } catch (e) {
    // a 3-column or odd file may still read as an experiment
    if (!experiment) {
      try {
        const ex = readExperiment(p);
        if (ex.x.length >= 2) {
          item.kind = 'exp';
          item.xUnit = ex.unit;
          return item;
        }
      } catch {
        // fall through
      }
    }
    item.error = e instanceof Error ? e.message : String(e);
  }
  return item;
}

async function stickItem(ctx: HostContext, source: ItemSource, p: string, s: Settings, label?: string): Promise<LibraryItem> {
  const st = fs.statSync(p);
  const name = label ?? (source === 'out' ? path.basename(p).replace(/(\.inp)?\.out$/i, '') : path.basename(p));
  const item: LibraryItem = {
    id: makeId(source, p), path: p, source, kind: 'sticks', name, fields: fieldsFor(name, s),
    xUnit: 'eV', size: st.isFile() ? st.size : 0, mtimeMs: st.mtimeMs, hasCi: false, nStates: 0, added: true
  };
  try {
    const set = await readSticks(ctx, source, p);
    item.nGeometries = set.nGeometries;
    item.nStates = set.nStates;
    item.skipped = set.skipped;
    item.silverman = set.silverman;
    item.defaultH = set.nGeometries > 1 ? set.silverman : s.singleH;
    item.size = set.nGeometries;
    if (!('n' in item.fields)) item.fields.n = String(set.nGeometries);
  } catch (e) {
    item.error = e instanceof Error ? e.message : String(e);
  }
  return item;
}

/** Entries for an added path: a file, or a folder (geom sets, else .out files, else spectrum files). */
export async function itemsForPath(ctx: HostContext, p: string, s: Settings): Promise<LibraryItem[]> {
  const st = fs.statSync(p);
  if (st.isFile()) {
    if (/\.out$/i.test(p)) {
      return [await stickItem(ctx, 'out', p, s)];
    }
    return [fileItem(p, s, matchesAny(ctx, p, s.experimentGlobs), true)];
  }
  const sets = findGeomSets(p);
  if (sets.length) {
    const base = path.basename(p);
    return Promise.all(sets.map(d => stickItem(ctx, 'geom', d, s, d === p ? base : `${base}/${path.relative(p, d).replace(/\\/g, '/')}`)));
  }
  const outs = await ctx.findFiles('**/*.out', { base: p, max: 1 });
  if (outs.length) {
    return [await stickItem(ctx, 'outdir', p, s)];
  }
  const files = fs.readdirSync(p).filter(f => /\.(dat|txt|csv)$/i.test(f)).map(f => path.join(p, f));
  return files.map(f => fileItem(f, s, matchesAny(ctx, f, s.experimentGlobs), true));
}

function matchesAny(ctx: HostContext, p: string, globs: string[]): boolean {
  const rel = ctx.workspaceFolders().map(w => path.relative(w, p)).find(r => !r.startsWith('..') && !path.isAbsolute(r));
  if (rel === undefined) return false;
  const posix = rel.replace(/\\/g, '/');
  return globs.some(g => globToRegExp(g).test(posix));
}

/** Minimal glob → RegExp (**, *, ?, {a,b}) for classifying added files. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export async function buildLibrary(ctx: HostContext, extra: string[]): Promise<LibraryResult & { allowed: Set<string> }> {
  const s = readSettings(ctx);
  const warnings = [...s.warnings];
  const seen = new Set<string>();
  const items: LibraryItem[] = [];
  const add = (it: LibraryItem) => {
    if (!seen.has(it.id)) {
      seen.add(it.id);
      items.push(it);
    }
  };
  const find = async (globs: string[]) => {
    const out: string[] = [];
    for (const g of globs) {
      try {
        out.push(...(await ctx.findFiles(g, { max: 2000 })));
      } catch (e) {
        warnings.push(`glob ${g}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return [...new Set(out.map(norm))];
  };
  const expFiles = new Set(await find(s.experimentGlobs));
  for (const p of await find(s.spectraGlobs)) {
    if (!expFiles.has(p)) add(fileItem(p, s, false, false));
  }
  for (const p of expFiles) add(fileItem(p, s, true, false));
  const allowed = new Set<string>();
  for (const raw of extra) {
    const v = validateExtraPath(ctx, raw);
    if (!v.path) {
      warnings.push(`added path skipped: ${v.error}`);
      continue;
    }
    allowed.add(v.path);
    try {
      for (const it of await itemsForPath(ctx, v.path, s)) {
        const known = items.find(x => x.id === it.id);
        if (known) known.added = true; else add(it);
      }
    } catch (e) {
      warnings.push(`${v.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { items, fieldNames: s.fieldNames, spectraGlobs: s.spectraGlobs, experimentGlobs: s.experimentGlobs, warnings, allowed };
}
