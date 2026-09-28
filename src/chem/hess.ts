// Parser for ORCA's .hess file (written by every Freq/NumFreq run) plus the
// shared "column-block matrix" reader used for both .hess `$normal_modes`
// and the NORMAL MODES section of a .out file. Pure logic, no `vscode`
// import.
//
// .hess layout (the parts we read):
//
//   $vibrational_frequencies
//   9
//       0        0.000000
//       ...
//       6     1044.583427
//   $normal_modes
//   9 9
//                     0          1          2          3          4
//         0       0.000000   0.000000   0.000000   0.000000   0.000000
//         ...                                    (one row per Cartesian dof)
//                     5          6          7          8
//         0       ...
//   $atoms
//   3
//    O     15.99900     0.000000000000     0.000000000000    -0.126412023021
//    ...                                     (coordinates in bohr)
//
// The matrix is printed in blocks of a few columns each (5 in .hess, 6 in
// .out) — the block width is read from each block's header row rather than
// assumed, so either layout parses.

import { BOHR_TO_ANGSTROM } from './elements';
import { GeometryAtom } from '../outparser/types';

export interface HessAtom {
  symbol: string;
  mass: number;
  /** Coordinates in bohr, exactly as stored in the .hess file. */
  xBohr: number;
  yBohr: number;
  zBohr: number;
}

export interface VibrationalData {
  /** Atoms of the reference geometry. Masses are 0 when read from a .out file. */
  atoms: HessAtom[];
  /** One entry per Cartesian degree of freedom (3N), cm^-1; negative = imaginary. */
  frequenciesCm1: number[];
  /**
   * normalModes[k] is the 3N-long displacement vector of mode k, laid out
   * as [x1, y1, z1, x2, ...]. ORCA prints these as Cartesian displacements
   * normalized to unit length (not mass-weighted), so they can be added to
   * Cartesian coordinates directly after scaling.
   */
  normalModes: number[][];
}

const INT_ROW_RE = /^\s*\d+(\s+\d+)*\s*$/;

/**
 * Reads an nRows x nCols matrix printed in ORCA's column-block layout,
 * starting at the first block header at or after `startIndex`. Returns
 * matrix[row][col] and the index after the last consumed line. Missing
 * entries (truncated file) stay NaN.
 */
export function parseColumnBlockMatrix(
  lines: string[],
  startIndex: number,
  nRows: number,
  nCols: number
): { matrix: number[][]; nextIndex: number } {
  const matrix: number[][] = [];
  for (let r = 0; r < nRows; r++) {
    matrix.push(new Array<number>(nCols).fill(NaN));
  }
  let i = startIndex;
  let filledCols = 0;
  while (filledCols < nCols && i < lines.length) {
    // Find the next header row (column indices only).
    while (i < lines.length && !INT_ROW_RE.test(lines[i])) {
      if (lines[i].trim().startsWith('$')) {
        return { matrix, nextIndex: i }; // next .hess section — stop
      }
      i++;
    }
    if (i >= lines.length) {
      break;
    }
    const cols = lines[i].trim().split(/\s+/).map(s => parseInt(s, 10));
    i++;
    for (let r = 0; r < nRows && i < lines.length; r++, i++) {
      const parts = lines[i].trim().split(/\s+/);
      const row = parseInt(parts[0], 10);
      if (!Number.isFinite(row) || row < 0 || row >= nRows) {
        break;
      }
      for (let c = 0; c < cols.length && c + 1 < parts.length; c++) {
        if (cols[c] < nCols) {
          matrix[row][cols[c]] = parseFloat(parts[c + 1]);
        }
      }
    }
    filledCols += cols.length;
  }
  return { matrix, nextIndex: i };
}

/** Transposes matrix[dof][mode] into modes[mode][dof]. */
export function columnsOf(matrix: number[][]): number[][] {
  if (matrix.length === 0) {
    return [];
  }
  const nCols = matrix[0].length;
  const out: number[][] = [];
  for (let c = 0; c < nCols; c++) {
    out.push(matrix.map(row => row[c]));
  }
  return out;
}

function findSection(lines: string[], name: string): number {
  const target = `$${name}`.toLowerCase();
  return lines.findIndex(l => l.trim().toLowerCase() === target);
}

/**
 * Parses the parts of a .hess file needed for normal-mode work. Returns
 * undefined when any of $atoms, $vibrational_frequencies or $normal_modes
 * is missing (e.g. a Hessian written by an optimization's Calc_Hess, which
 * has no frequencies yet).
 */
export function parseHessFile(text: string): VibrationalData | undefined {
  const lines = text.split(/\r\n|\r|\n/);

  const atomsAt = findSection(lines, 'atoms');
  const freqAt = findSection(lines, 'vibrational_frequencies');
  const modesAt = findSection(lines, 'normal_modes');
  if (atomsAt < 0 || freqAt < 0 || modesAt < 0) {
    return undefined;
  }

  const nAtoms = parseInt(lines[atomsAt + 1], 10);
  const atoms: HessAtom[] = [];
  for (let k = 0; k < nAtoms; k++) {
    const parts = (lines[atomsAt + 2 + k] || '').trim().split(/\s+/);
    if (parts.length < 5) {
      return undefined;
    }
    atoms.push({
      symbol: parts[0],
      mass: parseFloat(parts[1]),
      xBohr: parseFloat(parts[2]),
      yBohr: parseFloat(parts[3]),
      zBohr: parseFloat(parts[4])
    });
  }

  const nFreq = parseInt(lines[freqAt + 1], 10);
  const frequenciesCm1: number[] = [];
  for (let k = 0; k < nFreq; k++) {
    const parts = (lines[freqAt + 2 + k] || '').trim().split(/\s+/);
    frequenciesCm1.push(parseFloat(parts[1]));
  }

  const dims = lines[modesAt + 1].trim().split(/\s+/).map(s => parseInt(s, 10));
  const { matrix } = parseColumnBlockMatrix(lines, modesAt + 2, dims[0], dims[1]);

  if (frequenciesCm1.some(f => !Number.isFinite(f))) {
    return undefined;
  }
  return { atoms, frequenciesCm1, normalModes: columnsOf(matrix) };
}

/** Converts .hess atoms (bohr) to Ångström GeometryAtoms. */
export function hessAtomsToGeometry(atoms: HessAtom[]): GeometryAtom[] {
  return atoms.map(a => ({
    symbol: a.symbol,
    x: a.xBohr * BOHR_TO_ANGSTROM,
    y: a.yBohr * BOHR_TO_ANGSTROM,
    z: a.zBohr * BOHR_TO_ANGSTROM
  }));
}
