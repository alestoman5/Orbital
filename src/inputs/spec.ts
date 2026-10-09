// InputSpec: a serializable, program-independent description of one
// quantum-chemistry job, the single source the ORCA and PySCF generators
// (orca.ts, pyscf.ts) build from. Pure logic, no Node / DOM / vscode imports.
//
// Design: three orthogonal axes instead of one long "task" list.
//   job      what happens to the nuclei: sp | opt | freq | opt-freq | optts |
//            optts-freq | scan
//   method   the ground-state level of theory: hf | dft | mp2 | ccsd |
//            ccsd(t) | dlpno-ccsd(t) | casscf | nevpt2
//   excited  an optional excited-state layer on top of the reference:
//            none | tddft | adc2 | adc2x | adc3 | eom-ccsd
// "TD-DFT spectrum" is then { job: sp, method: dft, excited: tddft },
// "ADC(3)" is { job: sp, method: hf, excited: adc3 } (ADC and EOM are built on
// an HF reference), and a DFT opt+freq is { job: opt-freq, method: dft }.
// Every combination either has a generator path or is reported as an error
// by validateSpec (supportIssues) — the generators never guess.

import { GeometryAtom } from '../outparser/types';
import { atomicNumber } from '../chem/elements';
import { checkChargeMultiplicity, nuclearCharge } from '../chem/geometry';
import { isOrbitalBasis } from '../semantic';
import { isKnownSimpleKeyword } from '../keywords';
import { auxParent, functionalInfo, solventInfo } from './catalog';

export type Program = 'orca' | 'pyscf';
export const PROGRAMS: Program[] = ['orca', 'pyscf'];

export type JobType = 'sp' | 'opt' | 'freq' | 'opt-freq' | 'optts' | 'optts-freq' | 'scan';
export const JOB_TYPES: JobType[] = ['sp', 'opt', 'freq', 'opt-freq', 'optts', 'optts-freq', 'scan'];

export type MethodFamily = 'hf' | 'dft' | 'mp2' | 'ccsd' | 'ccsd(t)' | 'dlpno-ccsd(t)' | 'casscf' | 'nevpt2';
export const METHOD_FAMILIES: MethodFamily[] = ['hf', 'dft', 'mp2', 'ccsd', 'ccsd(t)', 'dlpno-ccsd(t)', 'casscf', 'nevpt2'];

export type ExcitedMethod = 'none' | 'tddft' | 'adc2' | 'adc2x' | 'adc3' | 'eom-ccsd';
export const EXCITED_METHODS: ExcitedMethod[] = ['none', 'tddft', 'adc2', 'adc2x', 'adc3', 'eom-ccsd'];

/** auto: restricted for singlets, unrestricted otherwise. */
export type Reference = 'auto' | 'restricted' | 'unrestricted' | 'restricted-open';

/**
 * auto: RIJCOSX + def2/J for hybrids/HF, RI-J for pure functionals, RI-MP2 /
 * DLPNO with the matching /C set, nothing for canonical CC / CASSCF / ADC / EOM.
 */
export type RiMode = 'auto' | 'none' | 'rij' | 'rijcosx' | 'rijk';

export interface InputSpec {
  /** Schema version of this object (for saved specs). */
  version: 1;
  title: string;
  /** Free text; written as comment lines / the script docstring. */
  comment: string;
  geometry: {
    atoms: GeometryAtom[];
    /** When set, the generated input reads this file instead of inlining atoms. */
    xyzFile?: string;
  };
  charge: number;
  multiplicity: number;
  job: JobType;
  method: {
    family: MethodFamily;
    /** ORCA functional keyword (see catalog.FUNCTIONALS); used when family = dft. */
    functional: string;
    reference: Reference;
    /** DLPNO PNO truncation preset (ORCA LoosePNO / NormalPNO / TightPNO). */
    pno: 'loose' | 'normal' | 'tight';
  };
  /** Orbital basis (ignored for composite methods such as r2SCAN-3c). */
  basis: string;
  ri: {
    mode: RiMode;
    /** Coulomb fitting basis: def2/J (universal) or AutoAux. */
    auxJ: string;
    /** Correlation fitting basis; '' = derived from the orbital basis (def2-TZVP/C, ...). */
    auxC: string;
  };
  dispersion: 'none' | 'd3bj' | 'd4';
  solvation: { model: 'none' | 'cpcm' | 'smd'; solvent: string };
  excited: {
    method: ExcitedMethod;
    nroots: number;
    /** Also compute triplets (closed-shell references only). */
    triplets: boolean;
    /** Tamm-Dancoff approximation for TD-DFT (ORCA's default is true). */
    tda: boolean;
    /** State followed in an excited-state optimization / whose properties are printed; 0 = none. */
    iroot: number;
  };
  /** Freeze core orbitals in correlated methods (ORCA's default, PySCF chemcore). */
  frozenCore: boolean;
  cas: { nel: number; norb: number; nroots: number };
  scan: {
    /** B = bond (Å), A = angle (°), D = dihedral (°). */
    coordinate: 'B' | 'A' | 'D';
    /** 0-based atom indices (ORCA convention): 2, 3 or 4 of them. */
    atoms: number[];
    start: number;
    end: number;
    /** Number of points including both ends. */
    points: number;
  };
  ts: { calcHess: boolean; recalcHess: number };
  freq: { temperature: number; pressureAtm: number };
  resources: { nprocs: number; maxcoreMB: number };
  convergence: { scf: 'normal' | 'tight' | 'verytight'; opt: 'normal' | 'tight' | 'verytight' };
  /** Free text appended verbatim: ORCA blocks before the coordinates, Python before result.json is written. */
  extras: { orca: string; pyscf: string };
}

