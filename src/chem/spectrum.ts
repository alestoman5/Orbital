// Spectrum helpers for quick looks at excited-state output: unit
// conversions, Gaussian broadening of stick spectra, Silverman bandwidth,
// band descriptors (maximum, centroid, FWHM, integral), and the PyNEAppLES
// calc_spectrum_v2.py input format. The production NEA spectrum (bootstrap
// intervals etc.) is still PyNEAppLES' job; this is for previews and export.
// Pure logic, no `vscode` import.

import { EV_NM, EV_TO_CM1, HARTREE_TO_EV, HARTREE_TO_KCALMOL, HARTREE_TO_KJMOL, KB_HARTREE } from './elements';
import { Excitation } from '../outparser/types';

export type EnergyUnit = 'Eh' | 'eV' | 'nm' | 'cm-1' | 'kcal/mol' | 'kJ/mol';

/** Converts an energy (or wavelength) between units. nm is handled as hc/E. */
export function convertEnergy(value: number, from: EnergyUnit, to: EnergyUnit): number {
  const toEv: Record<EnergyUnit, (v: number) => number> = {
    'Eh': v => v * HARTREE_TO_EV,
    'eV': v => v,
    'nm': v => EV_NM / v,
    'cm-1': v => v / EV_TO_CM1,
    'kcal/mol': v => (v / HARTREE_TO_KCALMOL) * HARTREE_TO_EV,
    'kJ/mol': v => (v / HARTREE_TO_KJMOL) * HARTREE_TO_EV
  };
  const fromEv: Record<EnergyUnit, (v: number) => number> = {
    'Eh': v => v / HARTREE_TO_EV,
    'eV': v => v,
    'nm': v => EV_NM / v,
    'cm-1': v => v * EV_TO_CM1,
    'kcal/mol': v => (v / HARTREE_TO_EV) * HARTREE_TO_KCALMOL,
    'kJ/mol': v => (v / HARTREE_TO_EV) * HARTREE_TO_KJMOL
  };
  return fromEv[to](toEv[from](value));
}

export interface Stick {
  energyEv: number;
  /** Weight — oscillator strength f (or |mu|^2). */
  weight: number;
}

/**
 * Weighted Silverman bandwidth h = (4/3n)^(1/5) * s, with s the weighted
 * standard deviation of energies and n Kish's effective sample size
 * (Σw)² / Σw² — the same rule PyNEAppLES' "-a silverman" uses.
 */
export function silvermanBandwidth(sticks: Stick[]): number {
  const w = sticks.map(s => Math.max(s.weight, 0));
  const sw = w.reduce((a, b) => a + b, 0);
  if (!(sw > 0) || sticks.length < 2) {
    return 0.1;
  }
  const mean = sticks.reduce((acc, s, i) => acc + w[i] * s.energyEv, 0) / sw;
  const variance = sticks.reduce((acc, s, i) => acc + w[i] * (s.energyEv - mean) ** 2, 0) / sw;
  const nEff = (sw * sw) / w.reduce((a, b) => a + b * b, 0);
  const h = Math.pow(4 / (3 * nEff), 1 / 5) * Math.sqrt(variance);
  return h > 0 ? h : 0.1;
}

/**
 * Sum of normalized Gaussians (width h, eV) weighted by stick weight,
 * divided by the number of geometries `nGeometries` (NEA average). Output
 * is in "f per eV" — proportional to the cross section up to the E·const
 * prefactor, which previews leave out.
 */
export function broaden(sticks: Stick[], grid: number[], h: number, nGeometries = 1): number[] {
  const norm = 1 / (h * Math.sqrt(2 * Math.PI) * Math.max(nGeometries, 1));
  return grid.map(E =>
    sticks.reduce((acc, s) => acc + s.weight * Math.exp(-((E - s.energyEv) ** 2) / (2 * h * h)), 0) * norm
  );
}

export function linspace(a: number, b: number, n: number): number[] {
  if (n < 2) {
    return [a];
  }
  const step = (b - a) / (n - 1);
  return Array.from({ length: n }, (_, i) => a + i * step);
}

export interface BandDescriptors {
  maxX: number;
  centroid: number;
  fwhm: number;
  integral: number;
}

