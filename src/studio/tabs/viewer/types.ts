// Request / response types of the "viewer" studio tab (3D structures,
// trajectories, normal modes, orbitals). Types only — no runtime code, no
// imports of 'vscode', Node or DOM.

export type SourceKind = 'xyz' | 'allxyz' | 'out' | 'hess' | 'cube';

export interface SourceFile {
  path: string;
  /** Shortest unique path suffix. */
  label: string;
  rel: string;
  kind: SourceKind;
  size: number;
  mtimeMs: number;
  /** Folder relative to the workspace, for grouping. */
  folder: string;
}

export interface SourceList {
  files: SourceFile[];
  capped: boolean;
}

export interface ModeInfo {
  /** Index into the 3N list (ORCA numbering). */
  index: number;
  freq: number;
}

export interface StructureResult {
  path: string;
  kind: SourceKind;
  symbols: string[];
  /** frames[f] = [x1, y1, z1, …] in Å. */
  frames: number[][];
  comments: string[];
  /** 1-based bond pairs of the first frame. */
  bonds: [number, number][];
  energies?: (number | null)[];
  coordinate?: { label: string; values: (number | null)[] };
  totalFrames: number;
  stride: number;
  truncated: boolean;
  note?: string;
  /** Vibrational modes (non-zero frequencies) of a .out / .hess. */
  modes?: ModeInfo[];
  /** The .out has an ORBITAL ENERGIES table. */
  hasOrbitals: boolean;
  /** Cube files that belong to this source (same folder, same base name, or the file itself). */
  cubes: CubeRef[];
}

export interface CubeRef {
  path: string;
  name: string;
  /** MO index from the file name (ORCA numbering), if it has one. */
  mo?: number;
  spin?: 'a' | 'b';
}

export interface ModeResult {
  index: number;
  freq: number;
  /** 3N displacement vector (unit length, Cartesian). */
  vector: number[];
}

export interface LevelRow {
  index: number;
  occ: number;
  energyEv: number;
  /** c² fraction per element (only with printed coefficients). */
  elements?: Record<string, number>;
  /** Largest atom contributions, [0-based atom, fraction], descending. */
  topAtoms?: [number, number][];
  /** Angular momentum fractions (s, p, d, …). */
  shells?: Record<string, number>;
  /** π fraction relative to the chosen plane. */
  pi?: number;
  cube?: string;
}

export interface OrbitalSetView {
  spin: 'restricted' | 'alpha' | 'beta';
  homo: number;
  levels: LevelRow[];
}

export interface StateRow {
  state: number;
  method: string;
  multiplicity: string;
  energyEv: number;
  wavelengthNm: number;
  fosc?: number;
  s2?: number;
  contributions: { from: number; to: number; spin: 'a' | 'b'; weight: number }[];
}

export interface OrbitalsParams {
  path: string;
  /** 1-based atoms defining the plane for the π fraction (3 or 4). */
  plane?: number[];
}

export interface OrbitalsResult {
  path: string;
  sets: OrbitalSetView[];
  states: StateRow[];
  hasCoefficients: boolean;
  /** Plane actually used (1-based), when π fractions were computed. */
  plane?: number[];
  /** Basis looks orthogonal (semi-empirical), so c² is a population. */
  orthogonalBasis: boolean;
  method?: string;
}

export interface IsoParams {
  path: string;
  /** Isovalue (absolute); default 0.03. */
  iso?: number;
}

export interface IsoMeshView {
  positions: number[];
  normals: number[];
  indices: number[];
}

export interface IsoResult {
  path: string;
  iso: number;
  positive: IsoMeshView;
  negative: IsoMeshView;
  absMax: number;
  step: number;
  /** Cube atoms (Å), to check the orbital matches the structure shown. */
  atoms: { symbol: string; x: number; y: number; z: number }[];
  comment: string;
}

export interface PlotsBlockParams {
  path: string;
  mos: number[];
  grid?: number;
}

export interface PlotsBlockResult {
  text: string;
  /** <base>.inp next to the .out, if it exists. */
  input?: string;
}

/** Arguments of openStudio('viewer', args). */
export interface ViewerNavigateArgs {
  file?: string;
  /** Start on the orbitals panel. */
  orbitals?: boolean;
  /** Animate this normal mode. */
  mode?: number;
}
