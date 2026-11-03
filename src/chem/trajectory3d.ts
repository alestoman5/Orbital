// Structures for the 3D viewer: every frame of a multi-XYZ file (ORCA
// .allxyz with its ">" separators, _trj.xyz, scan envelopes, MD movies),
// the geometry steps of an ORCA .out (optimization / scan cycles with the
// energy that follows each geometry), and the reference geometry of a
// .hess file. Frame energies and scan coordinates are taken from comment
// lines ("… E -572.789576541", "torsion 180.0 E -572.78 torsion") or from
// a neighbouring <base>.relaxscanact.dat. Pure Node, no `vscode` import.

import * as fs from 'fs';
import * as path from 'path';
import { GeometryAtom } from '../outparser/types';
import { readFrames } from './xyzTrajectory';

export interface Structure {
  symbols: string[];
  /** frames[f] = [x1, y1, z1, x2, …] in Å. */
  frames: number[][];
  comments: string[];
  /** Energy per frame in Eh (null where unknown); undefined when no frame has one. */
  energies?: (number | null)[];
  /** Scan coordinate per frame, when known. */
  coordinate?: { label: string; values: (number | null)[] };
  /** Frames in the file (more than frames.length when strided / capped). */
  totalFrames: number;
  stride: number;
  truncated: boolean;
  /** Where the structure came from, e.g. "12 optimization steps". */
  note?: string;
}

const NUM = '[-+]?(?:\\d+\\.\\d*|\\.\\d+|\\d+)(?:[eE][-+]?\\d+)?';
const ENERGY_RE = new RegExp(`(?:^|\\s)(?:E|Energy|energy|E_tot|Etot)\\s*[=:]?\\s*(${NUM})`);
const LEAD_RE = new RegExp(`^\\s*(\\S+)?\\s*(${NUM})\\s+(?:E|Energy)\\b`);
const ONLY_NUM_RE = new RegExp(`^\\s*(${NUM})\\s*$`);

/** Energy (Eh) and scan coordinate from a comment line. */
export function parseComment(comment: string): { energy?: number; coordinate?: number; coordLabel?: string } {
  const out: { energy?: number; coordinate?: number; coordLabel?: string } = {};
  const e = ENERGY_RE.exec(comment);
  if (e) out.energy = Number(e[1]);
  else {
    const only = ONLY_NUM_RE.exec(comment);
    if (only) out.energy = Number(only[1]);
  }
  const lead = LEAD_RE.exec(comment);
  if (lead) {
    out.coordinate = Number(lead[2]);
    if (lead[1] && !/^[-+]?\d/.test(lead[1])) out.coordLabel = lead[1];
  }
  return out;
}

/** Multi-XYZ text, frames separated by optional blank lines or ORCA's ">" lines. */
export function parseMultiXyz(text: string, stride = 1, maxFrames = Infinity): { symbols: string[][]; frames: number[][]; comments: string[]; total: number; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  const symbols: string[][] = [];
  const frames: number[][] = [];
  const comments: string[] = [];
  let total = 0;
  let truncated = false;
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '' || t === '>') {
      i++;
      continue;
    }
    if (!/^\d+$/.test(t)) break;
    const n = parseInt(t, 10);
    if (i + 1 + n >= lines.length) break;
    const keep = total % stride === 0;
    if (keep && frames.length >= maxFrames) {
      truncated = true;
      break;
    }
    if (keep) {
      const sy: string[] = [];
      const xyz: number[] = [];
      let ok = true;
      for (let a = 0; a < n; a++) {
        const f = (lines[i + 2 + a] ?? '').trim().split(/\s+/);
        const x = Number(f[1]), y = Number(f[2]), z = Number(f[3]);
        if (f.length < 4 || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          ok = false;
          break;
        }
        sy.push(f[0]);
        xyz.push(x, y, z);
      }
      if (ok) {
        symbols.push(sy);
        frames.push(xyz);
        comments.push(lines[i + 1] ?? '');
      }
    }
    total++;
    i += 2 + n;
  }
  return { symbols, frames, comments, total, truncated };
}

/** Rows (coordinate, energy) of an ORCA .relaxscanact.dat / .relaxscanscf.dat. */
export function parseScanDat(text: string): { coordinate: number; energy: number }[] {
  const out: { coordinate: number; energy: number }[] = [];
  for (const l of text.split(/\r?\n/)) {
    const f = l.trim().split(/\s+/);
    if (f.length >= 2 && !l.trim().startsWith('#')) {
      const c = Number(f[0]), e = Number(f[1]);
      if (Number.isFinite(c) && Number.isFinite(e)) out.push({ coordinate: c, energy: e });
    }
  }
  return out;
}