/** λmax, centroid ∫xσ/∫σ, FWHM (outermost half-maximum crossings) and ∫σ dx via trapezoids. */
export function describeBand(x: number[], y: number[]): BandDescriptors {
  let iMax = 0;
  for (let i = 1; i < y.length; i++) {
    if (y[i] > y[iMax]) {
      iMax = i;
    }
  }
  let integral = 0;
  let moment = 0;
  for (let i = 1; i < x.length; i++) {
    const dx = x[i] - x[i - 1];
    integral += 0.5 * (y[i] + y[i - 1]) * dx;
    moment += 0.5 * (x[i] * y[i] + x[i - 1] * y[i - 1]) * dx;
  }
  const half = y[iMax] / 2;
  const cross = (i: number) => x[i - 1] + ((half - y[i - 1]) * (x[i] - x[i - 1])) / (y[i] - y[i - 1]);
  let left = x[0];
  let right = x[x.length - 1];
  for (let i = 1; i <= iMax; i++) {
    if (y[i - 1] < half && y[i] >= half) {
      left = cross(i);
      break;
    }
  }
  for (let i = y.length - 1; i > iMax; i--) {
    if (y[i] < half && y[i - 1] >= half) {
      right = cross(i);
      break;
    }
  }
  return { maxX: x[iMax], centroid: integral !== 0 ? moment / integral : NaN, fwhm: Math.abs(right - left), integral };
}

export interface PyneapplesExport {
  text: string;
  nUsed: number;
  nStates: number;
  skipped: { name: string; reason: string }[];
}

/**
 * Transition dipole (au) for export. ORCA prints DX/DY/DZ with only 5
 * decimals but fosc with 9, so the magnitude is taken from fosc,
 * |μ| = sqrt(3 f / (2 ΔE[au])), and the direction from DX/DY/DZ (along x
 * if those all round to zero). PyNEAppLES uses only |μ|², which this keeps
 * as precise as ORCA's fosc.
 */
export function transitionDipoleFromFosc(e: Excitation): [number, number, number] {
  const eAu = e.energyEv / HARTREE_TO_EV;
  const mag = e.fosc > 0 && eAu > 0 ? Math.sqrt((3 * e.fosc) / (2 * eAu)) : 0;
  const n = Math.hypot(e.dx, e.dy, e.dz);
  if (n === 0) {
    return [mag, 0, 0];
  }
  return [(mag * e.dx) / n, (mag * e.dy) / n, (mag * e.dz) / n];
}

/**
 * Builds the calc_spectrum_v2.py input: per geometry (in the given order),
 * per state: a line with the excitation energy in eV, then a line
 * "DX DY DZ" with the transition dipole in au (see transitionDipoleFromFosc). Geometries whose run did
 * not terminate normally or that lack exactly `nStates` transitions are
 * skipped and reported, so `-n` can be set to `nUsed` — a mismatch there
 * silently breaks the absolute cross-section normalization.
 */
export function buildPyneapplesInput(
  runs: { name: string; ok: boolean; status?: string; excitations?: Excitation[] }[],
  nStates: number
): PyneapplesExport {
  const lines: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let nUsed = 0;
  for (const run of runs) {
    if (!run.ok) {
      const reason =
        run.status === 'unknown' ? 'empty or not an ORCA output'
          : run.status === 'running' ? 'unfinished (still running, or killed)'
            : 'did not terminate normally';
      skipped.push({ name: run.name, reason });
      continue;
    }
    const exc = run.excitations;
    if (!exc || exc.length === 0) {
      skipped.push({ name: run.name, reason: 'no ABSORPTION SPECTRUM table' });
      continue;
    }
    if (exc.length !== nStates) {
      skipped.push({ name: run.name, reason: `${exc.length} transitions, expected ${nStates}` });
      continue;
    }
    for (const e of exc) {
      const [dx, dy, dz] = transitionDipoleFromFosc(e);
      lines.push(e.energyEv.toFixed(6));
      lines.push(`${dx.toFixed(10)} ${dy.toFixed(10)} ${dz.toFixed(10)}`);
    }
    nUsed++;
  }
  return { text: lines.join('\n') + (lines.length ? '\n' : ''), nUsed, nStates, skipped };
}

/** Boltzmann populations from free energies (hartree) at temperature T (K). */
export function boltzmannWeights(gibbsHartree: number[], temperatureK: number): number[] {
  const kT = KB_HARTREE * temperatureK;
  const gMin = Math.min(...gibbsHartree);
  const raw = gibbsHartree.map(g => Math.exp(-(g - gMin) / kT));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map(r => r / sum);
}
