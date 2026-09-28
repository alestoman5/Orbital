// Normal-mode helpers: imaginary-mode detection, displacement along a mode
// (saddle point -> nudged restart geometry), Molden export in the layout
// SHARC's wigner.py reads, and a "ready for Wigner sampling?" report.
// Pure logic, no `vscode` import.

import { BOHR_TO_ANGSTROM } from './elements';
import { VibrationalData, hessAtomsToGeometry } from './hess';
import { GeometryAtom, JobSegment } from '../outparser/types';

/** Default cut-off below which a negative frequency counts as a real imaginary mode (cm^-1). */
export const DEFAULT_IMAG_THRESHOLD = -20;

export interface ModeRef {
  /** Index into frequenciesCm1 / normalModes. */
  index: number;
  freq: number;
}

/**
 * Imaginary modes (freq < threshold), most negative first. Small negative
 * values between threshold and 0 are usually numerical noise from an
 * incompletely converged geometry or a coarse grid and are ignored.
 */
export function findImaginaryModes(frequencies: number[], threshold = DEFAULT_IMAG_THRESHOLD): ModeRef[] {
  return frequencies
    .map((freq, index) => ({ index, freq }))
    .filter(m => Number.isFinite(m.freq) && m.freq < threshold)
    .sort((a, b) => a.freq - b.freq);
}

/** Negative frequencies that are above the threshold (likely noise, still worth reporting). */
export function findSmallNegativeModes(frequencies: number[], threshold = DEFAULT_IMAG_THRESHOLD): ModeRef[] {
  return frequencies
    .map((freq, index) => ({ index, freq }))
    .filter(m => m.freq < 0 && m.freq >= threshold);
}

/**
 * Displaces `geometry` along `mode` (3N Cartesian vector, any scale) so that
 * the atom that moves most moves by exactly `maxDisplacement` Å, in the
 * direction given by `sign` (+1 or -1).
 */
export function displaceAlongMode(
  geometry: GeometryAtom[],
  mode: number[],
  maxDisplacement: number,
  sign: 1 | -1 = 1
): GeometryAtom[] {
  if (mode.length !== geometry.length * 3) {
    throw new Error(`Mode has ${mode.length} components, expected ${geometry.length * 3} (3 x ${geometry.length} atoms).`);
  }
  let maxNorm = 0;
  for (let a = 0; a < geometry.length; a++) {
    const n = Math.hypot(mode[3 * a], mode[3 * a + 1], mode[3 * a + 2]);
    maxNorm = Math.max(maxNorm, n);
  }
  if (!(maxNorm > 0)) {
    throw new Error('Mode vector is zero — cannot displace along it.');
  }
  const s = (sign * maxDisplacement) / maxNorm;
  return geometry.map((atom, a) => ({
    symbol: atom.symbol,
    x: atom.x + s * mode[3 * a],
    y: atom.y + s * mode[3 * a + 1],
    z: atom.z + s * mode[3 * a + 2]
  }));
}

/**
 * Vibrational data from a parsed .out job (frequencies + NORMAL MODES +
 * final geometry), in the same shape parseHessFile returns. Masses are
 * unknown from this source and set to 0. Returns undefined if any piece is
 * missing or the sizes disagree.
 */
export function vibrationalDataFromJob(job: JobSegment): VibrationalData | undefined {
  const geom = job.finalGeometry;
  const freqs = job.frequenciesCm1;
  const modes = job.normalModes;
  if (!geom || !freqs || !modes || freqs.length !== geom.length * 3 || modes.length !== freqs.length) {
    return undefined;
  }
  const bohr = job.finalGeometryBohr;
  return {
    atoms: bohr && bohr.length === geom.length ? bohr : geom.map(a => ({
      symbol: a.symbol,
      mass: 0,
      xBohr: a.x / BOHR_TO_ANGSTROM,
      yBohr: a.y / BOHR_TO_ANGSTROM,
      zBohr: a.z / BOHR_TO_ANGSTROM
    })),
    frequenciesCm1: freqs,
    normalModes: modes
  };
}

export { hessAtomsToGeometry };

/**
 * toFixed(6) that keeps the sign of values rounding to zero ("-0.000000"),
 * matching ORCA's own printout, which ORCA_freq.py copies verbatim.
 */
function fixedKeepSign(v: number): string {
  const s = v.toFixed(6);
  return (v < 0 || Object.is(v, -0)) && !s.startsWith('-') ? '-' + s : s;
}

/**
 * Molden normal-mode file in the exact layout SHARC's ORCA_freq.py writes
 * (and wigner.py / harmonwig read): all 3N frequencies including the six
 * (five) zero modes, coordinates in bohr, one "vibration k" block per mode,
 * and an [INT] section with the IR eps column (zeros if unknown).
 */
export function buildMolden(data: VibrationalData, intensities?: number[]): string {
  const out: string[] = ['[MOLDEN FORMAT]', '[FREQ]'];
  for (const f of data.frequenciesCm1) {
    out.push(f.toFixed(2));
  }
  out.push('[FR-COORD]');
  for (const a of data.atoms) {
    out.push(`${a.symbol} ${fixedKeepSign(a.xBohr)} ${fixedKeepSign(a.yBohr)} ${fixedKeepSign(a.zBohr)}`);
  }
  out.push('[FR-NORM-COORD]');
  data.normalModes.forEach((mode, k) => {
    out.push(`vibration ${k + 1}`);
    for (let a = 0; a < data.atoms.length; a++) {
      out.push(`${fixedKeepSign(mode[3 * a])} ${fixedKeepSign(mode[3 * a + 1])} ${fixedKeepSign(mode[3 * a + 2])} `);
    }
  });
  out.push('[INT]');
  for (let k = 0; k < data.frequenciesCm1.length; k++) {
    out.push((intensities?.[k] ?? 0).toFixed(9).padStart(16));
  }
  return out.join('\n') + '\n';
}

