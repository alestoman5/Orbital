// Internal coordinates (bonds, angles, dihedrals) over GeometryAtom lists,
// the "watched coordinate" spec used by the geometry comparison table, and
// the atom-order check. Pure logic, no `vscode` import.

import { atomicNumber, canonicalSymbol } from './elements';
import { GeometryAtom } from '../outparser/types';

type Vec = [number, number, number];

const sub = (a: GeometryAtom, b: GeometryAtom): Vec => [a.x - b.x, a.y - b.y, a.z - b.z];
const dot = (u: Vec, v: Vec) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const cross = (u: Vec, v: Vec): Vec => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const norm = (u: Vec) => Math.sqrt(dot(u, u));
const RAD2DEG = 180 / Math.PI;

export function distance(a: GeometryAtom, b: GeometryAtom): number {
  return norm(sub(a, b));
}

/** Angle a-b-c in degrees (b is the vertex). */
export function angle(a: GeometryAtom, b: GeometryAtom, c: GeometryAtom): number {
  const u = sub(a, b);
  const v = sub(c, b);
  const cos = Math.max(-1, Math.min(1, dot(u, v) / (norm(u) * norm(v))));
  return Math.acos(cos) * RAD2DEG;
}

/**
 * Dihedral a-b-c-d in degrees, range (-180, 180], IUPAC sign convention
 * (positive = clockwise rotation of a onto d, looking from b to c).
 * Projects b->a and c->d onto the plane perpendicular to b->c.
 */
export function dihedral(a: GeometryAtom, b: GeometryAtom, c: GeometryAtom, d: GeometryAtom): number {
  const axis = sub(c, b);
  const n = norm(axis);
  const u: Vec = [axis[0] / n, axis[1] / n, axis[2] / n];
  const ba = sub(a, b);
  const cd = sub(d, c);
  const v: Vec = [ba[0] - u[0] * dot(ba, u), ba[1] - u[1] * dot(ba, u), ba[2] - u[2] * dot(ba, u)];
  const w: Vec = [cd[0] - u[0] * dot(cd, u), cd[1] - u[1] * dot(cd, u), cd[2] - u[2] * dot(cd, u)];
  return Math.atan2(dot(cross(u, v), w), dot(v, w)) * RAD2DEG;
}

export interface WatchedCoordinate {
  label: string;
  /** 1-based atom indices (2 = bond, 3 = angle, 4 = dihedral). */
  atoms: number[];
}

/**
 * Parses specs like "O-O: 2-3", "C-O-O: 1-2-3", "HCOO: 4-1-2-3" (label, colon,
 * dash- or space-separated 1-based atom indices). Invalid entries are
 * reported, not thrown.
 */
export function parseWatchSpec(specs: string[]): { coords: WatchedCoordinate[]; errors: string[] } {
  const coords: WatchedCoordinate[] = [];
  const errors: string[] = [];
  for (const spec of specs) {
    const m = /^\s*([^:]+):\s*([\d\s,-]+)\s*$/.exec(spec);
    if (!m) {
      errors.push(`"${spec}": expected "label: i-j[-k[-l]]" with 1-based atom indices.`);
      continue;
    }
    const atoms = m[2].split(/[\s,-]+/).filter(s => s.length > 0).map(s => parseInt(s, 10));
    if (atoms.length < 2 || atoms.length > 4 || atoms.some(n => !(n >= 1))) {
      errors.push(`"${spec}": needs 2-4 atom indices, all >= 1.`);
      continue;
    }
    coords.push({ label: m[1].trim(), atoms });
  }
  return { coords, errors };
}

/** Value of a watched coordinate (Å or degrees), or undefined if an index is out of range. */
export function measure(geometry: GeometryAtom[], coord: WatchedCoordinate): number | undefined {
  const at = coord.atoms.map(i => geometry[i - 1]);
  if (at.some(a => a === undefined)) {
    return undefined;
  }
  switch (at.length) {
    case 2: return distance(at[0], at[1]);
    case 3: return angle(at[0], at[1], at[2]);
    case 4: return dihedral(at[0], at[1], at[2], at[3]);
    default: return undefined;
  }
}

export function unitOf(coord: WatchedCoordinate): string {
  return coord.atoms.length === 2 ? 'Å' : '°';
}

/**
 * Compares the element sequence of `atoms` with a reference sequence
 * (e.g. "C O O H H"). Returns the first mismatch (0-based index) or a
 * length mismatch, undefined when they agree. Labels are normalized
 * ("c", "C1" -> "C").
 */
export function checkAtomOrder(
  atoms: string[],
  reference: string[]
): { index: number; found?: string; expected?: string } | { lengthFound: number; lengthExpected: number } | undefined {
  const a = atoms.map(canonicalSymbol);
  const r = reference.map(canonicalSymbol);
  for (let i = 0; i < Math.min(a.length, r.length); i++) {
    if (a[i] !== r[i]) {
      return { index: i, found: a[i], expected: r[i] };
    }
  }
  if (a.length !== r.length) {
    return { lengthFound: a.length, lengthExpected: r.length };
  }
  return undefined;
}

/** Sum of atomic numbers, or undefined if any label is unknown. */
export function nuclearCharge(symbols: string[]): number | undefined {
  let total = 0;
  for (const s of symbols) {
    const z = atomicNumber(s);
    if (z === undefined) {
      return undefined;
    }
    total += z;
  }
  return total;
}

/**
 * Charge/multiplicity parity: with N electrons, the multiplicity 2S+1 must
 * be odd for even N and even for odd N, and cannot exceed N+1. Returns an
 * explanation string when inconsistent, undefined when fine. Does not know
 * about ECPs — electrons replaced by an ECP come in pairs, so parity is
 * unaffected.
 */
export function checkChargeMultiplicity(symbols: string[], charge: number, multiplicity: number): string | undefined {
  const z = nuclearCharge(symbols);
  if (z === undefined || multiplicity < 1) {
    return undefined;
  }
  const electrons = z - charge;
  if (electrons < 0) {
    return `Charge ${charge} leaves ${electrons} electrons.`;
  }
  const unpaired = multiplicity - 1;
  if (unpaired > electrons) {
    return `Multiplicity ${multiplicity} needs ${unpaired} unpaired electrons, but there are only ${electrons}.`;
  }
  if ((electrons - unpaired) % 2 !== 0) {
    const parity = electrons % 2 === 0 ? 'even' : 'odd';
    const allowed = electrons % 2 === 0 ? '1, 3, 5, …' : '2, 4, 6, …';
    return `${electrons} electrons (${parity}) with charge ${charge} is incompatible with multiplicity ${multiplicity} — allowed: ${allowed}.`;
  }
  return undefined;
}
