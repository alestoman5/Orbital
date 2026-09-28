// Light structural reader/writer for ORCA .inp text: simple-input keywords,
// the coordinate block (inline "* xyz" or "* xyzfile") and %block names.
// Shared by the saddle-point displacement, basis-set variants, and the
// semantic diagnostics. Pure string logic, no `vscode` import.

import { GeometryAtom } from '../outparser/types';

export interface CoordinateBlock {
  /** "xyz", "xyzfile", "int", "gzmt", ... (lower-case). */
  type: string;
  charge: number;
  multiplicity: number;
  /** Line index of the "* xyz 0 1" header. */
  headerLine: number;
  /**
   * Line index of the closing "*" for inline blocks; same as headerLine for
   * one-line forms ("* xyzfile 0 1 file.xyz"). -1 if the block never closes.
   */
  endLine: number;
  /** File name for xyzfile/gzmtfile forms. */
  file?: string;
  /** Inline Cartesian atoms (xyz type only), with their line indices. */
  atoms: (GeometryAtom & { line: number })[];
}

export interface OrcaInput {
  lines: string[];
  /** Tokens from every "!" line, in order (comments stripped). */
  keywords: string[];
  /** Lower-case names of every %block, in order. */
  blocks: string[];
  coords?: CoordinateBlock;
}

const COORD_HEADER_RE = /^\s*\*\s*([A-Za-z]+)\s+(-?\d+)\s+(\d+)\s*(\S+)?/;
const ATOM_RE = /^\s*([A-Za-z][A-Za-z0-9:()]*)\s+(-?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+(-?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/;

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return hash >= 0 ? line.slice(0, hash) : line;
}

/** Parses the parts of an .inp file the chemistry helpers need. */
export function parseOrcaInput(text: string): OrcaInput {
  const lines = splitLines(text);
  const keywords: string[] = [];
  const blocks: string[] = [];
  let coords: CoordinateBlock | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    const trimmed = line.trim();
    if (trimmed.startsWith('!')) {
      keywords.push(...trimmed.slice(1).trim().split(/\s+/).filter(t => t.length > 0));
      continue;
    }
    const block = /^%\s*([A-Za-z][A-Za-z0-9_]*)/.exec(trimmed);
    if (block) {
      blocks.push(block[1].toLowerCase());
      continue;
    }
    if (coords === undefined) {
      const h = COORD_HEADER_RE.exec(line);
      if (h) {
        const type = h[1].toLowerCase();
        coords = {
          type,
          charge: parseInt(h[2], 10),
          multiplicity: parseInt(h[3], 10),
          headerLine: i,
          endLine: -1,
          atoms: []
        };
        if (type.endsWith('file')) {
          coords.file = h[4];
          coords.endLine = i;
          continue;
        }
        for (let j = i + 1; j < lines.length; j++) {
          const inner = stripComment(lines[j]);
          if (/^\s*\*\s*$/.test(inner)) {
            coords.endLine = j;
            i = j;
            break;
          }
          if (type === 'xyz') {
            const a = ATOM_RE.exec(inner);
            if (a) {
              coords.atoms.push({
                symbol: a[1],
                x: parseFloat(a[2]),
                y: parseFloat(a[3]),
                z: parseFloat(a[4]),
                line: j
              });
            }
          }
          if (j === lines.length - 1) {
            i = j;
          }
        }
      }
    }
  }
  return { lines, keywords, blocks, coords };
}

/** Case-insensitive keyword membership. */
export function hasKeyword(input: { keywords: string[] }, ...names: string[]): boolean {
  const set = new Set(input.keywords.map(k => k.toLowerCase()));
  return names.some(n => set.has(n.toLowerCase()));
}

/** Formats atoms as the body of an .xyz file (without the count/comment lines). */
export function formatAtomLines(atoms: GeometryAtom[]): string[] {
  const f = (v: number) => v.toFixed(8).padStart(15);
  return atoms.map(a => `${a.symbol.padEnd(3)}${f(a.x)}${f(a.y)}${f(a.z)}`);
}

