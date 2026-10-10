// Absolute absorption cross section from excitation sticks (energies and
// oscillator strengths), the nuclear-ensemble way. Pure logic, no `vscode`.
//
//   σ(E) = (π e² ħ / (2 m_e c ε₀)) · (1/N) Σ_i f_i g(E − E_i),   ∫ g dE = 1
//
// N is the number of geometries, the sum runs over every state of every
// geometry, g is a Gaussian of standard deviation h normalized in energy.
// Hence ∫σ dE = prefactor · Σf / N.
//
// Derivation / conventions:
// - Crespo-Otero & Barbatti, Theor. Chem. Acc. 131, 1237 (2012), eq. 5:
//   σ(E) = πe²ħ/(2 m_e c ε₀ n_r E) · (1/N_p) Σ ΔE_i f_i g(E − ΔE_i), with
//   n_r = 1 and ΔE_i/E ≈ 1 under the band.
// - PyNEAppLES calc_spectrum_v2.py writes σ = COEFF·|μ|²·ΔE · g / N with
//   COEFF = π·(e a₀)²·10⁴/(3 ħ ε₀ c) (cm², dipoles in au) and the dipoles from
//   osc2tdm.sh, |μ|² = 3 f / (2 ΔE[Eh]). Substituting f = 2 m_e ΔE |μ|²/(3 ħ² e²)
//   turns COEFF·|μ|²·ΔE into exactly the prefactor above times f, with no E/ΔE
//   factor, so this module reproduces PyNEAppLES' numbers for the same sticks
//   and h (the PyNEAppLES constants give 1.0976104e-16 eV cm², CODATA 2018
//   1.0976099e-16; the difference is 5e-7 relative).
// - Units: SI value 1.7585649e-39 J m² → /e (J per eV) · 10⁴ (cm² per m²)
//   = 1.0976099e-16 eV cm². With g in eV⁻¹, σ comes out in cm² molecule⁻¹.

import { Stick } from '../../../chem/spectrum';

// CODATA 2018 (exact SI values for e, ħ via h, c).
const E_CHARGE = 1.602176634e-19; // C
const HBAR = 1.054571817e-34; // J s
const M_E = 9.1093837015e-31; // kg
const C_LIGHT = 299792458; // m s⁻¹
const EPS0 = 8.8541878128e-12; // F m⁻¹

/** π e² ħ / (2 m_e c ε₀) in J m². */
export const SIGMA_PREFACTOR_SI = (Math.PI * E_CHARGE * E_CHARGE * HBAR) / (2 * M_E * C_LIGHT * EPS0);
/** The same in eV cm² (σ in cm² when g is per eV): ≈ 1.0976e-16. */
export const SIGMA_PREFACTOR_EV_CM2 = (SIGMA_PREFACTOR_SI / E_CHARGE) * 1e4;

export interface StateStick extends Stick {
  /** 0-based excited-state index within its geometry (for S1..SN curves). */
  state: number;
}

export interface Broadened {
  /** Energy grid, eV, ascending. */
  energy: number[];
  /** σ in cm² molecule⁻¹ (scale 'sigma') or (1/N) Σ f g in eV⁻¹ ('relative'). */
  total: number[];
  /** Per-state curves (same unit); total = Σ states. */
  states: number[][];
}

/**
 * Grid for broadening: from 5h below the lowest to 5h above the highest
 * stick (never below 0.05 eV), n points.
 */
export function energyGrid(sticks: Stick[], h: number, n = 2000): number[] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of sticks) {
    lo = Math.min(lo, s.energyEv);
    hi = Math.max(hi, s.energyEv);
  }
  if (!Number.isFinite(lo)) {
    return [];
  }
  lo = Math.max(0.05, lo - 5 * h);
  hi = hi + 5 * h;
  const step = (hi - lo) / (n - 1);
  return Array.from({ length: n }, (_, i) => lo + i * step);
}

/**
 * Gaussian broadening of sticks into σ(E) on a uniform `grid` (eV), averaged
 * over `nGeometries`. Exact sums for small inputs; for large ensembles the
 * sticks are first binned onto a fine grid (linear weight splitting keeps
 * Σf and the first moment) and convolved with the sampled kernel.
 */
export function broadenCrossSection(
  sticks: StateStick[],
  grid: number[],
  h: number,
  nGeometries: number,
  scale: 'sigma' | 'relative' = 'sigma',
  nStates = 0
): Broadened {
  if (!(h > 0)) {
    throw new Error('Gaussian width h must be > 0 eV.');
  }
  const n = grid.length;
  const ns = Math.max(nStates, ...sticks.map(s => s.state + 1), 0);
  const states = Array.from({ length: ns }, () => new Array<number>(n).fill(0));
  const pref = (scale === 'sigma' ? SIGMA_PREFACTOR_EV_CM2 : 1) / (Math.max(nGeometries, 1) * h * Math.sqrt(2 * Math.PI));
  const inv2h2 = 1 / (2 * h * h);
  if (n === 0) {
    return { energy: [], total: [], states };
  }
  const step = n > 1 ? (grid[n - 1] - grid[0]) / (n - 1) : 1;
  const cut = 6 * h;
  if (sticks.length * n <= 2e7 || step > h / 4) {
    for (const s of sticks) {
      if (!(s.weight > 0) || !Number.isFinite(s.energyEv)) continue;
      const row = states[s.state];
      const a = Math.max(0, Math.floor((s.energyEv - cut - grid[0]) / step));
      const b = Math.min(n - 1, Math.ceil((s.energyEv + cut - grid[0]) / step));
      const w = s.weight * pref;
      for (let i = a; i <= b; i++) {
        const d = grid[i] - s.energyEv;
        row[i] += w * Math.exp(-d * d * inv2h2);
      }
    }
  } else {
    // Bin onto the output grid (step <= h/4), then convolve with the kernel.
    const kHalf = Math.ceil(cut / step);
    const kernel = Array.from({ length: 2 * kHalf + 1 }, (_, k) => Math.exp(-(((k - kHalf) * step) ** 2) * inv2h2));
    for (let st = 0; st < ns; st++) {
      const bins = new Float64Array(n + 2 * kHalf);
      for (const s of sticks) {
        if (s.state !== st || !(s.weight > 0)) continue;
        const u = (s.energyEv - grid[0]) / step + kHalf;
        const j = Math.floor(u);
        const t = u - j;
        if (j >= 0 && j + 1 < bins.length) {
          bins[j] += s.weight * (1 - t);
          bins[j + 1] += s.weight * t;
        }
      }
      const row = states[st];
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let k = 0; k <= 2 * kHalf; k++) {
          // bins index of energy grid[i] - (k - kHalf)*step is i + 2kHalf - k
          acc += bins[i + 2 * kHalf - k] * kernel[k];
        }
        row[i] = acc * pref;
      }
    }
  }
  const total = new Array<number>(n).fill(0);
  for (const row of states) {
    for (let i = 0; i < n; i++) total[i] += row[i];
  }
  return { energy: grid.slice(), total, states };
}
