// Condenses a ParsedOrcaOutput into the per-run facts the status bar, the
// "ORCA Runs" tree and the batch commands all need: did it finish, did the
// SCF / optimization converge, is it a minimum or a saddle point, which
// runtype was requested. Pure logic, no `vscode` import.

import { ParsedOrcaOutput, JobSegment } from '../outparser/types';
import { DEFAULT_IMAG_THRESHOLD, ModeRef, findImaginaryModes } from '../chem/vibrations';

export type RunKind = 'opt' | 'optts' | 'irc' | 'neb' | 'scan' | 'md' | 'sp';

export interface RunSummary {
  status: ParsedOrcaOutput['status'];
  kind: RunKind;
  keywords: string[];
  lastJob?: JobSegment;
  energy?: number;
  scfConverged?: boolean;
  optConverged?: boolean;
  hasFrequencies: boolean;
  imaginary: ModeRef[];
  /** One-word verdict used for icons/filters. */
  verdict: 'running' | 'failed' | 'saddle' | 'ts-ok' | 'ts-bad' | 'ok' | 'unknown';
  /** Short human-readable problems (empty when fine). */
  problems: string[];
  t1?: number;
  d1?: number;
}

/** Keywords from the echoed input's "!" lines. */
export function echoedKeywords(parsed: ParsedOrcaOutput): string[] {
  return parsed.inputEcho
    .map(l => l.split('#')[0].trim())
    .filter(l => l.startsWith('!'))
    .flatMap(l => l.slice(1).trim().split(/\s+/))
    .filter(t => t.length > 0);
}

export function runKindFromKeywords(keywords: string[]): RunKind {
  const up = keywords.map(k => k.toUpperCase());
  if (up.includes('OPTTS')) return 'optts';
  if (up.includes('IRC')) return 'irc';
  if (up.some(k => /NEB/.test(k))) return 'neb';
  if (up.includes('SCANTS')) return 'scan';
  if (up.includes('MD')) return 'md';
  if (up.some(k => /^(OPT|NORMALOPT|LOOSEOPT|TIGHTOPT|VERYTIGHTOPT|COPT|L-OPT|L-OPTH|EXTOPT)$/.test(k))) return 'opt';
  return 'sp';
}

/** Thresholds above which single-reference methods get suspicious. */
export const T1_THRESHOLD = 0.02;
export const D1_THRESHOLD = 0.05;

export function summarizeRun(parsed: ParsedOrcaOutput, imagThreshold = DEFAULT_IMAG_THRESHOLD): RunSummary {
  const keywords = echoedKeywords(parsed);
  const kind = runKindFromKeywords(keywords);
  const lastJob = parsed.jobs[parsed.jobs.length - 1];
  // Frequencies/opt status may live in an earlier job of a multi-job file;
  // take the last job that has them.
  const freqJob = [...parsed.jobs].reverse().find(j => j.frequenciesCm1 && j.frequenciesCm1.length > 0);
  const imaginary = freqJob ? findImaginaryModes(freqJob.frequenciesCm1!, imagThreshold) : [];
  const scfJob = [...parsed.jobs].reverse().find(j => j.scfConverged !== undefined);
  const optJob = [...parsed.jobs].reverse().find(j => j.optConverged !== undefined);
  const energyJob = [...parsed.jobs].reverse().find(j => j.finalEnergyHartree !== undefined);
  const t1 = parsed.jobs.map(j => j.t1Diagnostic).filter(v => v !== undefined).pop();
  const d1 = parsed.jobs.map(j => j.d1Diagnostic).filter(v => v !== undefined).pop();

  const problems: string[] = [];
  if (parsed.status === 'error') problems.push('ORCA aborted');
  if (scfJob?.scfConverged === false) problems.push('SCF not converged');
  if (optJob?.optConverged === false) problems.push('optimization not converged');
  if (parsed.status === 'normal-termination' && (kind === 'opt' || kind === 'optts') && optJob === undefined) {
    problems.push('no "OPTIMIZATION HAS CONVERGED" banner');
  }
  if (t1 !== undefined && t1 > T1_THRESHOLD) problems.push(`T1 = ${t1.toFixed(4)} > ${T1_THRESHOLD}`);
  if (d1 !== undefined && d1 > D1_THRESHOLD) problems.push(`D1 = ${d1.toFixed(4)} > ${D1_THRESHOLD}`);

  let verdict: RunSummary['verdict'];
  if (parsed.status === 'running') {
    verdict = 'running';
  } else if (parsed.status === 'unknown') {
    verdict = 'unknown';
  } else if (parsed.status === 'error' || scfJob?.scfConverged === false || optJob?.optConverged === false) {
    verdict = 'failed';
  } else if (kind === 'optts') {
    verdict = freqJob && imaginary.length !== 1 ? 'ts-bad' : 'ts-ok';
    if (freqJob && imaginary.length !== 1) {
      problems.push(`TS search ended with ${imaginary.length} imaginary modes (a TS needs exactly 1)`);
    }
  } else if (imaginary.length > 0) {
    verdict = 'saddle';
    problems.push(`${imaginary.length} imaginary mode(s), lowest ${imaginary[0].freq.toFixed(2)} cm⁻¹`);
  } else {
    verdict = 'ok';
  }

  return {
    status: parsed.status,
    kind,
    keywords,
    lastJob,
    energy: energyJob?.finalEnergyHartree,
    scfConverged: scfJob?.scfConverged,
    optConverged: optJob?.optConverged,
    hasFrequencies: freqJob !== undefined,
    imaginary,
    verdict,
    problems,
    t1,
    d1
  };
}
