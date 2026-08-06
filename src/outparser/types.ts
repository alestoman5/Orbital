// Data shapes produced by the .out parser (src/outparser/parse.ts,
// src/outparser/sections.ts). Pure data — no `vscode` import here so this
// module (and everything that only depends on it) stays testable without an
// extension host.

/** Coarse-grained state of an ORCA run as inferred from its .out file. */
export type OrcaStatus = 'running' | 'normal-termination' | 'error' | 'unknown';

/** One row of the SCF iteration log (best-effort — see sections.ts). */
export interface ScfCycle {
  cycle: number;
  energy: number;
  deltaE: number;
}

/** A single value/tolerance/converged? triple from a "Geometry convergence" table row. */
export interface OptCycleMetric {
  value: number;
  tolerance: number;
  converged: boolean;
}

/** One geometry-optimization cycle's convergence snapshot (best-effort — see sections.ts). */
export interface OptCycle {
  cycle: number;
  energyChange?: OptCycleMetric;
  rmsGradient?: OptCycleMetric;
  maxGradient?: OptCycleMetric;
  rmsStep?: OptCycleMetric;
  maxStep?: OptCycleMetric;
  /** True only when every metric above was found and reported YES. */
  allConverged: boolean;
}

/** One atom from a CARTESIAN COORDINATES (ANGSTROEM) block. */
export interface GeometryAtom {
  symbol: string;
  x: number;
  y: number;
  z: number;
}

/** THERMOCHEMISTRY AT ... block summary, all values in Hartree (Phase 2). */
export interface ThermoData {
  enthalpy: number;
  entropy: number;
  gibbs: number;
}

/**
 * One ORCA "job" within a .out file. Most .out files contain exactly one;
 * multi-step inputs (e.g. using `$new_job`) produce several in file order.
 */
export interface JobSegment {
  finalEnergyHartree?: number;
  scfCycles: ScfCycle[];
  optCycles: OptCycle[];
  finalGeometry?: GeometryAtom[];
  /** Vibrational frequencies in cm^-1; negative = imaginary (Phase 2). */
  frequenciesCm1?: number[];
  thermo?: ThermoData;
  warnings: string[];
}

/** Full result of parsing one .out file. */
export interface ParsedOrcaOutput {
  status: OrcaStatus;
  jobs: JobSegment[];
  totalRunTimeSeconds?: number;
}
