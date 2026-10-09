// Chemistry catalogs shared by the ORCA and PySCF generators: functionals
// (ORCA keyword <-> PySCF xc name), common solvents (ORCA CPCM name, SMD
// name, dielectric constant), and basis-set helpers. Pure data, no Node /
// DOM / vscode imports, so the webview may import it too.

import { AUX_BASIS_KEYWORDS, BASIS_KEYWORDS, isKnownSimpleKeyword } from '../keywords';

export type FunctionalKind = 'gga' | 'mgga' | 'hybrid' | 'rsh' | 'double-hybrid' | 'composite';

export interface FunctionalInfo {
  /** ORCA simple-input keyword (also the id used in InputSpec.method.functional). */
  orca: string;
  /** PySCF/libxc xc string; undefined = not available in the PySCF generator. */
  pyscf?: string;
  kind: FunctionalKind;
  /** Dispersion is part of the functional (wB97X-D3BJ, -V functionals, 3c methods). */
  builtInDispersion?: boolean;
  note?: string;
}

/**
 * Curated list (the UI's dropdown). Any other ORCA functional keyword is still
 * accepted by the ORCA generator (with a warning when keywords.ts does not
 * know it); the PySCF generator then passes the lower-cased name to libxc.
 */
export const FUNCTIONALS: FunctionalInfo[] = [
  { orca: 'BP86', pyscf: 'bp86', kind: 'gga' },
  { orca: 'PBE', pyscf: 'pbe', kind: 'gga' },
  { orca: 'BLYP', pyscf: 'blyp', kind: 'gga' },
  { orca: 'TPSS', pyscf: 'tpss', kind: 'mgga' },
  { orca: 'r2SCAN', pyscf: 'r2scan', kind: 'mgga' },
  // PySCF >= 2.3 maps "b3lyp" to the VWN-RPA variant (Gaussian's); ORCA's B3LYP uses VWN5 -> "b3lyp5".
  { orca: 'B3LYP', pyscf: 'b3lyp5', kind: 'hybrid', note: 'ORCA B3LYP = VWN5 variant (PySCF "b3lyp5").' },
  { orca: 'PBE0', pyscf: 'pbe0', kind: 'hybrid' },
  { orca: 'TPSSh', pyscf: 'tpssh', kind: 'hybrid' },
  { orca: 'M06-2X', pyscf: 'm062x', kind: 'hybrid' },
  { orca: 'BHANDHLYP', pyscf: 'bhandhlyp', kind: 'hybrid' },
  { orca: 'r2SCAN0', pyscf: 'r2scan0', kind: 'hybrid' },
  { orca: 'CAM-B3LYP', pyscf: 'camb3lyp', kind: 'rsh' },
  { orca: 'wB97X', pyscf: 'wb97x', kind: 'rsh' },
  { orca: 'wB97X-D3BJ', pyscf: 'wb97x-d3bj', kind: 'rsh', builtInDispersion: true, note: 'PySCF needs pyscf-dispersion for the D3BJ part.' },
  { orca: 'wB97X-D3', kind: 'rsh', builtInDispersion: true, note: 'Chai/Head-Gordon D3(0) variant; not in the PySCF generator (use wB97X-D3BJ).' },
  { orca: 'wB97X-D4', kind: 'rsh', builtInDispersion: true },
  { orca: 'wB97X-V', pyscf: 'wb97x_v', kind: 'rsh', builtInDispersion: true },
  { orca: 'wB97M-V', pyscf: 'wb97m_v', kind: 'rsh', builtInDispersion: true },
  { orca: 'B2PLYP', kind: 'double-hybrid', note: 'Double hybrid: ORCA only in this generator.' },
  { orca: 'revDSD-PBEP86-D4/2021', kind: 'double-hybrid', builtInDispersion: true },
  { orca: 'r2SCAN-3c', kind: 'composite', builtInDispersion: true, note: 'Composite: basis, D4 and gCP built in.' },
  { orca: 'B97-3c', kind: 'composite', builtInDispersion: true, note: 'Composite: basis, D3BJ and SRB built in.' },
  { orca: 'PBEh-3c', kind: 'composite', builtInDispersion: true, note: 'Composite: basis, D3BJ and gCP built in.' },
  { orca: 'wB97X-3c', kind: 'composite', builtInDispersion: true, note: 'Composite: vDZP basis and D4 built in.' }
];

export function functionalInfo(name: string): FunctionalInfo | undefined {
  const lower = name.trim().toLowerCase();
  return FUNCTIONALS.find(f => f.orca.toLowerCase() === lower);
}

export function isHybrid(name: string): boolean {
  const kind = functionalInfo(name)?.kind;
  if (kind) {
    return kind === 'hybrid' || kind === 'rsh' || kind === 'double-hybrid';
  }
  // Unknown functional: guess from the name (B3LYP-like, PBE0, w*, CAM-, LC-, *h).
  return /(^b3|^b1|0$|^w|^cam-|^lc-|h$|^m06(-2x)?$|^bhandh)/i.test(name.trim());
}