/** Water at a PBE0/def2-SVP-like geometry: small, closed shell, valid everywhere. */
export const WATER: GeometryAtom[] = [
  { symbol: 'O', x: 0, y: 0, z: 0.1173 },
  { symbol: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { symbol: 'H', x: 0, y: -0.7572, z: -0.4692 }
];

export function defaultSpec(): InputSpec {
  return {
    version: 1,
    title: 'Untitled job',
    comment: '',
    geometry: { atoms: WATER.map(a => ({ ...a })) },
    charge: 0,
    multiplicity: 1,
    job: 'sp',
    method: { family: 'dft', functional: 'PBE0', reference: 'auto', pno: 'normal' },
    basis: 'def2-SVP',
    ri: { mode: 'auto', auxJ: 'def2/J', auxC: '' },
    dispersion: 'd3bj',
    solvation: { model: 'none', solvent: 'water' },
    excited: { method: 'none', nroots: 10, triplets: false, tda: false, iroot: 0 },
    frozenCore: true,
    cas: { nel: 2, norb: 2, nroots: 1 },
    scan: { coordinate: 'B', atoms: [0, 1], start: 0.9, end: 1.3, points: 9 },
    ts: { calcHess: true, recalcHess: 0 },
    freq: { temperature: 298.15, pressureAtm: 1 },
    resources: { nprocs: 4, maxcoreMB: 2000 },
    convergence: { scf: 'normal', opt: 'normal' },
    extras: { orca: '', pyscf: '' }
  };
}

/** Deep copy (specs are plain JSON). */
export function cloneSpec(spec: InputSpec): InputSpec {
  return JSON.parse(JSON.stringify(spec));
}

/**
 * Fills fields missing from a partially saved / user-supplied spec with
 * defaults (one level deep for the nested groups). Unknown keys are dropped.
 */
export function normalizeSpec(partial: Partial<InputSpec> | Record<string, unknown>): InputSpec {
  const d = defaultSpec();
  const p = partial as Record<string, unknown>;
  const out = d as unknown as Record<string, unknown>;
  for (const key of Object.keys(d)) {
    const v = p[key];
    if (v === undefined || v === null) {
      continue;
    }
    const dv = out[key];
    if (dv && typeof dv === 'object' && !Array.isArray(dv) && typeof v === 'object' && !Array.isArray(v)) {
      out[key] = { ...(dv as object), ...(v as object) };
    } else {
      out[key] = v;
    }
  }
  d.version = 1;
  return d;
}

// ---------------------------------------------------------------------------
// Derived properties
// ---------------------------------------------------------------------------

export const isCorrelated = (f: MethodFamily) => f !== 'hf' && f !== 'dft';
export const isMultireference = (f: MethodFamily) => f === 'casscf' || f === 'nevpt2';
export const isOptimization = (j: JobType) => j === 'opt' || j === 'opt-freq' || j === 'optts' || j === 'optts-freq' || j === 'scan';
export const hasFrequencies = (j: JobType) => j === 'freq' || j === 'opt-freq' || j === 'optts-freq';
export const isTsSearch = (j: JobType) => j === 'optts' || j === 'optts-freq';
export const EXCITED_LABELS: Record<ExcitedMethod, string> = {
  none: 'none', tddft: 'TD-DFT', adc2: 'ADC(2)', adc2x: 'ADC(2)-x', adc3: 'ADC(3)', 'eom-ccsd': 'EOM-CCSD'
};
export const METHOD_LABELS: Record<MethodFamily, string> = {
  hf: 'HF', dft: 'DFT', mp2: 'MP2', ccsd: 'CCSD', 'ccsd(t)': 'CCSD(T)', 'dlpno-ccsd(t)': 'DLPNO-CCSD(T)',
  casscf: 'CASSCF', nevpt2: 'NEVPT2'
};

export const isAdc = (e: ExcitedMethod) => e === 'adc2' || e === 'adc2x' || e === 'adc3';

/** The reference actually used: 'restricted' | 'unrestricted' | 'restricted-open'. */
export function effectiveReference(spec: InputSpec): Exclude<Reference, 'auto'> {
  if (spec.method.reference !== 'auto') {
    return spec.method.reference;
  }
  if (isMultireference(spec.method.family)) {
    return spec.multiplicity > 1 ? 'restricted-open' : 'restricted';
  }
  return spec.multiplicity > 1 ? 'unrestricted' : 'restricted';
}

export function isComposite(spec: InputSpec): boolean {
  return spec.method.family === 'dft' && functionalInfo(spec.method.functional)?.kind === 'composite';
}

/** Dispersion actually added on top of the functional ('none' when built in or not applicable). */
export function effectiveDispersion(spec: InputSpec): 'none' | 'd3bj' | 'd4' {
  if (spec.dispersion === 'none') {
    return 'none';
  }
  if (spec.method.family !== 'dft' && spec.method.family !== 'hf') {
    return 'none';
  }
  if (spec.method.family === 'dft' && functionalInfo(spec.method.functional)?.builtInDispersion) {
    return 'none';
  }
  return spec.dispersion;
}

/** Number of electrons, or undefined when the geometry is not inline / has unknown symbols. */
export function electronCount(spec: InputSpec): number | undefined {
  if (spec.geometry.atoms.length === 0) {
    return undefined;
  }
  const z = nuclearCharge(spec.geometry.atoms.map(a => a.symbol));
  return z === undefined ? undefined : z - spec.charge;
}

/** Short human-readable label, e.g. "TD-DFT (10 roots) CAM-B3LYP/def2-TZVP, CPCM(water)". */
export function describeSpec(spec: InputSpec): string {
  const m = spec.method;
  const level = m.family === 'dft' ? m.functional : METHOD_LABELS[m.family];
  const disp = effectiveDispersion(spec);
  const levelD = disp === 'none' ? level : `${level}-${disp.toUpperCase()}`;
  const lot = isComposite(spec) ? levelD : `${levelD}/${spec.basis}`;
  const exc: Record<ExcitedMethod, string> = {
    none: '', tddft: m.family === 'hf' ? (spec.excited.tda ? 'CIS' : 'TDHF') : (spec.excited.tda ? 'TDA' : 'TD-DFT'),
    adc2: 'ADC(2)', adc2x: 'ADC(2)-x', adc3: 'ADC(3)', 'eom-ccsd': 'EOM-CCSD'
  };
  const job: Record<JobType, string> = {
    sp: 'single point', opt: 'optimization', freq: 'frequencies', 'opt-freq': 'opt + freq',
    optts: 'TS optimization', 'optts-freq': 'TS optimization + freq', scan: 'relaxed scan'
  };
  const parts: string[] = [];
  if (spec.excited.method !== 'none') {
    parts.push(`${exc[spec.excited.method]} (${spec.excited.nroots} roots)`);
    parts.push(spec.excited.method === 'tddft' ? lot : `on HF/${spec.basis}`);
  } else {
    parts.push(lot);
  }
  if (isMultireference(m.family)) {
    parts.push(`CAS(${spec.cas.nel},${spec.cas.norb})`);
  }
  let s = `${job[spec.job]}: ${parts.join(' ')}`;
  if (spec.solvation.model !== 'none') {
    s += `, ${spec.solvation.model.toUpperCase()}(${spec.solvation.solvent})`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface SpecIssue {
  severity: IssueSeverity;
  /** Dotted field path, e.g. "excited.nroots", "geometry.atoms[2].symbol". */
  path: string;
  message: string;
  /** Set when the issue only concerns one program. */
  program?: Program;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Program-independent checks plus the support matrix of `program` (or of both
 * programs, each issue tagged, when omitted).
 */
export function validateSpec(spec: InputSpec, program?: Program): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const add = (severity: IssueSeverity, path: string, message: string, prog?: Program) =>
    issues.push({ severity, path, message, ...(prog ? { program: prog } : {}) });

  // --- geometry, charge, multiplicity -------------------------------------
  const atoms = spec.geometry?.atoms ?? [];
  const xyzFile = spec.geometry?.xyzFile?.trim();
  if (atoms.length === 0 && !xyzFile) {
    add('error', 'geometry.atoms', 'No geometry: add atoms or reference an .xyz file.');
  }
  if (xyzFile && /\s/.test(xyzFile)) {
    add('error', 'geometry.xyzFile', `"${xyzFile}" contains whitespace; ORCA cannot read such file names in "* xyzfile".`);
  }
  atoms.forEach((a, i) => {
    const z = atomicNumber(a.symbol);
    if (z === undefined || z === 0) {
      add('error', `geometry.atoms[${i}].symbol`, `Unknown element "${a.symbol}" (atom ${i + 1}).`);
    }
    if (![a.x, a.y, a.z].every(isNum)) {
      add('error', `geometry.atoms[${i}]`, `Atom ${i + 1} has non-numeric coordinates.`);
    }
  });
  if (!isInt(spec.charge)) {
    add('error', 'charge', 'Charge must be an integer.');
  }
  if (!isInt(spec.multiplicity) || spec.multiplicity < 1) {
    add('error', 'multiplicity', 'Multiplicity (2S+1) must be an integer ≥ 1.');
  } else if (atoms.length > 0 && isInt(spec.charge)) {
    const problem = checkChargeMultiplicity(atoms.map(a => a.symbol), spec.charge, spec.multiplicity);
    if (problem) {
      add('error', 'multiplicity', problem);
    }
  }

  // --- method -------------------------------------------------------------
  const fam = spec.method.family;
  const ref = effectiveReference(spec);
  if (!METHOD_FAMILIES.includes(fam)) {
    add('error', 'method.family', `Unknown method "${fam}".`);
  }
  if (spec.multiplicity > 1 && ref === 'restricted') {
    const fix = fam === 'dft' ? 'UKS (or ROKS)' : 'UHF (or ROHF)';
    add('error', 'method.reference', `Multiplicity ${spec.multiplicity} needs an open-shell reference: use ${fix}, or reference "auto".`);
  }
  if (spec.multiplicity === 1 && ref !== 'restricted' && !isMultireference(fam)) {
    add('info', 'method.reference', 'Unrestricted reference for a singlet: only useful for broken-symmetry solutions (add a guess in extras).');
  }
  if (fam === 'dft') {
    const f = spec.method.functional?.trim();
    if (!f) {
      add('error', 'method.functional', 'DFT needs a functional.');
    } else if (!functionalInfo(f) && !isKnownSimpleKeyword(f)) {
      add('warning', 'method.functional', `"${f}" is not a known ORCA functional keyword; check the spelling.`);
    }
  }
  const composite = isComposite(spec);
  if (!composite) {
    if (!spec.basis?.trim()) {
      add('error', 'basis', 'No basis set.');
    } else if (!isOrbitalBasis(spec.basis.trim())) {
      add('warning', 'basis', `"${spec.basis}" is not a basis set known to the ORCA keyword list; check the spelling.`);
    }
  } else if (spec.basis?.trim()) {
    add('info', 'basis', `${spec.method.functional} is a composite method with its own basis; "${spec.basis}" is ignored.`);
  }
  if (spec.dispersion !== 'none') {
    if (fam === 'dft' && functionalInfo(spec.method.functional)?.builtInDispersion) {
      add('info', 'dispersion', `${spec.method.functional} already includes dispersion; ${spec.dispersion.toUpperCase()} is not added.`);
    } else if (fam !== 'dft' && fam !== 'hf') {
      add('info', 'dispersion', `Dispersion corrections apply to DFT/HF only; ignored for ${METHOD_LABELS[fam]}.`);
    }
  } else if (fam === 'dft' && !functionalInfo(spec.method.functional)?.builtInDispersion && spec.excited.method === 'none') {
    add('info', 'dispersion', 'No dispersion correction: D4 or D3BJ is recommended for nearly all DFT geometries and energies.');
  }

  // --- RI / auxiliary basis pairing ---------------------------------------
  if (spec.ri.auxC?.trim()) {
    const parent = auxParent(spec.ri.auxC);
    if (parent && spec.basis && parent.toLowerCase() !== spec.basis.trim().toLowerCase()
      && parent.toLowerCase() !== spec.basis.trim().toLowerCase().replace(/^ma-/, '')) {
      add('warning', 'ri.auxC', `${spec.ri.auxC} was fitted for ${parent}, not for ${spec.basis}; use the matching /C set or AutoAux.`);
    }
  }
  if (spec.ri.auxJ?.trim() && /\/C$/i.test(spec.ri.auxJ)) {
    add('error', 'ri.auxJ', `${spec.ri.auxJ} is a correlation (/C) basis; the Coulomb fitting basis is def2/J (or AutoAux).`);
  }
  if (spec.ri.mode === 'rijcosx' && fam === 'dft' && !composite) {
    const kind = functionalInfo(spec.method.functional)?.kind;
    if (kind === 'gga' || kind === 'mgga') {
      add('info', 'ri.mode', 'COSX only speeds up exact exchange; a pure functional needs only RI-J.');
    }
  }

  // --- solvation -------------------------------------------------------------
  if (spec.solvation.model !== 'none' && !solventInfo(spec.solvation.solvent)) {
    add('error', 'solvation.solvent', `Unknown solvent "${spec.solvation.solvent}".`);
  }

  // --- excited states ---------------------------------------------------------
  const exc = spec.excited.method;
  if (exc !== 'none') {
    if (!isInt(spec.excited.nroots) || spec.excited.nroots < 1) {
      add('error', 'excited.nroots', 'Excited-state calculations need nroots ≥ 1.');
    } else if (spec.excited.nroots > 100) {
      add('warning', 'excited.nroots', `${spec.excited.nroots} roots is a lot; the Davidson solver gets slow and memory hungry.`);
    }
    if (exc === 'tddft' && fam !== 'dft' && fam !== 'hf') {
      add('error', 'excited.method', 'TD-DFT/CIS needs an HF or DFT reference (method family hf or dft).');
    }
    if ((isAdc(exc) || exc === 'eom-ccsd') && fam !== 'hf') {
      add('error', 'method.family', `${EXCITED_LABELS[exc]} is built on an HF reference: set the method family to hf.`);
    }
    if (spec.excited.triplets && spec.multiplicity !== 1) {
      add('error', 'excited.triplets', 'Singlet/triplet separation needs a closed-shell (singlet) reference.');
    }
    if (spec.excited.iroot < 0 || !isInt(spec.excited.iroot) || spec.excited.iroot > spec.excited.nroots) {
      add('error', 'excited.iroot', `IRoot must be between 0 and NRoots (${spec.excited.nroots}).`);
    }
    if (isOptimization(spec.job)) {
      if (exc !== 'tddft') {
        add('error', 'job', `${EXCITED_LABELS[exc]} has no analytic gradients here; only TD-DFT excited-state optimizations are generated.`);
      } else if (spec.job !== 'opt') {
        add('error', 'job', 'Excited-state jobs support single points and plain optimizations (Opt) only.');
      } else if (spec.excited.iroot < 1) {
        add('error', 'excited.iroot', 'An excited-state optimization needs IRoot ≥ 1 (the state to follow).');
      }
    }
    if (hasFrequencies(spec.job)) {
      add('error', 'job', 'Frequencies of excited states are not generated (no analytic excited-state Hessian).');
    }
    if (isMultireference(fam)) {
      add('error', 'excited.method', 'For CASSCF/NEVPT2 excited states use cas.nroots (state averaging), not an excited-state method.');
    }
  } else if (spec.excited.iroot > 0) {
    add('info', 'excited.iroot', 'IRoot is ignored without an excited-state method.');
  }

  // --- CAS ------------------------------------------------------------------
  if (isMultireference(fam)) {
    const { nel, norb, nroots } = spec.cas;
    if (!isInt(nel) || nel < 1) {
      add('error', 'cas.nel', 'CAS needs ≥ 1 active electron.');
    }
    if (!isInt(norb) || norb < 1) {
      add('error', 'cas.norb', 'CAS needs ≥ 1 active orbital.');
    }
    if (isInt(nel) && isInt(norb)) {
      if (nel > 2 * norb) {
        add('error', 'cas.nel', `${nel} electrons do not fit into ${norb} orbitals (max ${2 * norb}).`);
      }
      const unpaired = spec.multiplicity - 1;
      if ((nel - unpaired) % 2 !== 0 || nel < unpaired) {
        add('error', 'cas.nel', `CAS(${nel},${norb}) cannot have multiplicity ${spec.multiplicity}: active electrons minus unpaired electrons must be even and ≥ 0.`);
      }
      if (unpaired > norb) {
        add('error', 'cas.norb', `Multiplicity ${spec.multiplicity} needs at least ${unpaired} active orbitals.`);
      }
      const ne = electronCount(spec);
      if (ne !== undefined && nel > ne) {
        add('error', 'cas.nel', `${nel} active electrons, but the molecule has only ${ne}.`);
      } else if (ne !== undefined && (ne - nel) % 2 !== 0) {
        add('error', 'cas.nel', `${ne} electrons in total and ${nel} active leaves an odd number of inactive electrons.`);
      }
      if (norb > 16) {
        add('warning', 'cas.norb', `CAS with ${norb} orbitals is beyond what full-CI CASSCF handles comfortably (≈ 16); consider DMRG.`);
      }
    }
    if (!isInt(nroots) || nroots < 1) {
      add('error', 'cas.nroots', 'cas.nroots must be ≥ 1.');
    }
  }

  // --- scan -------------------------------------------------------------------
  if (spec.job === 'scan') {
    const s = spec.scan;
    const need = { B: 2, A: 3, D: 4 }[s.coordinate];
    if (!need) {
      add('error', 'scan.coordinate', 'Scan coordinate must be B (bond), A (angle) or D (dihedral).');
    } else if (s.atoms.length !== need) {
      add('error', 'scan.atoms', `A ${s.coordinate} scan needs ${need} atom indices, got ${s.atoms.length}.`);
    }
    const nat = atoms.length;
    s.atoms.forEach((i, k) => {
      if (!isInt(i) || i < 0 || (nat > 0 && i >= nat)) {
        add('error', `scan.atoms[${k}]`, `Atom index ${i} is out of range (0-based, ${nat} atoms).`);
      }
    });
    if (new Set(s.atoms).size !== s.atoms.length) {
      add('error', 'scan.atoms', 'Scan atom indices must be distinct.');
    }
    if (!isInt(s.points) || s.points < 2) {
      add('error', 'scan.points', 'A scan needs at least 2 points.');
    } else if (s.points > 60) {
      add('warning', 'scan.points', `${s.points} constrained optimizations will take a while.`);
    }
    if (!isNum(s.start) || !isNum(s.end) || s.start === s.end) {
      add('error', 'scan.end', 'Scan start and end must be different numbers.');
    }
    if (s.coordinate === 'B' && (s.start <= 0 || s.end <= 0)) {
      add('error', 'scan.start', 'Bond lengths must be positive (Å).');
    }
    if (s.coordinate === 'B' && Math.max(s.start, s.end) > 6) {
      add('warning', 'scan.end', 'Bond scan beyond 6 Å: dissociation curves usually need a multireference or broken-symmetry treatment.');
    }
    if (s.coordinate === 'A' && (Math.min(s.start, s.end) < 0 || Math.max(s.start, s.end) > 180)) {
      add('error', 'scan.end', 'Angles must lie between 0 and 180°.');
    }
    if (s.coordinate === 'D' && (Math.min(s.start, s.end) < -360 || Math.max(s.start, s.end) > 360)) {
      add('error', 'scan.end', 'Dihedrals must lie between −360 and 360°.');
    }
  }

  // --- TS / freq --------------------------------------------------------------
  if (isTsSearch(spec.job)) {
    if (!spec.ts.calcHess && !(spec.ts.recalcHess > 0)) {
      add('warning', 'ts.calcHess', 'TS search without an exact starting Hessian: the model Hessian often misses the TS mode (set Calc_Hess).');
    }
  }
  if (!isInt(spec.ts.recalcHess) || spec.ts.recalcHess < 0) {
    add('error', 'ts.recalcHess', 'Recalc_Hess must be an integer ≥ 0 (0 = never).');
  }
  if (hasFrequencies(spec.job)) {
    if (!isNum(spec.freq.temperature) || spec.freq.temperature <= 0) {
      add('error', 'freq.temperature', 'Temperature must be > 0 K.');
    }
    if (!isNum(spec.freq.pressureAtm) || spec.freq.pressureAtm <= 0) {
      add('error', 'freq.pressureAtm', 'Pressure must be > 0 atm.');
    }
    if (spec.job === 'freq' && spec.geometry.atoms.length > 0) {
      add('info', 'job', 'Frequencies without optimization: only meaningful on a geometry optimized at the same level.');
    }
  }

  // --- resources --------------------------------------------------------------
  const { nprocs, maxcoreMB } = spec.resources;
  if (!isInt(nprocs) || nprocs < 1) {
    add('error', 'resources.nprocs', 'nprocs must be an integer ≥ 1.');
  } else if (nprocs > 256) {
    add('warning', 'resources.nprocs', `${nprocs} processes is unusually many for one job.`);
  }
  if (!isInt(maxcoreMB) || maxcoreMB < 100) {
    add('error', 'resources.maxcoreMB', 'Memory per core must be an integer ≥ 100 MB.');
  } else {
    if (maxcoreMB < 1000 && (isCorrelated(fam) || isAdc(exc) || exc === 'eom-ccsd')) {
      add('warning', 'resources.maxcoreMB', `${maxcoreMB} MB per core is tight for correlated methods; 2000-4000 MB is typical.`);
    }
    if (isInt(nprocs) && nprocs * maxcoreMB > 512000) {
      add('warning', 'resources.maxcoreMB', `${nprocs} × ${maxcoreMB} MB = ${Math.round(nprocs * maxcoreMB / 1024)} GB in total; keep it below ~75 % of the node's RAM.`);
    }
  }

  for (const prog of program ? [program] : PROGRAMS) {
    issues.push(...supportIssues(spec, prog).map(i => ({ ...i, program: prog })));
  }
  return issues;
}

/** Issues that only concern one program: what this generator can or cannot write for it. */
export function supportIssues(spec: InputSpec, program: Program): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const err = (path: string, message: string) => issues.push({ severity: 'error', path, message, program });
  const warn = (path: string, message: string) => issues.push({ severity: 'warning', path, message, program });
  const info = (path: string, message: string) => issues.push({ severity: 'info', path, message, program });
  const fam = spec.method.family;
  const exc = spec.excited.method;
  const job = spec.job;
  const opt = isOptimization(job);
  const freq = hasFrequencies(job);

  if (program === 'orca') {
    if (isAdc(exc)) {
      err('excited.method', `${EXCITED_LABELS[exc]} inputs are generated for PySCF only in this tool; for ORCA use TD-DFT or EOM-CCSD.`);
    }
    if (exc === 'eom-ccsd' && spec.excited.triplets) {
      err('excited.triplets', 'Triplet EOM-CCSD roots are not generated for ORCA; compute singlets, or use PySCF.');
    }
    if (exc === 'eom-ccsd' && spec.multiplicity !== 1) {
      err('multiplicity', 'EOM-CCSD is generated for closed-shell references only.');
    }
    if ((opt || freq) && (fam === 'ccsd' || fam === 'ccsd(t)' || fam === 'dlpno-ccsd(t)' || fam === 'nevpt2')) {
      err('job', `${METHOD_LABELS[fam]} has no analytic gradients in ORCA; run a single point on a DFT geometry (or add NumGrad by hand).`);
    }
    if (freq && (fam === 'mp2' || fam === 'casscf')) {
      info('job', `Frequencies for ${METHOD_LABELS[fam]} are computed numerically (NumFreq): 6N gradient calculations.`);
    }
    if (fam === 'dft') {
      const fi = functionalInfo(spec.method.functional);
      if (fi?.kind === 'double-hybrid' && (opt || freq)) {
        info('job', 'Double-hybrid gradients are available in ORCA but expensive; a hybrid geometry is the usual choice.');
      }
    }
    if (spec.solvation.model !== 'none' && (isCorrelated(fam) || exc === 'eom-ccsd')) {
      info('solvation.model', 'With correlated methods the solvent acts only through the polarized SCF reference.');
    }
    if (spec.extras.orca && /^\s*\*/m.test(spec.extras.orca)) {
      err('extras.orca', 'ORCA extras must not contain a coordinate block ("* ..."); the generator writes it.');
    }
  } else {
    if (fam === 'dlpno-ccsd(t)') {
      err('method.family', 'DLPNO-CCSD(T) is an ORCA method; PySCF has canonical CCSD(T) only.');
    }
    if (fam === 'dft') {
      const fi = functionalInfo(spec.method.functional);
      if (fi && !fi.pyscf) {
        err('method.functional', `${fi.orca} is not available in the PySCF generator${fi.note ? ` (${fi.note})` : ''}.`);
      } else if (!fi) {
        warn('method.functional', `"${spec.method.functional}" is passed to PySCF/libxc as "${spec.method.functional.toLowerCase()}"; check that libxc knows it.`);
      }
    }
    if (spec.method.reference === 'restricted-open' && !isMultireference(fam) && fam !== 'hf' && fam !== 'dft') {
      err('method.reference', 'ROHF-based correlated methods are not generated for PySCF; use UHF.');
    }
    if (opt && fam !== 'hf' && fam !== 'dft') {
      err('job', `Geometry optimizations are generated for HF/DFT only in PySCF (${METHOD_LABELS[fam]} gradients are not wired up here).`);
    }
    if (opt && exc !== 'none') {
      err('job', 'Excited-state optimizations are generated for ORCA only.');
    }
    if (freq && fam !== 'hf' && fam !== 'dft') {
      err('job', `Analytic Hessians exist for HF/DFT only in PySCF; ${METHOD_LABELS[fam]} frequencies are not generated.`);
    }
    if (freq && spec.method.family === 'dft') {
      const kind = functionalInfo(spec.method.functional)?.kind;
      if (kind === 'mgga' || /scan|m06|tpss/i.test(spec.method.functional)) {
        warn('job', 'PySCF analytic Hessians for meta-GGAs are recent/limited; check your PySCF version.');
      }
      if (/_v$/.test(functionalInfo(spec.method.functional)?.pyscf ?? '')) {
        err('job', 'PySCF has no analytic Hessian for VV10 (-V) functionals.');
      }
    }
    if (opt || freq) {
      info('job', opt ? 'Optimization uses geomeTRIC (pip install geometric).' : 'Frequencies use the analytic PySCF Hessian.');
    }
    if (isTsSearch(job)) {
      info('ts.calcHess', 'PySCF TS search: geomeTRIC with transition=True; its starting Hessian is computed by finite differences (hessian="first").');
    }
    if (spec.solvation.model !== 'none') {
      if (isCorrelated(fam) || isAdc(exc) || exc === 'eom-ccsd') {
        err('solvation.model', 'Implicit solvation is generated for HF/DFT (and TD-DFT) only in PySCF.');
      }
      if (exc === 'tddft') {
        warn('solvation.model', 'TD-DFT with PCM needs a recent PySCF (linear-response PCM); check your version.');
      }
      if (spec.solvation.model === 'smd') {
        warn('solvation.model', 'SMD in PySCF (pyscf.solvent.smd) is recent (≥ 2.5); C-PCM is the safer choice.');
      }
      if (freq) {
        warn('solvation.model', 'PySCF Hessians with PCM need a recent PySCF; check your version.');
      }
    }
    if (effectiveDispersion(spec) !== 'none' || /d3bj/.test(functionalInfo(spec.method.functional)?.pyscf ?? '')) {
      info('dispersion', 'Dispersion in PySCF needs the pyscf-dispersion package (pip install pyscf-dispersion).');
      if (freq) {
        warn('dispersion', 'Check that your pyscf-dispersion version provides Hessian contributions.');
      }
    }
    if (exc === 'eom-ccsd') {
      if (spec.multiplicity !== 1) {
        err('multiplicity', 'EOM-EE-CCSD is generated for closed-shell references only in PySCF.');
      }
      warn('excited.method', 'PySCF EOM-EE-CCSD gives excitation energies but no oscillator strengths; result.json lists energies only.');
    }
    if (exc === 'tddft' && spec.excited.triplets && effectiveReference(spec) !== 'restricted') {
      err('excited.triplets', 'Triplets need a restricted closed-shell reference.');
    }
    if (exc === 'tddft' && spec.excited.iroot > 0) {
      info('excited.iroot', 'IRoot has no effect in the PySCF single-point script.');
    }
    if (spec.ri.mode === 'rijcosx') {
      info('ri.mode', 'PySCF has no COSX; density fitting (DF-JK) is used instead.');
    }
    if (/^ma-/i.test(spec.basis)) {
      err('basis', 'Minimally augmented (ma-) def2 sets are not in PySCF\'s basis library; use def2-SVPD / def2-TZVPD or aug-cc-pVXZ.');
    }
    if (isComposite(spec)) {
      err('method.functional', 'Composite 3c methods are ORCA-only in this generator.');
    }
  }
  return issues;
}

/** Programs for which the spec generates without errors. */
export function supportedPrograms(spec: InputSpec): Program[] {
  const generic = validateSpec(spec, 'orca').filter(i => i.severity === 'error' && !i.program).length > 0;
  if (generic) {
    return [];
  }
  return PROGRAMS.filter(p => !supportIssues(spec, p).some(i => i.severity === 'error'));
}

/** Errors that block generation for `program`. */
export function blockingErrors(spec: InputSpec, program: Program): SpecIssue[] {
  return validateSpec(spec, program).filter(i => i.severity === 'error');
}
