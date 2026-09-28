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

/** THERMOCHEMISTRY AT ... block summary, all values in Hartree. */
export interface ThermoData {
  /** "Total Enthalpy". */
  enthalpy?: number;
  /** "Total entropy correction" (i.e. -T*S). */
  entropy?: number;
  /** "Final Gibbs free energy". */
  gibbs?: number;
  temperatureK?: number;
}

/** One row of an ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS table. */
export interface Excitation {
  /** 1-based index of the final state, in the order ORCA printed them. */
  state: number;
  /** Final-state label as printed by ORCA 6 (e.g. "1-1A"); undefined for ORCA 5 tables. */
  label?: string;
  energyEv: number;
  energyCm1: number;
  wavelengthNm: number;
  fosc: number;
  /** |mu|^2 in au^2. */
  d2: number;
  /** Transition dipole components in au. */
  dx: number;
  dy: number;
  dz: number;
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
  /** Last CARTESIAN COORDINATES (A.U.) block: bohr coordinates plus atomic masses. */
  finalGeometryBohr?: { symbol: string; mass: number; xBohr: number; yBohr: number; zBohr: number }[];
  /** Vibrational frequencies in cm^-1 (one per Cartesian dof, 3N); negative = imaginary. */
  frequenciesCm1?: number[];
  /** NORMAL MODES from the .out; modes[k] is a 3N-long vector (see src/chem/hess.ts). */
  normalModes?: number[][];
  /** IR SPECTRUM eps column (L/(mol*cm)) per mode index; 0 for modes without a row. */
  irEpsilon?: number[];
  thermo?: ThermoData;
  /** Last ABSORPTION SPECTRUM (electric dipole) table in this job. */
  excitations?: Excitation[];
  /** Coupled-cluster single-reference diagnostics, if printed. */
  t1Diagnostic?: number;
  d1Diagnostic?: number;
  /** Last SCF outcome seen: true = "SCF CONVERGED", false = "SCF NOT CONVERGED". */
  scfConverged?: boolean;
  /** true = "THE OPTIMIZATION HAS CONVERGED", false = optimizer gave up, undefined = no optimization. */
  optConverged?: boolean;
  warnings: string[];
}

/** Full result of parsing one .out file. */
export interface ParsedOrcaOutput {
  status: OrcaStatus;
  jobs: JobSegment[];
  totalRunTimeSeconds?: number;
  /** The input deck as echoed by ORCA ("|  1> ! PBE ..."), without the "|  N> " prefix. */
  inputEcho: string[];
}
