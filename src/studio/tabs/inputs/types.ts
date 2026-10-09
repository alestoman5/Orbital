// Request / response / event types of the "inputs" tab, shared by its host side
// (./host.ts) and its webview side (webview/src/tabs/inputs/). Types only — no
// runtime code, no imports of 'vscode', Node or DOM.

import type { GeometryAtom } from '../../../outparser/types';
import type { InputSpec, Program } from '../../../inputs/spec';

/** Same union as src/inputs/nea.ts NeaScript (that module imports Node's path, so it is not imported here). */
export type NeaScriptName = 'from_geometry.py' | 'from_ensemble.py' | 'compare_ensembles.py';

/** Arguments of onNavigate (command orcaInp.newInput, other tabs). */
export interface InputsNavigateArgs {
  geometryFile?: string;
  program?: Program;
  template?: string;
  /** Fields to set on top of the template (nested groups are merged), e.g. { excited: { nroots: 20 } }. */
  spec?: Record<string, unknown>;
  /** Open a sub-tab: 'nea' = the NEA command builder. */
  view?: 'input' | 'nea';
  /** NEA builder inputs (absolute paths), e.g. from the explorer selection. */
  neaInputs?: string[];
  /** NEA script to preselect. */
  neaScript?: NeaScriptName;
}

export type GeometryKind = 'xyz' | 'inp' | 'out' | 'paste' | 'default';

/** A geometry loaded from a file (first frame of an ensemble). */
export interface LoadedGeometry {
  /** Absolute path; undefined for pasted text. */
  path?: string;
  kind: GeometryKind;
  /** File name for display. */
  name: string;
  atoms: GeometryAtom[];
  /** Number of frames (> 1: an ensemble, batch mode). */
  frames: number;
  comment?: string;
  /** From the coordinate block of an .inp / the input echo of an .out. */
  charge?: number;
  multiplicity?: number;
  /** Where the atoms came from, e.g. "final geometry of job 2 of 2". */
  note?: string;
  /** Absolute .xyz path an "* xyzfile" line may point to (the .xyz itself, or the file an .inp references). */
  xyzPath?: string;
}

/** `loadGeometry` */
export interface LoadGeometryParams {
  path: string;
}

/** `saveInput`: write the generated text next to the source geometry, or where the user picks. */
export interface SaveInputParams {
  text: string;
  fileName: string;
  /** Absolute path of the source geometry; the input goes into its folder. */
  sourcePath?: string;
  /** Ask with a save dialog instead of writing next to the source. */
  dialog?: boolean;
  /** Open the written file in the editor. */
  open?: boolean;
  /** "* xyzfile" mode: the .xyz to write next to the input when it does not exist yet. */
  companion?: { name: string; content: string };
}

export interface SaveInputResult {
  /** Written file; undefined when the user cancelled. */
  path?: string;
  companionWritten?: string;
}

/** Ensemble given as a file (preferred) or as pasted multi-XYZ text. */
export type BatchSource = { path: string } | { text: string; name?: string };

export interface BatchPlanParams {
  source: BatchSource;
  spec: InputSpec;
  program: Program;
  /** Use only the first N frames. */
  maxFrames?: number;
  /** Prefix of every job directory, e.g. "geoms/". */
  dirPrefix?: string;
  slurm?: boolean;
}

export interface BatchFileInfo {
  relPath: string;
  size: number;
  executable?: boolean;
}

export interface BatchPlanResult {
  /** Frames in the source. */
  totalFrames: number;
  /** Frames planned (≤ maxFrames). */
  frames: number;
  /** Every planned file when there are few, else the first and last ones (see fileCount). */
  files: BatchFileInfo[];
  fileCount: number;
  totalBytes: number;
  /** Text of the first job file, for preview. */
  sampleJob?: { relPath: string; content: string };
  runAll?: string;
  slurm?: string;
  /** Suggested target folder next to the source. */
  defaultTarget?: string;
  /** Set when the spec cannot be generated (no files then). */
  error?: string;
}

export interface WriteBatchParams extends BatchPlanParams {
  /** Absolute target folder (inside the workspace); without it a folder picker opens. */
  target?: string;
}

export type WriteBatchResult =
  | { status: 'written'; folder: string; written: number }
  | { status: 'cancelled' };

export interface NeaInfo {
  /** Folder that contains scripts/ (commands run from here). */
  root?: string;
  scriptsDir?: string;
  /** How the scripts folder was found. */
  source: 'setting' | 'search' | 'none';
  workspaceFolders: string[];
}

export interface NeaCommandParams {
  script: NeaScriptName;
  inputs: string[];
  sampling?: 'wigner' | 'md';
  nsamples?: number;
  sampleMethod?: string;
  sampleBasis?: string;
  temperature?: number;
  skip?: number;
  stride?: number;
  beads?: number;
  method?: string;
  basis?: string;
  nstates?: number;
  jobs?: number;
  outDir?: string;
}

export interface NeaCommandResult {
  command: string;
  /** Run the command from this folder. */
  cwd: string;
  /** False when scripts/from_geometry.py was not found and cwd is a guess. */
  found: boolean;
  /** No input picked yet: the command uses a placeholder geometry path. */
  placeholder?: boolean;
}