/** True if all atoms lie (within tol Å) on one line — then 3N-5 modes instead of 3N-6. */
export function isLinear(geometry: GeometryAtom[], tol = 1e-3): boolean {
  if (geometry.length <= 2) {
    return true;
  }
  const p0 = geometry[0];
  const p1 = geometry.find(p => Math.hypot(p.x - p0.x, p.y - p0.y, p.z - p0.z) > tol);
  if (!p1) {
    return true;
  }
  const ux = p1.x - p0.x, uy = p1.y - p0.y, uz = p1.z - p0.z;
  const un = Math.hypot(ux, uy, uz);
  return geometry.every(p => {
    const vx = p.x - p0.x, vy = p.y - p0.y, vz = p.z - p0.z;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    return Math.hypot(cx, cy, cz) / un < tol;
  });
}

// --- Wigner readiness ------------------------------------------------------------

/** hc/k_B in cm*K: x = ħω/2kT = 1.4387769 * ν̃ / (2T). */
const HC_OVER_KB = 1.438776877;

/**
 * Ratio of the quantum (Wigner, temperature T) to the classical position
 * variance of a harmonic mode: x·coth(x) with x = ħω / 2kT. ≈1 for soft
 * modes, large for stiff ones (zero-point motion dominates).
 */
export function quantumToClassicalVarianceRatio(freqCm1: number, temperatureK: number): number {
  if (temperatureK <= 0) {
    return Infinity; // classical variance -> 0 at 0 K
  }
  const x = (HC_OVER_KB * freqCm1) / (2 * temperatureK);
  return x / Math.tanh(x);
}

export interface ModeReport {
  index: number;
  freq: number;
  ratio: number;
  soft: boolean;
}

export interface WignerReadiness {
  ok: boolean;
  nAtoms: number;
  linear: boolean;
  expectedModes: number;
  /** Non-zero modes actually present. */
  foundModes: number;
  imaginary: ModeRef[];
  smallNegative: ModeRef[];
  modes: ModeReport[];
  /** Human-readable blocking problems (empty when ok). */
  problems: string[];
  /** Non-blocking caveats. */
  warnings: string[];
}

/**
 * Checks what Wigner sampling needs: a true minimum (no imaginary modes),
 * the right number of vibrational modes, and flags soft modes (below
 * `softThreshold`, default 200 cm^-1) where the harmonic approximation
 * behind Wigner sampling is questionable (torsions, large amplitudes).
 */
export function assessWignerReadiness(
  geometry: GeometryAtom[],
  frequencies: number[],
  options: { temperatureK?: number; imagThreshold?: number; softThreshold?: number; terminatedNormally?: boolean } = {}
): WignerReadiness {
  const T = options.temperatureK ?? 300;
  const soft = options.softThreshold ?? 200;
  const imagThr = options.imagThreshold ?? DEFAULT_IMAG_THRESHOLD;
  const linear = isLinear(geometry);
  const expectedModes = 3 * geometry.length - (linear ? 5 : 6);
  const vib = frequencies.map((freq, index) => ({ freq, index })).filter(m => Math.abs(m.freq) > 1e-6);
  const imaginary = findImaginaryModes(frequencies, imagThr);
  const smallNegative = findSmallNegativeModes(frequencies, imagThr);

  const problems: string[] = [];
  const warnings: string[] = [];
  if (options.terminatedNormally === false) {
    problems.push('ORCA did not terminate normally.');
  }
  if (imaginary.length > 0) {
    problems.push(
      `${imaginary.length} imaginary mode(s): ${imaginary.map(m => `${m.freq.toFixed(2)} cm⁻¹ (mode ${m.index})`).join(', ')} — ` +
      'this is a saddle point, not a minimum.'
    );
  }
  if (vib.length !== expectedModes) {
    problems.push(`Found ${vib.length} non-zero modes, expected 3N-${linear ? 5 : 6} = ${expectedModes}.`);
  }
  if (smallNegative.length > 0) {
    warnings.push(
      `Small negative frequencies (numerical noise?): ${smallNegative.map(m => m.freq.toFixed(2)).join(', ')} cm⁻¹. ` +
      'Consider tighter optimization/grid (VeryTightOpt, DefGrid3).'
    );
  }
  const modes: ModeReport[] = vib
    .filter(m => m.freq > 0)
    .map(m => ({ index: m.index, freq: m.freq, ratio: quantumToClassicalVarianceRatio(m.freq, T), soft: m.freq < soft }));
  const softModes = modes.filter(m => m.soft);
  if (softModes.length > 0) {
    warnings.push(
      `${softModes.length} soft mode(s) below ${soft} cm⁻¹ (${softModes.map(m => m.freq.toFixed(1)).join(', ')}): ` +
      'likely anharmonic (torsions, large-amplitude motion) — harmonic Wigner sampling may be inaccurate there.'
    );
  }
  return {
    ok: problems.length === 0,
    nAtoms: geometry.length,
    linear,
    expectedModes,
    foundModes: vib.length,
    imaginary,
    smallNegative,
    modes,
    problems,
    warnings
  };
}
