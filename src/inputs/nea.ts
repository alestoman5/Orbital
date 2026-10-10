// Command lines for the uv-vis NEA entry scripts (scripts/from_geometry.py,
// from_ensemble.py, compare_ensembles.py), extracted from the interactive
// builder in src/features/neaRuns.ts (neaCommand) so the Studio can build the
// same strings without vscode. Uses Node's `path` (host side only) so paths
// are made relative exactly as neaCommand does.

import * as path from 'path';

export type NeaScript = 'from_geometry.py' | 'from_ensemble.py' | 'compare_ensembles.py';
export const NEA_SCRIPTS: NeaScript[] = ['from_geometry.py', 'from_ensemble.py', 'compare_ensembles.py'];

export interface NeaCommandOptions {
  script: NeaScript;
  /** Repository root (the parent of scripts/); paths are made relative to it. */
  root: string;
  /** Absolute input paths: one for from_geometry/from_ensemble, several for compare_ensembles. */
  inputs: string[];
  /** from_geometry.py only. */
  sampling?: 'wigner' | 'md';
  nsamples?: number;
  /** Wigner sampling level of theory and temperature (from_geometry.py --sampling wigner). */
  sampleMethod?: string;
  sampleBasis?: string;
  temperature?: number;
  /** MD sampling (from_geometry.py --sampling md). */
  skip?: number;
  stride?: number;
  beads?: number;
  method?: string;
  basis?: string;
  nstates?: number;
  jobs?: number;
  /** Output directory relative to root; default runs/<input stem>[_<sampling>] or runs/compare. */
  outDir?: string;
}

/** POSIX-shell quoting as in neaRuns.ts: bare when safe, otherwise single quotes. */
export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const stem = (p: string) => path.basename(p).replace(/\.[^.]*$/, '');

/** Argument list (already quoted) after "python scripts/<script>". */
export function neaArgs(o: NeaCommandOptions): string[] {
  if (o.inputs.length === 0) {
    throw new Error('buildNeaCommand: no input path.');
  }
  // Forward slashes: the command runs in a POSIX shell even when built on Windows.
  const rel = (p: string) => shellQuote(path.relative(o.root, p).split(path.sep).join('/') || '.');
  const args: string[] = [];
  let outName = stem(o.inputs[0]);
  if (o.script === 'from_geometry.py') {
    const sampling = o.sampling ?? 'wigner';
    outName += `_${sampling}`;
    args.push(rel(o.inputs[0]), '--sampling', sampling, '-n', String(o.nsamples ?? 1000));
    args.push(...(sampling === 'wigner'
      ? ['--sample-method', shellQuote(o.sampleMethod ?? 'PBE'), '--sample-basis', shellQuote(o.sampleBasis ?? 'aug-cc-pVDZ'), '-T', String(o.temperature ?? 300)]
      : ['--skip', String(o.skip ?? 0), '--stride', String(o.stride ?? 1), '--beads', String(o.beads ?? 1)]));
  } else if (o.script === 'compare_ensembles.py') {
    args.push(...o.inputs.map(p => `${stem(p)}=${rel(p)}`));
    outName = 'compare';
  } else {
    args.push(rel(o.inputs[0]));
  }
  args.push(
    '-o', shellQuote(o.outDir ?? `runs/${outName}`),
    '--method', shellQuote(o.method ?? 'adc(3)'),
    '--basis', shellQuote(o.basis ?? 'aug-cc-pVDZ'),
    '--nstates', String(o.nstates ?? 2),
    '-j', String(o.jobs ?? 30)
  );
  return args;
}

/** e.g. "python scripts/from_geometry.py mol.xyz --sampling wigner -n 1000 ... -j 30" (run from `root`). */
export function buildNeaCommand(o: NeaCommandOptions): string {
  return `python scripts/${o.script} ${neaArgs(o).join(' ')}`;
}