function withComments(s: Structure): Structure {
  const parsed = s.comments.map(parseComment);
  if (!s.energies && parsed.some(p => p.energy !== undefined)) s.energies = parsed.map(p => p.energy ?? null);
  if (!s.coordinate && parsed.filter(p => p.coordinate !== undefined).length >= Math.max(2, s.frames.length / 2)) {
    s.coordinate = { label: parsed.find(p => p.coordLabel)?.coordLabel ?? 'coordinate', values: parsed.map(p => p.coordinate ?? null) };
  }
  return s;
}

/** Large XYZ files are read with the streaming reader. */
const TEXT_LIMIT = 64 * 1024 * 1024;

export function readXyzStructure(file: string, maxFrames = 5000): Structure {
  const size = fs.statSync(file).size;
  let s: Structure;
  if (size <= TEXT_LIMIT) {
    const text = fs.readFileSync(file, 'utf8');
    // count first to choose a stride
    let r = parseMultiXyz(text);
    let stride = 1;
    if (r.frames.length > maxFrames) {
      stride = Math.ceil(r.total / maxFrames);
      r = parseMultiXyz(text, stride, maxFrames);
    }
    if (!r.frames.length) throw new Error(`${path.basename(file)}: no complete XYZ frame.`);
    s = { symbols: r.symbols[0], frames: r.frames, comments: r.comments, totalFrames: r.total, stride, truncated: r.truncated };
  } else {
    const bytesPerFrame = 200;
    const est = size / bytesPerFrame;
    const stride = Math.max(1, Math.ceil(est / maxFrames));
    const r = readFrames(file, { stride, maxFrames });
    if (!r.frames.length) throw new Error(`${path.basename(file)}: no complete XYZ frame.`);
    s = {
      symbols: r.frames[0].symbols,
      frames: r.frames.map(f => f.atoms.flatMap(a => [a.x, a.y, a.z])),
      comments: r.frames.map(f => f.comment),
      totalFrames: r.nFrames,
      stride,
      truncated: r.truncated
    };
  }
  // ORCA relaxed scan: <base>.allxyz / <base>.xyz next to <base>.relaxscanact.dat
  const base = file.replace(/(\.allxyz|_trj\.xyz|\.xyz)$/i, '');
  const dat = `${base}.relaxscanact.dat`;
  if (/\.allxyz$/i.test(file) && fs.existsSync(dat) && s.stride === 1) {
    const rows = parseScanDat(fs.readFileSync(dat, 'utf8'));
    if (rows.length === s.frames.length) {
      s.coordinate = { label: 'scan coordinate', values: rows.map(r => r.coordinate) };
      s.energies = rows.map(r => r.energy);
      s.note = `relaxed scan, ${rows.length} points (${path.basename(dat)})`;
    }
  }
  return withComments(s);
}

/** Every CARTESIAN COORDINATES (ANGSTROEM) block of a .out, each paired with the next FINAL SINGLE POINT ENERGY. */
export function readOutStructure(text: string): Structure {
  const lines = text.split(/\r?\n/);
  const frames: GeometryAtom[][] = [];
  const energies: (number | null)[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*CARTESIAN COORDINATES \(ANGSTROEM\)\s*$/.test(lines[i])) {
      const atoms: GeometryAtom[] = [];
      for (let j = i + 2; j < lines.length; j++) {
        const f = lines[j].trim().split(/\s+/);
        if (f.length !== 4 || !Number.isFinite(Number(f[1]))) break;
        atoms.push({ symbol: f[0], x: Number(f[1]), y: Number(f[2]), z: Number(f[3]) });
      }
      if (atoms.length) {
        frames.push(atoms);
        energies.push(null);
      }
      continue;
    }
    const m = /^\s*FINAL SINGLE POINT ENERGY\s+(-?\d+\.\d+)/.exec(lines[i]);
    if (m && energies.length && energies[energies.length - 1] === null) energies[energies.length - 1] = Number(m[1]);
  }
  if (!frames.length) throw new Error('No CARTESIAN COORDINATES (ANGSTROEM) block in this output.');
  // ORCA prints the final geometry once more after convergence: drop an exact repeat without its own energy
  if (frames.length > 1 && energies[energies.length - 1] === null && sameGeometry(frames[frames.length - 1], frames[frames.length - 2])) {
    frames.pop();
    energies.pop();
  }
  return {
    symbols: frames[0].map(a => a.symbol),
    frames: frames.map(f => f.flatMap(a => [a.x, a.y, a.z])),
    comments: frames.map((_, i) => `step ${i + 1}`),
    energies: energies.some(e => e !== null) ? energies : undefined,
    totalFrames: frames.length,
    stride: 1,
    truncated: false,
    note: frames.length > 1 ? `${frames.length} geometry steps` : 'single geometry'
  };
}

function sameGeometry(a: GeometryAtom[], b: GeometryAtom[]): boolean {
  return a.length === b.length && a.every((x, i) => Math.abs(x.x - b[i].x) < 1e-6 && Math.abs(x.y - b[i].y) < 1e-6 && Math.abs(x.z - b[i].z) < 1e-6);
}
