// Batch planning for ensembles (Wigner samples, MD snapshots, conformers):
// split a multi-XYZ file into frames and plan one job directory per frame
// plus run_all.sh / submit_slurm.sh. Pure: returns file contents only; the
// fs part lives in batchFs.ts. No Node / DOM / vscode imports.

import { GeometryAtom } from '../outparser/types';
import { formatXyz, parseXyz } from '../chem/inputFile';
import { buildOrcaInput } from './orca';
import { buildPyscfScript } from './pyscf';
import { InputSpec, Program, cloneSpec } from './spec';

export interface EnsembleFrame {
  /** 1-based position in the ensemble. */
  index: number;
  /** Directory name, e.g. geom_0001. */
  name: string;
  comment: string;
  atoms: GeometryAtom[];
  /** The frame as a standalone .xyz text. */
  xyz: string;
}

export interface SplitOptions {
  prefix?: string;
  digits?: number;
  maxFrames?: number;
}

/**
 * Splits a multi-XYZ text into frames (count line, comment line, atoms),
 * stopping at the first malformed count line like run_ensemble.py does.
 */
export function splitEnsemble(text: string, options: SplitOptions = {}): EnsembleFrame[] {
  const prefix = options.prefix ?? 'geom_';
  const digits = options.digits ?? 4;
  const lines = text.split(/\r\n|\r|\n/);
  const frames: EnsembleFrame[] = [];
  let i = 0;
  while (i < lines.length && (options.maxFrames === undefined || frames.length < options.maxFrames)) {
    const countLine = lines[i].trim();
    if (!/^\d+$/.test(countLine)) {
      break;
    }
    const n = parseInt(countLine, 10);
    if (n <= 0 || i + 2 + n > lines.length) {
      break;
    }
    const block = lines.slice(i, i + 2 + n);
    const atoms = parseXyz(block.join('\n'));
    if (atoms.length !== n) {
      break; // malformed atom line
    }
    const index = frames.length + 1;
    const comment = block[1].trim();
    frames.push({ index, name: `${prefix}${String(index).padStart(digits, '0')}`, comment, atoms, xyz: formatXyz(atoms, comment) });
    i += 2 + n;
  }
  return frames;
}

export interface BatchFile {
  /** Forward-slash path relative to the batch root. */
  relPath: string;
  content: string;
  /** Shell scripts get the executable bit when written. */
  executable?: boolean;
}

export interface BatchOptions {
  /** Prefix of every job directory, e.g. "geoms/" (default: none). */
  dirPrefix?: string;
  /** Also write submit_slurm.sh (job-array template with __PLACEHOLDERS__). Default true. */
  slurm?: boolean;
}

/**
 * One directory per frame — ORCA: job.inp (inline geometry); PySCF: run.py
 * reading geom.xyz — plus dirs.txt, run_all.sh and (optionally)
 * submit_slurm.sh. Throws if the spec cannot be generated for `program`.
 */
