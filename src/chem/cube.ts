// Gaussian cube files (ORCA %plots Format Gaussian_Cube, orca_plot, cubegen):
// two comment lines, natoms + origin, three axis lines (n + step vector),
// natoms atom lines (Z, charge, x, y, z), an optional MO id line when natoms
// is negative, then n1·n2·n3 values with the third index fastest. Lengths
// are converted to Å (a negative axis count means the file is already in Å).
// Pure logic, no `vscode` import.

import { BOHR_TO_ANGSTROM } from './elements';

const SYMBOLS = [
  'X', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar',
  'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr',
  'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe',
  'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu',
  'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn'
];

export interface CubeAtom {
  atomicNumber: number;
  symbol: string;
  /** Å */
  x: number;
  y: number;
  z: number;
}

export interface CubeGrid {
  comments: [string, string];
  /** Origin in Å. */
  origin: [number, number, number];
  /** Points along each axis. */
  n: [number, number, number];
  /** Step vectors in Å (rows = axes). */
  axes: [[number, number, number], [number, number, number], [number, number, number]];
  atoms: CubeAtom[];
  /** MO numbers from the id line of a negative-natoms file (as written, usually 1-based in Gaussian, ORCA writes its own index). */
  moIds: number[];
  /** Values of the first (or only) data set, index (i·n2 + j)·n3 + k. */
  values: Float32Array;
  /** Number of data sets stored per grid point (only the first is read into `values`). */
  nSets: number;
}

/** Parses a cube file. Throws on a malformed header or too few values. */
export function parseCube(text: string): CubeGrid {
  const lines = text.split(/\r?\n/);
  if (lines.length < 6) throw new Error('Cube file: header too short.');
  const nums = (l: string | undefined, what: string): number[] => {
    const v = (l ?? '').trim().split(/\s+/).map(Number);
    if (v.length < 4 || v.slice(0, 4).some(x => !Number.isFinite(x))) throw new Error(`Cube file: malformed ${what} line.`);
    return v;
  };
  const h = nums(lines[2], 'natoms/origin');
  const natRaw = Math.trunc(h[0]);
  const nat = Math.abs(natRaw);
  const nSetsHeader = h.length >= 5 && Number.isInteger(h[4]) && h[4] > 1 ? h[4] : 1;
  const n: number[] = [];
  const axes: number[][] = [];
  let unit = BOHR_TO_ANGSTROM;
  for (let a = 0; a < 3; a++) {
    const v = nums(lines[3 + a], 'axis');
    const cnt = Math.trunc(v[0]);
    if (cnt === 0) throw new Error('Cube file: zero points along an axis.');
    if (cnt < 0) unit = 1;
    n.push(Math.abs(cnt));
    axes.push([v[1], v[2], v[3]]);
  }
  const atoms: CubeAtom[] = [];
  for (let i = 0; i < nat; i++) {
    const v = nums(lines[6 + i], 'atom');
    const v4 = (v[4] ?? NaN);
    const zz = Math.trunc(v[0]);
    atoms.push({ atomicNumber: zz, symbol: SYMBOLS[zz] ?? 'X', x: v[2] * unit, y: v[3] * unit, z: v4 * unit });
  }
  let line = 6 + nat;
  let moIds: number[] = [];
  let nSets = nSetsHeader;
  if (natRaw < 0) {
    const v = (lines[line] ?? '').trim().split(/\s+/).map(Number);
    const count = Math.trunc(v[0]);
    moIds = v.slice(1, 1 + count).filter(Number.isFinite);
    nSets = Math.max(1, count);
    line++;
  }
  const total = n[0] * n[1] * n[2];
  const values = new Float32Array(total);
  let k = 0;
  let seen = 0;
  for (; line < lines.length && k < total; line++) {
    const l = lines[line];
    let p = 0;
    const len = l.length;
    while (p < len && k < total) {
      while (p < len && (l.charCodeAt(p) === 32 || l.charCodeAt(p) === 9)) p++;
      if (p >= len) break;
      let q = p;
      while (q < len && l.charCodeAt(q) !== 32 && l.charCodeAt(q) !== 9) q++;
      const x = Number(l.slice(p, q));
      if (!Number.isFinite(x)) throw new Error(`Cube file: bad value on line ${line + 1}.`);
      if (seen % nSets === 0) values[k++] = x;
      seen++;
      p = q;
    }
  }
  if (k < total) throw new Error(`Cube file: expected ${total} values, found ${k}.`);
  return {
    comments: [lines[0] ?? '', lines[1] ?? ''],
    origin: [h[1] * unit, h[2] * unit, h[3] * unit],
    n: n as [number, number, number],
    axes: axes.map(r => r.map(x => x * unit)) as CubeGrid['axes'],
    atoms,
    moIds,
    values,
    nSets
  };
}

/** Largest |value| and the value range, for a default isovalue. */
export function cubeStats(g: CubeGrid): { min: number; max: number; absMax: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of g.values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max, absMax: Math.max(Math.abs(min), Math.abs(max)) };
}

/**
 * MO index guessed from an ORCA-style file name ("cis_mo33.cube",
 * "trans.mo34a.cube", "mol.mo5b.cube") — the index ORCA uses in MO("…",33,0).
 */
export function moFromCubeName(name: string): { mo: number; spin: 'a' | 'b' } | undefined {
  const m = /(?:^|[._-])mo_?(\d+)([ab])?(?=[._-]|\.cube$)/i.exec(name);
  if (!m) return undefined;
  return { mo: parseInt(m[1], 10), spin: m[2]?.toLowerCase() === 'b' ? 'b' : 'a' };
}
