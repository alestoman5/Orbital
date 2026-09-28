// Periodic-table data needed by the chemistry helpers (electron counting for
// charge/multiplicity parity checks, masses for .hess/Molden output). Pure
// data, no `vscode` import.

const SYMBOLS = [
  'H', 'He',
  'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
  'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar',
  'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn',
  'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr',
  'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd',
  'In', 'Sn', 'Sb', 'Te', 'I', 'Xe',
  'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy',
  'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt',
  'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn'
];

const Z_BY_SYMBOL: Record<string, number> = {};
SYMBOLS.forEach((s, i) => {
  Z_BY_SYMBOL[s.toLowerCase()] = i + 1;
});

/** 1 bohr in Ångström (CODATA 2018). */
export const BOHR_TO_ANGSTROM = 0.529177210903;
/** 1 hartree in eV (CODATA 2018). */
export const HARTREE_TO_EV = 27.211386245988;
export const HARTREE_TO_KCALMOL = 627.509474;
export const HARTREE_TO_KJMOL = 2625.49964;
export const EV_TO_CM1 = 8065.543937;
/** E[eV] = EV_NM / λ[nm]. */
export const EV_NM = 1239.84198;
/** Boltzmann constant in hartree/K. */
export const KB_HARTREE = 3.166811563e-6;
/** Boltzmann constant in cm^-1/K. */
export const KB_CM1 = 0.695034800;

/**
 * Atomic number for an element symbol as written in ORCA coordinate blocks.
 * Tolerates ORCA's label conventions: case-insensitive, trailing digits or
 * fragment tags ("C1", "O(1)", "H:2"), and the dummy/ghost markers "DA"/"X"
 * and "Symbol:" (which carry no electrons and return 0). Unknown symbols
 * return undefined.
 */
export function atomicNumber(label: string): number | undefined {
  const trimmed = label.trim();
  if (/^(DA|X|Q)$/i.test(trimmed) || trimmed.endsWith(':')) {
    return 0; // dummy atom, point charge, or ghost atom
  }
  const m = /^([A-Za-z]{1,2})/.exec(trimmed);
  if (!m) {
    return undefined;
  }
  const two = m[1].toLowerCase();
  if (two.length === 2 && Z_BY_SYMBOL[two] !== undefined) {
    return Z_BY_SYMBOL[two];
  }
  return Z_BY_SYMBOL[two[0]];
}

/** Normalizes "c", "CL", "O1" -> "C", "Cl", "O". Returns the input on failure. */
export function canonicalSymbol(label: string): string {
  const z = atomicNumber(label);
  if (z === undefined || z === 0) {
    return label.trim();
  }
  return SYMBOLS[z - 1];
}