export interface SolventInfo {
  /** Id used in InputSpec.solvation.solvent; also the ORCA CPCM/SMD name. */
  id: string;
  label: string;
  /** Static dielectric constant (Minnesota solvent database values). */
  eps: number;
  /** Solvent name in the Minnesota SMD tables (PySCF SMD). */
  smd: string;
}

export const SOLVENTS: SolventInfo[] = [
  { id: 'water', label: 'Water', eps: 78.3553, smd: 'water' },
  { id: 'acetonitrile', label: 'Acetonitrile', eps: 35.688, smd: 'acetonitrile' },
  { id: 'methanol', label: 'Methanol', eps: 32.613, smd: 'methanol' },
  { id: 'ethanol', label: 'Ethanol', eps: 24.852, smd: 'ethanol' },
  { id: 'dmso', label: 'DMSO', eps: 46.826, smd: 'dimethylsulfoxide' },
  { id: 'dmf', label: 'DMF', eps: 37.219, smd: 'N,N-dimethylformamide' },
  { id: 'acetone', label: 'Acetone', eps: 20.493, smd: 'acetone' },
  { id: 'dichloromethane', label: 'Dichloromethane', eps: 8.93, smd: 'dichloromethane' },
  { id: 'chloroform', label: 'Chloroform', eps: 4.7113, smd: 'chloroform' },
  { id: 'thf', label: 'THF', eps: 7.4257, smd: 'tetrahydrofuran' },
  { id: 'diethylether', label: 'Diethyl ether', eps: 4.24, smd: 'diethylether' },
  { id: 'ethylacetate', label: 'Ethyl acetate', eps: 5.9867, smd: 'ethylethanoate' },
  { id: 'toluene', label: 'Toluene', eps: 2.3741, smd: 'toluene' },
  { id: 'benzene', label: 'Benzene', eps: 2.2706, smd: 'benzene' },
  { id: 'hexane', label: 'n-Hexane', eps: 1.8819, smd: 'n-hexane' },
  { id: 'cyclohexane', label: 'Cyclohexane', eps: 2.0165, smd: 'cyclohexane' },
  { id: 'pyridine', label: 'Pyridine', eps: 12.978, smd: 'pyridine' },
  { id: 'octanol', label: '1-Octanol', eps: 9.8629, smd: '1-octanol' }
];

export function solventInfo(id: string): SolventInfo | undefined {
  const lower = id.trim().toLowerCase();
  return SOLVENTS.find(s => s.id === lower);
}

/** Orbital basis sets offered in the UI (subset of keywords.ts BASIS_KEYWORDS). */
export const COMMON_BASIS_SETS = [
  'def2-SVP', 'def2-TZVP', 'def2-TZVPP', 'def2-QZVPP', 'def2-SVPD', 'def2-TZVPD',
  'ma-def2-SVP', 'ma-def2-TZVP',
  'cc-pVDZ', 'cc-pVTZ', 'cc-pVQZ', 'aug-cc-pVDZ', 'aug-cc-pVTZ', 'aug-cc-pVQZ',
  '6-31G*', '6-311G**', '6-31+G*'
].filter(b => BASIS_KEYWORDS.includes(b));

/** Correlation-fitting (/C) basis sets: one known to keywords.ts. */
export function knownAux(name: string): boolean {
  const lower = name.toLowerCase();
  return AUX_BASIS_KEYWORDS.some(a => a.toLowerCase() === lower) || isKnownSimpleKeyword(name);
}

/**
 * The matching /C basis for RI-MP2 / DLPNO, e.g. def2-TZVP -> def2-TZVP/C,
 * aug-cc-pVTZ -> aug-cc-pVTZ/C, or "AutoAux" when no matching set is known.
 */
export function correlationAuxFor(basis: string): string {
  let b = basis.trim();
  if (/^ma-def2-/i.test(b)) {
    b = b.slice(3); // minimally augmented def2: the def2 /C set is the usual choice
  }
  const candidate = `${b}/C`;
  const hit = AUX_BASIS_KEYWORDS.find(a => a.toLowerCase() === candidate.toLowerCase());
  if (hit) {
    return /^def2/i.test(hit) ? hit.replace(/^Def2/, 'def2') : hit;
  }
  if (/^(aug-)?cc-p(w?C)?V[DTQ5]Z$/i.test(b)) {
    return candidate;
  }
  return 'AutoAux';
}

/** The orbital basis an aux basis was made for ("def2-TZVP/C" -> "def2-TZVP"); undefined for universal sets. */
export function auxParent(aux: string): string | undefined {
  const m = /^(.+)\/(C|JK)$/i.exec(aux.trim());
  if (!m || /^def2$/i.test(m[1])) {
    return undefined;
  }
  return m[1];
}
