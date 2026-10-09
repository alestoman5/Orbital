// State of the Input Builder and the derived generation result. The spec is
// the single source of truth; ORCA / PySCF text is generated from it here
// (pure modules from src/inputs) for an instant live preview.

import type { GeometryAtom } from '../../../../src/outparser/types';
import { formatXyz } from '../../../../src/chem/inputFile';
import { InputSpec, Program, SpecIssue, cloneSpec, defaultSpec, normalizeSpec, supportedPrograms } from '../../../../src/inputs/spec';
import { buildOrcaInput } from '../../../../src/inputs/orca';
import { buildPyscfScript } from '../../../../src/inputs/pyscf';
import { defaultFileName, normalizeFileName } from '../../../../src/studio/tabs/inputs/shared';
import type { GeometryKind, LoadedGeometry, NeaScriptName } from '../../../../src/studio/tabs/inputs/types';

export interface Source {
  kind: GeometryKind;
  name: string;
  path?: string;
  xyzPath?: string;
  frames: number;
  note?: string;
  comment?: string;
}

export interface NeaForm {
  script: NeaScriptName;
  inputs: string[];
  sampling: 'wigner' | 'md';
  nsamples: number;
  sampleMethod: string;
  sampleBasis: string;
  temperature: number;
  skip: number;
  stride: number;
  beads: number;
  method: string;
  basis: string;
  nstates: number;
  jobs: number;
  outDir: string;
}

export interface Model {
  spec: InputSpec;
  program: Program;
  template?: string;
  source: Source;
  /** Pasted XYZ text (kept for batch mode of a pasted ensemble). */
  pasteText: string;
  /** "* xyzfile" instead of inline coordinates. */
  useXyzFile: boolean;
  /** '' = derived from formula + method. */
  fileName: string;
  batch: { enabled: boolean; maxFrames: number; dirPrefix: string; slurm: boolean };
  galleryOpen: boolean;
  sub: 'input' | 'nea';
  open: Record<string, boolean>;
  /** Last file the studio was opened for (orcaInp.newInput). */
  activeFile?: string;
  nea: NeaForm;
}

export const DEFAULT_SOURCE: Source = { kind: 'default', name: 'Water (example)', frames: 1, note: 'import a geometry to start' };

export function defaultNea(): NeaForm {
  return {
    script: 'from_geometry.py', inputs: [], sampling: 'wigner', nsamples: 1000, sampleMethod: 'PBE', sampleBasis: 'aug-cc-pVDZ',
    temperature: 300, skip: 0, stride: 1, beads: 1, method: 'adc(3)', basis: 'aug-cc-pVDZ', nstates: 2, jobs: 30, outDir: ''
  };
}

export function defaultModel(): Model {
  return {
    spec: defaultSpec(),
    program: 'orca',
    source: { ...DEFAULT_SOURCE },
    pasteText: '',
    useXyzFile: false,
    fileName: '',
    batch: { enabled: true, maxFrames: 0, dirPrefix: '', slurm: true },
    galleryOpen: true,
    sub: 'input',
    open: {},
    nea: defaultNea()
  };
}

/** Restores a saved model, filling anything missing (older saves, hand edits). */
export function restoreModel(saved: Partial<Model> | undefined): Model {
  const d = defaultModel();
  if (!saved || typeof saved !== 'object') {
    return d;
  }
  return {
    ...d,
    ...saved,
    spec: normalizeSpec(saved.spec ?? {}),
    program: saved.program === 'pyscf' ? 'pyscf' : 'orca',
    source: { ...d.source, ...(saved.source ?? {}) },
    batch: { ...d.batch, ...(saved.batch ?? {}) },
    open: { ...(saved.open ?? {}) },
    nea: { ...d.nea, ...(saved.nea ?? {}) }
  };
}

export const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
const stem = (p: string) => basename(p).replace(/\.[^.]*$/, '');

/** Batch mode is on: an ensemble is loaded and the user did not switch it off. */
export function batchActive(m: Model): boolean {
  return m.source.frames > 1 && m.batch.enabled;
}

export function fileName(m: Model): string {
  return m.fileName.trim()
    ? normalizeFileName(m.fileName, m.program)
    : defaultFileName(m.spec, m.program, m.source.name);
}

/**
 * The name "* xyzfile" refers to: the source .xyz when it sits next to where
 * the input is saved, otherwise "<input stem>.xyz" written as a companion.
 */
export function xyzReference(m: Model): { name: string; companion?: { name: string; content: string } } {
  const src = m.source;
  if (src.xyzPath && src.path && dirname(src.xyzPath).toLowerCase() === dirname(src.path).toLowerCase()) {
    return { name: basename(src.xyzPath) };
  }
  const name = `${stem(fileName(m))}.xyz`;
  return { name, companion: { name, content: formatXyz(m.spec.geometry.atoms, m.spec.title) } };
}

/** The spec the generator gets: the form's spec plus the xyzfile choice. */
export function effectiveSpec(m: Model): InputSpec {
  const s = cloneSpec(m.spec);
  if (m.useXyzFile && !batchActive(m)) {
    s.geometry.xyzFile = xyzReference(m).name;
  } else {
    delete s.geometry.xyzFile;
  }
  return s;
}

export interface Generated {
  text: string;
  issues: SpecIssue[];
  errors: string[];
  requires: string[];
  /** Programs that generate this spec without errors. */
  supported: Program[];
}

export function generate(m: Model): Generated {
  const spec = effectiveSpec(m);
  const supported = supportedPrograms(spec);
  if (m.program === 'orca') {
    const r = buildOrcaInput(spec);
    return { text: r.text, issues: r.issues, errors: r.errors, requires: [], supported };
  }
  const r = buildPyscfScript(spec);
  return { text: r.text, issues: r.issues, errors: r.errors, requires: r.requires, supported };
}

/** New source + atoms from a loaded geometry (charge / multiplicity taken over when the file has them). */
export function applyGeometry(m: Model, g: LoadedGeometry, atoms: GeometryAtom[] = g.atoms): void {
  m.spec.geometry = { atoms: atoms.map(a => ({ symbol: a.symbol, x: a.x, y: a.y, z: a.z })) };
  if (typeof g.charge === 'number') {
    m.spec.charge = g.charge;
  }
  if (typeof g.multiplicity === 'number') {
    m.spec.multiplicity = g.multiplicity;
  }
  m.source = { kind: g.kind, name: g.name, path: g.path, xyzPath: g.xyzPath, frames: g.frames, note: g.note, comment: g.comment };
  m.fileName = '';
  if (g.kind !== 'paste') {
    m.pasteText = '';
  }
}