export function planBatch(spec: InputSpec, frames: EnsembleFrame[], program: Program, options: BatchOptions = {}): BatchFile[] {
  const prefix = (options.dirPrefix ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (prefix.split('/').some(p => p === '..')) {
    throw new Error(`dirPrefix "${prefix}" must stay inside the batch folder.`);
  }
  if (frames.length === 0) {
    throw new Error('No geometries to plan a batch for.');
  }
  const files: BatchFile[] = [];
  const dirs: string[] = [];
  for (const frame of frames) {
    const s = cloneSpec(spec);
    s.geometry = { atoms: frame.atoms.map(a => ({ ...a })) };
    s.title = `${spec.title} — ${frame.name}`;
    s.comment = [spec.comment.trim(), frame.comment ? `Geometry: ${frame.comment}` : ''].filter(Boolean).join('\n');
    const dir = `${prefix}${frame.name}`;
    dirs.push(dir);
    if (program === 'orca') {
      const r = buildOrcaInput(s);
      if (r.errors.length > 0) {
        throw new Error(`${frame.name}: ${r.errors.join(' ')}`);
      }
      files.push({ relPath: `${dir}/job.inp`, content: r.text });
    } else {
      s.geometry.xyzFile = 'geom.xyz';
      const r = buildPyscfScript(s);
      if (r.errors.length > 0) {
        throw new Error(`${frame.name}: ${r.errors.join(' ')}`);
      }
      files.push({ relPath: `${dir}/geom.xyz`, content: frame.xyz });
      files.push({ relPath: `${dir}/run.py`, content: r.text, executable: true });
    }
  }
  files.push({ relPath: 'dirs.txt', content: dirs.join('\n') + '\n' });
  files.push({ relPath: 'run_all.sh', content: runAllScript(spec, program, dirs.length), executable: true });
  if (options.slurm !== false) {
    files.push({ relPath: 'submit_slurm.sh', content: slurmScript(spec, program, dirs.length), executable: true });
  }
  return files;
}

/** bash: runs every directory of dirs.txt, JOBS at a time, skipping finished ones. */
export function runAllScript(spec: InputSpec, program: Program, njobs: number): string {
  const nprocs = spec.resources.nprocs;
  const head = [
    '#!/usr/bin/env bash',
    `# Runs the ${njobs} ${program === 'orca' ? 'ORCA' : 'PySCF'} jobs listed in dirs.txt, JOBS at a time`,
    `# (default: CPU cores / ${nprocs}, each job uses ${nprocs} core${nprocs > 1 ? 's' : ''}). Resumable: finished directories are skipped.`,
    '# Generated by Orbital Studio.',
    '#',
    program === 'orca'
      ? '#   bash run_all.sh                 JOBS=4 ORCA=/opt/orca/orca bash run_all.sh'
      : '#   bash run_all.sh                 JOBS=8 PYTHON=/path/to/env/bin/python bash run_all.sh',
    'set -u',
    'cd "$(dirname "$0")" || exit 1',
    `NPROCS=${nprocs}`,
    'JOBS=${JOBS:-$(( $(nproc 2>/dev/null || echo "$NPROCS") / NPROCS ))}',
    '[ "$JOBS" -ge 1 ] 2>/dev/null || JOBS=1',
    'export LOG=run_all.log'
  ];
  const body = program === 'orca'
    ? [
      'export ORCA=${ORCA:-$(command -v orca || true)}   # ORCA must be called by its full path for parallel (MPI) runs',
      '[ -n "$ORCA" ] || { echo "orca not found: set ORCA=/full/path/to/orca" >&2; exit 1; }',
      '',
      'run_one() {',
      '  d=$1',
      '  if grep -qs "ORCA TERMINATED NORMALLY" "$d/job.out"; then',
      '    echo "$d: done, skipped"; return 0',
      '  fi',
      '  start=$(date +%s)',
      '  (cd "$d" && "$ORCA" job.inp > job.out 2> run.log)',
      '  if grep -qs "ORCA TERMINATED NORMALLY" "$d/job.out"; then status=ok; else status="FAILED (see $d/job.out)"; fi',
      '  echo "$d: $status ($(( $(date +%s) - start )) s)"',
      '}'
    ]
    : [
      'export PYTHON=${PYTHON:-python3}',
      '',
      'run_one() {',
      '  d=$1',
      '  # any result.json counts as finished: an unconverged run is deterministic, rerunning it unchanged fails again',
      '  if [ -f "$d/result.json" ]; then',
      '    echo "$d: done, skipped"; return 0',
      '  fi',
      '  start=$(date +%s)',
      '  (cd "$d" && "$PYTHON" run.py geom.xyz result.json > run.log 2>&1)',
      '  if grep -qs \'"converged": true\' "$d/result.json"; then status=ok; else status="FAILED (see $d/run.log)"; fi',
      '  echo "$d: $status ($(( $(date +%s) - start )) s)"',
      '}'
    ];
  const tail = [
    'export -f run_one',
    '',
    'echo "$(date): $(grep -c . dirs.txt) jobs, $JOBS at a time" | tee -a "$LOG"',
    'grep -v \'^[[:space:]]*$\' dirs.txt | xargs -P "$JOBS" -I{} bash -c \'run_one "$1"\' _ {} | tee -a "$LOG"',
    'echo "$(date): finished, $(grep -c FAILED "$LOG") failure line(s) in $LOG"'
  ];
  return [...head, ...body, ...tail, ''].join('\n');
}

/** Slurm job-array template; __PLACEHOLDERS__ must be filled in (or the lines deleted). */
export function slurmScript(spec: InputSpec, program: Program, njobs: number): string {
  const { nprocs, maxcoreMB } = spec.resources;
  // ORCA may use more than %maxcore per process; leave ~25 % headroom.
  const memPerCpu = Math.round(maxcoreMB * (program === 'orca' ? 1.25 : 1.1));
  const lines = [
    '#!/usr/bin/env bash',
    `#SBATCH --job-name=${slug(spec.title)}`,
    `#SBATCH --array=1-${njobs}%__MAX_PARALLEL__`,
    program === 'orca' ? `#SBATCH --ntasks=${nprocs}` : '#SBATCH --ntasks=1',
    program === 'orca' ? '#SBATCH --cpus-per-task=1' : `#SBATCH --cpus-per-task=${nprocs}`,
    `#SBATCH --mem-per-cpu=${memPerCpu}M`,
    '#SBATCH --time=__HH:MM:SS__',
    '#SBATCH --partition=__PARTITION__',
    '#SBATCH --account=__ACCOUNT__',
    '#SBATCH --output=slurm-%A_%a.log',
    '#',
    '# Job array over dirs.txt (one line per job). Replace the __PLACEHOLDERS__ above',
    '# (delete --partition/--account if your cluster does not need them), then: sbatch submit_slurm.sh',
    '# Generated by Orbital Studio.',
    'set -u',
    'cd "${SLURM_SUBMIT_DIR:-.}" || exit 1',
    'd=$(sed -n "${SLURM_ARRAY_TASK_ID}p" dirs.txt)',
    '[ -n "$d" ] || { echo "no line ${SLURM_ARRAY_TASK_ID} in dirs.txt" >&2; exit 1; }',
    '# module load __MODULES__'
  ];
  if (program === 'orca') {
    lines.push(
      'ORCA=${ORCA:-__FULL_PATH_TO_ORCA__}   # full path, required for MPI runs',
      'if grep -qs "ORCA TERMINATED NORMALLY" "$d/job.out"; then echo "$d: done"; exit 0; fi',
      'cd "$d" || exit 1',
      '# optional: run in node-local scratch and copy back, e.g. cp job.inp "$TMPDIR" && cd "$TMPDIR"',
      '"$ORCA" job.inp > job.out 2> run.log',
      'grep -qs "ORCA TERMINATED NORMALLY" job.out'
    );
  } else {
    lines.push(
      'PYTHON=${PYTHON:-python3}',
      'if [ -f "$d/result.json" ]; then echo "$d: done"; exit 0; fi',
      'cd "$d" || exit 1',
      `"$PYTHON" run.py geom.xyz result.json --threads "\${SLURM_CPUS_PER_TASK:-${nprocs}}" > run.log 2>&1`
    );
  }
  return lines.join('\n') + '\n';
}

function slug(s: string): string {
  return (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'orbital').slice(0, 40);
}
