// Working directories of the uv-vis NEA scripts (scripts/from_geometry.py,
// from_ensemble.py, compare_ensembles.py): geom_NNNN/result.json per
// geometry, written by PySCF ADC jobs. Status categories follow
// scripts/nea/batch.py status(). No `vscode` import.

import * as fs from 'fs';
import * as path from 'path';
import { Stick } from './spectrum';

export type GeomStatus = 'ok' | 'not converged' | 'unreadable' | 'not started';
export const GEOM_STATUSES: GeomStatus[] = ['ok', 'not converged', 'unreadable', 'not started'];

export interface GeomSet {
  dir: string;
  byStatus: Record<GeomStatus, string[]>;
  /** ADC wall times of the converged geometries, ascending. */
  adcTimes: number[];
  /** Excitations of the converged geometries. */
  sticks: Stick[];
  nOk: number;
}

interface AdcResult {
  converged?: boolean;
  excitation_energies_ev?: number[];
  oscillator_strengths?: number[];
  time_adc_s?: number;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function subdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(naturalCompare);
  } catch {
    return [];
  }
}

const isGeomDir = (name: string) => /^geom_\d+$/.test(name);

/**
 * Folders holding geom_NNNN directories below a run directory: the folder
 * itself, <folder>/geoms, or <folder>/<label>/geoms (compare_ensembles.py).
 */
export function findGeomSets(folder: string): string[] {
  if (subdirs(folder).some(isGeomDir)) {
    return [folder];
  }
  const direct = path.join(folder, 'geoms');
  if (subdirs(direct).some(isGeomDir)) {
    return [direct];
  }
  return subdirs(folder).map(d => path.join(folder, d, 'geoms')).filter(d => subdirs(d).some(isGeomDir));
}

export function readGeomSet(dir: string): GeomSet {
  const byStatus = Object.fromEntries(GEOM_STATUSES.map(s => [s, [] as string[]])) as Record<GeomStatus, string[]>;
  const adcTimes: number[] = [];
  const sticks: Stick[] = [];
  for (const name of subdirs(dir).filter(isGeomDir)) {
    const file = path.join(dir, name, 'result.json');
    if (!fs.existsSync(file)) {
      byStatus['not started'].push(name);
      continue;
    }
    let r: AdcResult;
    try {
      r = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      byStatus.unreadable.push(name);
      continue;
    }
    if (!r.converged) {
      byStatus['not converged'].push(name);
      continue;
    }
    byStatus.ok.push(name);
    adcTimes.push(r.time_adc_s ?? 0);
    const e = r.excitation_energies_ev ?? [];
    const f = r.oscillator_strengths ?? [];
    for (let i = 0; i < Math.min(e.length, f.length); i++) {
      sticks.push({ energyEv: e[i], weight: f[i] });
    }
  }
  adcTimes.sort((a, b) => a - b);
  return { dir, byStatus, adcTimes, sticks, nOk: byStatus.ok.length };
}

/** Number of frames in a multi-XYZ file (stops at the first malformed count line). */
export function countXyzFrames(text: string): number {
  const lines = text.split(/\r?\n/);
  let n = 0;
  let i = 0;
  while (i < lines.length) {
    const natoms = parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(natoms) || natoms <= 0) {
      break;
    }
    n++;
    i += natoms + 2;
  }
  return n;
}
