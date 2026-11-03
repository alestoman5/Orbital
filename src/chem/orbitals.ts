// Molecular orbitals and excited states from an ORCA .out file: the ORBITAL
// ENERGIES table (RHF or UHF spin up/down), the MOLECULAR ORBITALS
// coefficient blocks (printed with `%output print[p_mos] 1 end`), and the
// CIS / TD-DFT / TDA excited-state blocks with their i → a weights, joined
// with the oscillator strengths of the absorption table. Composition of an
// MO per atom / element and its π fraction relative to a plane generalize
// photoswitch scripts/mo_character.py. Pure logic, no `vscode` import.

import { HARTREE_TO_EV } from './elements';

export interface OrbitalLevel {
  /** ORCA's 0-based MO index (as in MO("x.cube", index, op)). */
  index: number;
  occ: number;
  energyEh: number;
  energyEv: number;
}

export interface OrbitalSet {
  spin: 'restricted' | 'alpha' | 'beta';
  levels: OrbitalLevel[];
  /** Highest MO with occupation > 0, -1 if none. */
  homo: number;
}

export interface BasisFunction {
  /** 0-based atom index. */
  atom: number;
  element: string;
  /** e.g. "1s", "2pz", "1dxy", "1f+1". */
  label: string;
}

export interface MoCoefficients {
  spin: 'restricted' | 'alpha' | 'beta';
  basis: BasisFunction[];
  /** coefficients[mo][basisFunction] */
  coefficients: Map<number, Float64Array>;
  /** Energy (Eh) and occupation per MO from the block headers. */
  energies: Map<number, { energyEh: number; occ: number }>;
}

export interface ExcitationContribution {
  from: number;
  fromSpin: 'a' | 'b';
  to: number;
  toSpin: 'a' | 'b';
  /** Weight as printed (|c|² for CIS/TDA, X² − Y² style for TD-DFT). */
  weight: number;
  c?: number;
}

export interface ExcitedState {
  /** 1-based state number within its block. */
  state: number;
  /** "CIS", "TD-DFT/TDA", "TD-DFT", … as printed in the block title. */
  method: string;
  multiplicity: 'singlet' | 'triplet' | 'unrestricted';
  energyEh: number;
  energyEv: number;
  s2?: number;
  /** Oscillator strength from the absorption table, when the states could be matched. */
  fosc?: number;
  contributions: ExcitationContribution[];
}

export interface OrbitalData {
  sets: OrbitalSet[];
  coefficients: MoCoefficients[];
  states: ExcitedState[];
}

function lastIndexOfLine(lines: string[], re: RegExp): number {
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return i;
  return -1;
}

