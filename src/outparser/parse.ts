// Orchestrates src/outparser/sections.ts: splits a .out file into job
// segments, runs the section parsers over each segment in file order, and
// merges the results into a single ParsedOrcaOutput.

import { JobSegment, ParsedOrcaOutput } from './types';
import {
  OPT_CYCLE_HEADER_RE,
  parseCartesianCoordinatesBlock,
  parseFinalSinglePointEnergy,
  parseOptCycle,
  parseScfIterations,
  parseTerminationStatus,
  parseTotalRunTime,
  parseWarningLine
} from './sections';

// Anchored to the start of the line (mod leading whitespace) so this does
// NOT match `$new_job` when it merely shows up inside ORCA's "|  N> ..."
// echo of the input deck near the top of the file — only an unprefixed
// occurrence (the actual job separator) counts.
const NEW_JOB_MARKER_RE = /^\s*\$new_job\b/i;
// BEST-EFFORT / TODO: the exact banner ORCA prints between computed results
// for multi-job inputs (as opposed to the echoed `$new_job` in the input
// deck reproduction) is not independently verified. Falling back to no
// split (a single job segment) is safe for the common single-job case.
const JOB_NUMBER_BANNER_RE = /\bJOB NUMBER\s+\d+/i;

const FINAL_ENERGY_HEADER_RE = /FINAL SINGLE POINT ENERGY/;
const CONVERGENCE_TABLE_TITLE_RE = /Geometry convergence/i;
const CARTESIAN_HEADER_RE = /^\s*CARTESIAN COORDINATES \(ANGSTROEM\)\s*$/;
const SCF_HEADER_RE = /ITER\s+Energy\s+Delta-E/i;
const WARNING_HEADER_RE = /^\s*Warning:/;

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Splits `lines` into [start, end) ranges, one per detected job segment. */
function splitIntoJobSegments(lines: string[]): { start: number; end: number }[] {
  const boundaries: number[] = [0];
  for (let i = 1; i < lines.length; i++) {
    if (NEW_JOB_MARKER_RE.test(lines[i]) || JOB_NUMBER_BANNER_RE.test(lines[i])) {
      boundaries.push(i);
    }
  }
  boundaries.push(lines.length);

  const segments: { start: number; end: number }[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (boundaries[i] < boundaries[i + 1]) {
      segments.push({ start: boundaries[i], end: boundaries[i + 1] });
    }
  }
  return segments.length > 0 ? segments : [{ start: 0, end: lines.length }];
}

/** Runs every section parser over one job segment's lines, in file order. */
function parseJobSegment(segment: string[]): JobSegment {
  const job: JobSegment = { scfCycles: [], optCycles: [], warnings: [] };
  // "GEOMETRY OPTIMIZATION CYCLE   N" banners come before that cycle's
  // "Geometry convergence" table (with a CARTESIAN COORDINATES block in
  // between) — track the most recent cycle number here so it can be
  // attached to the table when we reach it, same pattern diagnostics.ts
  // uses for its own loop-local block/coordinate tracking.
  let currentOptCycleNumber = 0;

  let i = 0;
  while (i < segment.length) {
    const line = segment[i];

    if (FINAL_ENERGY_HEADER_RE.test(line)) {
      const { value, nextIndex } = parseFinalSinglePointEnergy(segment, i);
      if (value !== undefined) {
        job.finalEnergyHartree = value;
      }
      i = nextIndex;
      continue;
    }

    const cycleHeader = OPT_CYCLE_HEADER_RE.exec(line);
    if (cycleHeader) {
      currentOptCycleNumber = parseInt(cycleHeader[1], 10);
      i++;
      continue;
    }

    if (CONVERGENCE_TABLE_TITLE_RE.test(line)) {
      const { value, nextIndex } = parseOptCycle(segment, i, currentOptCycleNumber);
      if (value) {
        job.optCycles.push(value);
      }
      i = nextIndex;
      continue;
    }

    if (CARTESIAN_HEADER_RE.test(line)) {
      // A .out file prints this block repeatedly (once per geometry
      // step); keep overwriting so the last one wins, per spec.
      const { value, nextIndex } = parseCartesianCoordinatesBlock(segment, i);
      if (value && value.length > 0) {
        job.finalGeometry = value;
      }
      i = nextIndex;
      continue;
    }

    if (SCF_HEADER_RE.test(line)) {
      const { value, nextIndex } = parseScfIterations(segment, i);
      if (value.length > 0) {
        job.scfCycles.push(...value);
      }
      i = nextIndex;
      continue;
    }

    if (WARNING_HEADER_RE.test(line)) {
      const { value, nextIndex } = parseWarningLine(segment, i);
      if (value) {
        job.warnings.push(value);
      }
      i = nextIndex;
      continue;
    }

    i++;
  }

  return job;
}

/** Parses a whole ORCA .out file's text into a ParsedOrcaOutput. */
export function parseOrcaOutput(text: string): ParsedOrcaOutput {
  const lines = splitLines(text);
  const segments = splitIntoJobSegments(lines);
  const jobs = segments.map(({ start, end }) => parseJobSegment(lines.slice(start, end)));

  const { value: status } = parseTerminationStatus(lines, 0);
  const { value: totalRunTimeSeconds } = parseTotalRunTime(lines, 0);

  return { status, jobs, totalRunTimeSeconds };
}
