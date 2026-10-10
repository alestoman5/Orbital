// Pure helpers of the "inputs" tab shared by its host side (host.ts) and its
// webview side (webview/src/tabs/inputs/): formula, default file names, which
// form sections apply to a spec, and matching validation issues to fields.
// No Node / DOM / vscode imports.

import type { GeometryAtom } from '../../../outparser/types';
import { canonicalSymbol } from '../../../chem/elements';
import type { InputSpec, Program, SpecIssue } from '../../../inputs/spec';
import { isMultireference, isTsSearch, hasFrequencies, normalizeSpec } from '../../../inputs/spec';

/** Element counts in Hill order: C, H, then alphabetical (all alphabetical without carbon). */
export function formulaParts(atoms: GeometryAtom[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const a of atoms) {
    const s = canonicalSymbol(a.symbol);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const keys = [...counts.keys()].sort();
  const order = counts.has('C')
    ? ['C', ...(counts.has('H') ? ['H'] : []), ...keys.filter(k => k !== 'C' && k !== 'H')]
    : keys;
  return order.map(k => [k, counts.get(k)!]);
}

/** "CH2O2" (ASCII). */
export function formula(atoms: GeometryAtom[]): string {
  return formulaParts(atoms).map(([s, n]) => (n > 1 ? `${s}${n}` : s)).join('');
}

const SUB: Record<string, string> = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };

/** "CH₂O₂" (Unicode subscripts) for display. */
export function formulaUnicode(atoms: GeometryAtom[]): string {
  return formulaParts(atoms).map(([s, n]) => (n > 1 ? s + String(n).split('').map(d => SUB[d]).join('') : s)).join('');
}

/** "CH₂O₂ · 5 atoms". */
export function geometrySummary(atoms: GeometryAtom[]): string {
  if (atoms.length === 0) {
    return 'No atoms';
  }
  return `${formulaUnicode(atoms)} · ${atoms.length} atom${atoms.length === 1 ? '' : 's'}`;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Short method tag: functional for DFT ("camb3lyp"), otherwise the family ("ccsdt"). */
export function methodSlug(spec: InputSpec): string {
  const exc = spec.excited.method;
  if (spec.method.family === 'hf' && exc !== 'none' && exc !== 'tddft') {
    return ''; // ADC / EOM: the excited-state tag says it all
  }
  if (spec.method.family === 'dft') {
    return slug(spec.method.functional) || 'dft';
  }
  return slug(spec.method.family);
}

/** What the job does: excited-state method, else the job type ("tddft", "adc3", "optfreq", "sp"). */
export function jobSlug(spec: InputSpec): string {
  if (spec.excited.method !== 'none') {
    return slug(spec.excited.method);
  }
  return slug(spec.job);
}

export function extensionFor(program: Program): string {
  return program === 'orca' ? '.inp' : '.py';
}

/**
 * Default file name, e.g. "ch2o2_camb3lyp_tddft.inp", "ch2o2_adc3.py".
 * Without atoms the stem of `sourceName` (or "job") stands in for the formula.
 */
export function defaultFileName(spec: InputSpec, program: Program, sourceName?: string): string {
  const head = spec.geometry.atoms.length > 0
    ? slug(formula(spec.geometry.atoms))
    : slug((sourceName ?? '').replace(/\.[^.]*$/, '')) || 'job';
  const parts = [head, methodSlug(spec), jobSlug(spec)].filter(Boolean);
  return parts.join('_') + extensionFor(program);
}

/** Makes a user-typed file name safe and gives it the program's extension. */
export function normalizeFileName(name: string, program: Program): string {
  const ext = extensionFor(program);
  let base = name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');
  base = base.replace(/\.(inp|py)$/i, '');
  return (base || 'job') + ext;
}

/** Form sections that apply to a spec (the rest are hidden). */
export interface Relevance {
  functional: boolean;
  basis: boolean;
  pno: boolean;
  dispersion: boolean;
  ri: boolean;
  auxC: boolean;
  cas: boolean;
  scan: boolean;
  ts: boolean;
  freq: boolean;
  excitedOptions: boolean;
  tda: boolean;
  frozenCore: boolean;
  optConvergence: boolean;
}

/** `functionalKind`: catalog kind of spec.method.functional (catalog.functionalInfo), if known. */
export function relevance(spec: InputSpec, functionalKind?: string): Relevance {
  const fam = spec.method.family;
  const compositeFunctional = fam === 'dft' && functionalKind === 'composite';
  const exc = spec.excited.method;
  return {
    functional: fam === 'dft',
    basis: !(fam === 'dft' && compositeFunctional),
    pno: fam === 'dlpno-ccsd(t)',
    dispersion: fam === 'dft' || fam === 'hf',
    ri: !compositeFunctional,
    auxC: fam === 'mp2' || fam === 'dlpno-ccsd(t)' || (fam === 'dft' && functionalKind === 'double-hybrid'),
    cas: isMultireference(fam),
    scan: spec.job === 'scan',
    ts: isTsSearch(spec.job),
    freq: hasFrequencies(spec.job),
    excitedOptions: exc !== 'none',
    tda: exc === 'tddft',
    frozenCore: (fam !== 'hf' && fam !== 'dft') || (exc !== 'none' && exc !== 'tddft'),
    optConvergence: spec.job !== 'sp' && spec.job !== 'freq'
  };
}

/** True when `issue.path` belongs to the field at `fieldPath` ("scan.atoms" matches "scan.atoms[1]"). */
export function issueMatches(issue: SpecIssue, fieldPath: string): boolean {
  const p = issue.path;
  return p === fieldPath || p.startsWith(fieldPath + '.') || p.startsWith(fieldPath + '[');
}

/** Issues sorted errors first, then warnings, then info; stable otherwise. */
export function sortIssues(issues: SpecIssue[]): SpecIssue[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return issues.map((i, k) => ({ i, k })).sort((a, b) => rank[a.i.severity] - rank[b.i.severity] || a.k - b.k).map(x => x.i);
}

/** "12 MB", "1.4 kB". */
export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} kB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "8 GB" for nprocs × maxcore (decimal units, as %maxcore and queue requests count MB). */
export function totalMemoryLabel(nprocs: number, maxcoreMB: number): string {
  const mb = nprocs * maxcoreMB;
  if (!Number.isFinite(mb) || mb <= 0) {
    return '–';
  }
  return mb >= 1000 ? `${Number((mb / 1000).toFixed(1))} GB` : `${mb} MB`;
}

/** `spec` with the fields of `patch` set (nested groups such as `excited` merged one level deep). */
export function mergeSpec(spec: InputSpec, patch: Record<string, unknown>): InputSpec {
  const out: Record<string, unknown> = { ...(spec as unknown as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    const cur = out[k];
    out[k] = cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)
      ? { ...(cur as object), ...(v as object) }
      : v;
  }
  return normalizeSpec(out);
}