function readLevels(lines: string[], start: number): OrbitalLevel[] {
  // header "  NO   OCC          E(Eh)            E(eV)", then rows until a non-row line
  const out: OrbitalLevel[] = [];
  let i = start;
  while (i < lines.length && !/^\s*NO\s+OCC/.test(lines[i])) i++;
  for (i++; i < lines.length; i++) {
    const m = /^\s*(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$/.exec(lines[i]);
    if (!m) break;
    out.push({ index: +m[1], occ: +m[2], energyEh: +m[3], energyEv: +m[4] });
  }
  return out;
}

function homoOf(levels: OrbitalLevel[]): number {
  let h = -1;
  for (const l of levels) if (l.occ > 1e-6) h = Math.max(h, l.index);
  return h;
}

/** Last ORBITAL ENERGIES table (RHF one set, UHF spin up + spin down). */
export function parseOrbitalEnergies(lines: string[]): OrbitalSet[] {
  const at = lastIndexOfLine(lines, /^\s*ORBITAL ENERGIES\s*$/);
  if (at < 0) return [];
  const sets: OrbitalSet[] = [];
  const upAt = lines.slice(at, at + 6).findIndex(l => /SPIN UP ORBITALS/.test(l));
  if (upAt >= 0) {
    const a = readLevels(lines, at + upAt);
    const downAt = lines.findIndex((l, i) => i > at + upAt && /SPIN DOWN ORBITALS/.test(l));
    const b = downAt > 0 ? readLevels(lines, downAt) : [];
    sets.push({ spin: 'alpha', levels: a, homo: homoOf(a) });
    if (b.length) sets.push({ spin: 'beta', levels: b, homo: homoOf(b) });
  } else {
    const r = readLevels(lines, at);
    sets.push({ spin: 'restricted', levels: r, homo: homoOf(r) });
  }
  return sets;
}

const ROW_RE = /^\s*(\d+)([A-Z][a-z]?)\s+(\d+[spdfghi][a-z0-9+\-]*)\s+(.*)$/;
const IDX_RE = /^\s*\d+(\s+\d+)*\s*$/;

/**
 * Last MOLECULAR ORBITALS block. ORCA prints six MOs per column block:
 * an index line, energies, occupations, a dashed line, then one row per
 * basis function ("  0N   1pz   c c c …"). For UHF the alpha set is followed
 * by the beta set with indices starting at 0 again.
 */
export function parseMoCoefficients(lines: string[]): MoCoefficients[] {
  const at = lastIndexOfLine(lines, /^\s*MOLECULAR ORBITALS\b/);
  if (at < 0) return [];
  const restricted = /\(RHF|RKS|ROHF|ROKS/.test(lines[at]) || !/UHF|UKS/.test(lines[at]);
  const sets: MoCoefficients[] = [];
  let cur: MoCoefficients | undefined;
  let cols: number[] = [];
  let basisRow = 0;
  let firstBlock = true;
  for (let i = at + 2; i < lines.length; i++) {
    const l = lines[i];
    if (IDX_RE.test(l) && l.trim() !== '') {
      cols = l.trim().split(/\s+/).map(Number);
      if (cols[0] === 0 && (cur === undefined || cur.coefficients.size > 0)) {
        cur = { spin: restricted && sets.length === 0 ? 'restricted' : sets.length === 0 ? 'alpha' : 'beta', basis: [], coefficients: new Map(), energies: new Map() };
        sets.push(cur);
        firstBlock = true;
      } else {
        firstBlock = false;
      }
      basisRow = 0;
      const en = (lines[i + 1] ?? '').trim().split(/\s+/).map(Number);
      const oc = (lines[i + 2] ?? '').trim().split(/\s+/).map(Number);
      cols.forEach((mo, c) => {
        if (Number.isFinite(en[c])) cur!.energies.set(mo, { energyEh: en[c], occ: Number.isFinite(oc[c]) ? oc[c] : 0 });
      });
      i += 3; // energies, occupations, dashes
      continue;
    }
    const m = ROW_RE.exec(l);
    if (m && cur) {
      const vals = m[4].trim().split(/\s+/).map(Number);
      if (firstBlock) cur.basis.push({ atom: +m[1], element: m[2], label: m[3] });
      cols.forEach((mo, c) => {
        let arr = cur!.coefficients.get(mo);
        if (!arr) {
          arr = new Float64Array(0);
          cur!.coefficients.set(mo, arr);
        }
        if (arr.length <= basisRow) {
          const grown = new Float64Array(Math.max(16, (basisRow + 1) * 2));
          grown.set(arr);
          arr = grown;
          cur!.coefficients.set(mo, arr);
        }
        arr[basisRow] = vals[c] ?? NaN;
      });
      basisRow++;
      continue;
    }
    if (l.trim() === '') continue;
    break;
  }
  if (sets.length === 2 && sets[0].spin === 'restricted') {
    sets[0].spin = 'alpha';
    sets[1].spin = 'beta';
  }
  for (const s of sets) {
    const n = s.basis.length;
    for (const [k, v] of s.coefficients) s.coefficients.set(k, v.slice(0, n));
  }
  return sets;
}

const STATE_RE = /^\s*STATE\s+(\d+):\s+E=\s*(-?\d+\.\d+)\s+au\s+(-?\d+\.\d+)\s+eV(?:.*<S\*\*2>\s*=\s*(-?\d+\.\d+))?/;
const CONTRIB_RE = /^\s*(\d+)([ab])\s*->\s*(\d+)([ab])\s*:\s*(-?\d+\.\d+)(?:\s*\(c=\s*(-?\d+\.\d+)\))?/;
const BLOCK_RE = /^\s*((?:CIS|TD-DFT(?:\/TDA)?|TDA|RPA|TDHF)[A-Z/-]*)[\s-]*EXCITED STATES\s*(?:\((SINGLETS|TRIPLETS|UHF|UKS)\))?/;

/**
 * Excited-state blocks of the last excited-state calculation (singlets,
 * then triplets when both were requested). `fosc` is attached by matching
 * singlet (or unrestricted) state n to row n of the absorption table.
 */
export function parseExcitedStates(lines: string[], fosc?: number[]): ExcitedState[] {
  // blocks from the last calculation: walk back from the end, collect until a block repeats the same multiplicity
  const blocks: { start: number; method: string; mult: ExcitedState['multiplicity'] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = BLOCK_RE.exec(lines[i]);
    if (!m || !/^\s*-+\s*$/.test(lines[i + 1] ?? '')) continue;
    const mult = m[2] === 'TRIPLETS' ? 'triplet' : m[2] === 'SINGLETS' ? 'singlet' : 'unrestricted';
    const method = m[1].replace(/-$/, '');
    // a singlet (or unrestricted) block starts a new calculation; triplets belong to the one before
    if (mult !== 'triplet') blocks.length = 0;
    blocks.push({ start: i, method, mult });
  }
  const out: ExcitedState[] = [];
  for (const b of blocks) {
    let st: ExcitedState | undefined;
    let blank = 0;
    for (let i = b.start + 2; i < lines.length; i++) {
      const l = lines[i];
      const sm = STATE_RE.exec(l);
      if (sm) {
        st = { state: +sm[1], method: b.method, multiplicity: b.mult, energyEh: +sm[2], energyEv: +sm[3], s2: sm[4] !== undefined ? +sm[4] : undefined, contributions: [] };
        out.push(st);
        blank = 0;
        continue;
      }
      const cm = CONTRIB_RE.exec(l);
      if (cm && st) {
        st.contributions.push({ from: +cm[1], fromSpin: cm[2] as 'a' | 'b', to: +cm[3], toSpin: cm[4] as 'a' | 'b', weight: +cm[5], c: cm[6] !== undefined ? +cm[6] : undefined });
        blank = 0;
        continue;
      }
      if (l.trim() === '' || /<-/.test(l) || /^\s*the weight/i.test(l)) {
        if (l.trim() === '' && ++blank > 2 && st) break;
        continue;
      }
      if (st) break;
    }
  }
  if (fosc?.length) {
    const main = out.filter(s => s.multiplicity !== 'triplet');
    if (main.length === fosc.length || main.length <= fosc.length) main.forEach((s, i) => (s.fosc = fosc[i]));
  }
  for (const s of out) s.contributions.sort((a, b) => b.weight - a.weight);
  return out;
}

/** Everything orbital-related in a .out text. `fosc` = oscillator strengths of the last absorption table. */
export function parseOrbitalData(text: string, fosc?: number[]): OrbitalData {
  const lines = text.split(/\r?\n/);
  const sets = parseOrbitalEnergies(lines);
  const coefficients = parseMoCoefficients(lines);
  // ORCA may print fewer virtuals in ORBITAL ENERGIES than in the coefficient block: fill the gaps
  for (const c of coefficients) {
    let set = sets.find(s => s.spin === c.spin);
    if (!set) {
      set = { spin: c.spin, levels: [], homo: -1 };
      sets.push(set);
    }
    const have = new Set(set.levels.map(l => l.index));
    for (const [mo, e] of c.energies) {
      if (!have.has(mo)) set.levels.push({ index: mo, occ: e.occ, energyEh: e.energyEh, energyEv: e.energyEh * HARTREE_TO_EV });
    }
    set.levels.sort((a, b) => a.index - b.index);
    set.homo = homoOf(set.levels);
  }
  return { sets, coefficients, states: parseExcitedStates(lines, fosc) };
}

// --- composition ---------------------------------------------------------------------

export interface MoComposition {
  mo: number;
  /** c² fraction per atom (0-based atom index), sums to 1. */
  atoms: number[];
  /** c² fraction per element symbol. */
  elements: Record<string, number>;
  /** c² fraction by angular momentum (s, p, d, f, …). */
  shells: Record<string, number>;
  /** Fraction of c² in p functions along the plane normal; undefined without a plane. */
  pi?: number;
}

type V3 = [number, number, number];

/** Unit normal of the plane through atoms (3 atoms: their plane; 4 atoms: a–b–c–d like C2–N0=N1–C13 in mo_character.py). */
export function planeNormal(xyz: V3[], atoms: number[]): V3 | undefined {
  const p = atoms.map(i => xyz[i]);
  if (p.some(x => !x) || p.length < 3) return undefined;
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const u = p.length >= 4 ? sub(p[0], p[1]) : sub(p[1], p[0]);
  const v = p.length >= 4 ? sub(p[3], p[2]) : sub(p[2], p[0]);
  const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(...n);
  return len > 1e-8 ? [n[0] / len, n[1] / len, n[2] / len] : undefined;
}

/**
 * c² composition of one MO. Exact as a population for orthogonal bases
 * (ZINDO, NDDO methods); for ab initio bases it ignores overlap, i.e. it is
 * a rough "where are the big coefficients" measure, not a Mulliken analysis.
 * The π fraction sums (n · p)² over every p shell (same atom, same shell
 * number), with p = (cx, cy, cz).
 */
export function moComposition(set: MoCoefficients, mo: number, nAtoms: number, normal?: V3): MoComposition | undefined {
  const c = set.coefficients.get(mo);
  if (!c) return undefined;
  let total = 0;
  for (let k = 0; k < c.length; k++) total += c[k] * c[k];
  if (!(total > 0)) return undefined;
  const atoms = new Array<number>(nAtoms).fill(0);
  const elements: Record<string, number> = {};
  const shells: Record<string, number> = {};
  const pShell = new Map<string, V3>();
  set.basis.forEach((b, k) => {
    const w = (c[k] * c[k]) / total;
    if (b.atom < nAtoms) atoms[b.atom] += w;
    elements[b.element] = (elements[b.element] ?? 0) + w;
    const l = /^\d+([a-z])/.exec(b.label)?.[1] ?? '?';
    shells[l] = (shells[l] ?? 0) + w;
    const pm = /^(\d+)p([xyz])$/.exec(b.label);
    if (pm) {
      const key = `${b.atom}:${pm[1]}`;
      const v = pShell.get(key) ?? [0, 0, 0];
      v['xyz'.indexOf(pm[2])] = c[k];
      pShell.set(key, v);
    }
  });
  let pi: number | undefined;
  if (normal) {
    let s = 0;
    for (const v of pShell.values()) s += (v[0] * normal[0] + v[1] * normal[1] + v[2] * normal[2]) ** 2;
    pi = s / total;
  }
  return { mo, atoms, elements, shells, pi };
}

export { HARTREE_TO_EV };