/** Full .xyz file text. */
export function formatXyz(atoms: GeometryAtom[], comment = ''): string {
  return [String(atoms.length), comment, ...formatAtomLines(atoms)].join('\n') + '\n';
}

/** Reads a plain .xyz file (count line, comment line, atoms). */
export function parseXyz(text: string): GeometryAtom[] {
  const lines = splitLines(text);
  const n = parseInt(lines[0], 10);
  const atoms: GeometryAtom[] = [];
  for (let k = 0; k < n && k + 2 < lines.length; k++) {
    const a = ATOM_RE.exec(lines[k + 2]);
    if (a) {
      atoms.push({ symbol: a[1], x: parseFloat(a[2]), y: parseFloat(a[3]), z: parseFloat(a[4]) });
    }
  }
  return atoms;
}

/**
 * Returns a copy of the input text in which the coordinate block (inline or
 * one-line xyzfile form) is replaced by "* xyzfile <charge> <mult> <file>".
 * Everything else — keywords, %blocks, comments — is kept verbatim. Throws
 * if the input has no coordinate block.
 */
export function replaceCoordinatesWithXyzFile(text: string, xyzFileName: string): string {
  const input = parseOrcaInput(text);
  const c = input.coords;
  if (!c) {
    throw new Error('No coordinate block ("* xyz ..." / "* xyzfile ...") found in the input.');
  }
  const end = c.endLine >= 0 ? c.endLine : input.lines.length - 1;
  const header = `* xyzfile ${c.charge} ${c.multiplicity} ${xyzFileName}`;
  const out = [...input.lines.slice(0, c.headerLine), header, ...input.lines.slice(end + 1)];
  return out.join('\n');
}

/**
 * Replaces each simple-input token matching `from` (case-insensitive) with
 * `to`, on "!" lines only. Returns the new text and how many tokens changed.
 */
export function replaceSimpleKeyword(text: string, from: string, to: string): { text: string; count: number } {
  let count = 0;
  const lines = splitLines(text).map(line => {
    if (!/^\s*!/.test(line)) {
      return line;
    }
    const hash = line.indexOf('#');
    const code = hash >= 0 ? line.slice(0, hash) : line;
    const comment = hash >= 0 ? line.slice(hash) : '';
    const replaced = code.replace(/(\s|!)(\S+)/g, (m, sep: string, tok: string) => {
      if (tok.toLowerCase() === from.toLowerCase()) {
        count++;
        return sep + to;
      }
      return m;
    });
    return replaced + comment;
  });
  return { text: lines.join('\n'), count };
}

/** Appends keywords to the first "!" line (or inserts a new "!" line at the top). */
export function addSimpleKeywords(text: string, keywords: string[]): string {
  const lines = splitLines(text);
  const idx = lines.findIndex(l => /^\s*!/.test(l));
  if (idx < 0) {
    return ['! ' + keywords.join(' '), ...lines].join('\n');
  }
  const hash = lines[idx].indexOf('#');
  if (hash >= 0) {
    lines[idx] = lines[idx].slice(0, hash).trimEnd() + ' ' + keywords.join(' ') + ' ' + lines[idx].slice(hash);
  } else {
    lines[idx] = lines[idx].trimEnd() + ' ' + keywords.join(' ');
  }
  return lines.join('\n');
}

/** Removes simple-input keywords (case-insensitive) from every "!" line. */
export function removeSimpleKeywords(text: string, keywords: string[]): string {
  const drop = new Set(keywords.map(k => k.toLowerCase()));
  return splitLines(text)
    .map(line => {
      if (!/^\s*!/.test(line)) {
        return line;
      }
      const hash = line.indexOf('#');
      const code = hash >= 0 ? line.slice(0, hash) : line;
      const comment = hash >= 0 ? ' ' + line.slice(hash) : '';
      const kept = code.trim().slice(1).trim().split(/\s+/).filter(t => t && !drop.has(t.toLowerCase()));
      return ('! ' + kept.join(' ')).trimEnd() + comment;
    })
    .join('\n');
}
