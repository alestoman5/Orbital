// Rich labels: "σ / cm^{2} molecule^{−1}" -> runs at baseline levels, text
// measurement (Arimo/Arial advance widths, no DOM needed) and SVG markup with
// <tspan> super/subscripts. DOM-free so it can be unit-tested in Node.

import { METRIC_CHARS, WIDTHS_BOLD, WIDTHS_REGULAR } from './metrics';

/** Combining accent -> spacing accent of the same shape. */
const SPACING_ACCENT: Record<number, number> = { 0x300: 0x60, 0x301: 0xb4, 0x302: 0x2c6, 0x303: 0x2dc, 0x304: 0xaf, 0x308: 0xa8 };
const EXTRA_WIDTHS: Record<number, number> = { 0x2c6: 333, 0x2dc: 333 };

/** A piece of text at one baseline level: 0 normal, +1 superscript, −1 subscript (nested: ±2…). */
export interface Run {
  text: string;
  level: number;
}

/** Size factor and baseline shift (in em of the base size) per nesting step. */
export const SCRIPT_SCALE = 0.7;
const SUP_SHIFT = 0.36;
const SUB_SHIFT = 0.17;

const SUP_CHARS: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '−', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i' };
const SUB_CHARS: Record<string, string> = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '−', '₌': '=', '₍': '(', '₎': ')' };

/**
 * Parses ^{…} and _{…} (nestable) plus Unicode super/subscript characters
 * (cm⁻¹ -> cm + sup "−1", since most fonts lack those glyphs). A hyphen
 * before a digit inside a script becomes a real minus (U+2212). A lone ^ or _
 * without braces stays literal (file names keep their underscores).
 */
export function parseRich(input: string): Run[] {
  const runs: Run[] = [];
  const stack: number[] = [0];
  let buf = '';
  let level = 0;
  const flush = () => {
    if (buf) {
      const last = runs[runs.length - 1];
      if (last && last.level === level) {
        last.text += buf;
      } else {
        runs.push({ text: buf, level });
      }
      buf = '';
    }
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if ((c === '^' || c === '_') && input[i + 1] === '{') {
      flush();
      level += c === '^' ? 1 : -1;
      stack.push(level);
      i++;
      continue;
    }
    if (c === '}' && stack.length > 1) {
      flush();
      stack.pop();
      level = stack[stack.length - 1];
      continue;
    }
    const sup = SUP_CHARS[c];
    const sub = SUB_CHARS[c];
    if (sup !== undefined || sub !== undefined) {
      flush();
      const saved = level;
      level = saved + (sup !== undefined ? 1 : -1);
      buf = sup ?? sub!;
      // absorb following characters of the same kind
      while (i + 1 < input.length && (sup !== undefined ? SUP_CHARS[input[i + 1]] : SUB_CHARS[input[i + 1]]) !== undefined) {
        i++;
        buf += sup !== undefined ? SUP_CHARS[input[i]] : SUB_CHARS[input[i]];
      }
      flush();
      level = saved;
      continue;
    }
    if (c === '-' && level !== 0 && /[0-9.]/.test(input[i + 1] ?? '')) {
      buf += '−';
      continue;
    }
    buf += c;
  }
  flush();
  return runs;
}

/** Plain-text rendering of a rich label (CSV headers, tooltips): scripts as Unicode where possible. */
export function plainText(input: string): string {
  const toSup: Record<string, string> = {};
  const toSub: Record<string, string> = {};
  for (const [k, v] of Object.entries(SUP_CHARS)) { toSup[v] = k; }
  for (const [k, v] of Object.entries(SUB_CHARS)) { toSub[v] = k; }
  toSup['-'] = '⁻';
  return parseRich(input).map(r => {
    if (r.level === 0) {
      return r.text;
    }
    const map = r.level > 0 ? toSup : toSub;
    const chars = [...r.text];
    return chars.every(ch => map[ch]) ? chars.map(ch => map[ch]).join('') : `${r.level > 0 ? '^' : '_'}(${r.text})`;
  }).join('');
}

// --- measurement ---------------------------------------------------------------

/** Width of a plain string in user units at `size` (same units). */
export type Measure = (text: string, size: number, bold?: boolean) => number;

const REG = new Map<number, number>();
const BOLD = new Map<number, number>();
{
  let i = 0;
  for (const ch of METRIC_CHARS) {
    const cp = ch.codePointAt(0)!;
    REG.set(cp, WIDTHS_REGULAR[i]);
    BOLD.set(cp, WIDTHS_BOLD[i]);
    i++;
  }
}

export function isCombiningMark(cp: number): boolean {
  return (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x20d0 && cp <= 0x20ff);
}

/** Advance width of one code point in 1/1000 em (Arimo = Arial metrics). */
export function advance(cp: number, bold = false): number {
  if (isCombiningMark(cp)) {
    return 0;
  }
  return (bold ? BOLD : REG).get(cp) ?? EXTRA_WIDTHS[cp] ?? (cp > 0x2e80 ? 1000 : 556);
}

/** Text width with Arimo/Arial/Helvetica metrics (no kerning). */
export const arimoMeasure: Measure = (text, size, bold = false) => {
  let w = 0;
  for (const ch of text) {
    w += advance(ch.codePointAt(0)!, bold);
  }
  return (w * size) / 1000;
};

export function scriptSize(base: number, level: number): number {
  return base * Math.pow(SCRIPT_SCALE, Math.abs(level));
}

/** Width of a rich label. */
export function richWidth(runs: Run[], size: number, measure: Measure, bold = false): number {
  let w = 0;
  for (const r of runs) {
    w += measure(r.text, scriptSize(size, r.level), bold);
  }
  return w;
}

/** Baseline offset (positive = up) of a level, in user units. */
export function levelShift(base: number, level: number): number {
  let shift = 0;
  for (let l = 1; l <= Math.abs(level); l++) {
    const parent = scriptSize(base, l - 1);
    shift += (level > 0 ? SUP_SHIFT : -SUB_SHIFT) * parent;
  }
  return shift;
}

/** Vertical extent of a rich label relative to its baseline: ascent above, descent below (user units). */
export function richExtent(runs: Run[], size: number): { ascent: number; descent: number } {
  let ascent = 0.72 * size;
  let descent = 0.21 * size;
  for (const r of runs) {
    const s = scriptSize(size, r.level);
    const shift = levelShift(size, r.level);
    ascent = Math.max(ascent, shift + 0.72 * s);
    descent = Math.max(descent, -shift + 0.21 * s);
  }
  return { ascent, descent };
}

// --- SVG markup -------------------------------------------------------------------

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

const r2 = (v: number) => String(Math.round(v * 100) / 100);

export interface RichSvgOptions {
  size: number;
  bold?: boolean;
  /**
   * Draw combining accents (ν̃) as spacing accents positioned with Arial/Arimo
   * metrics instead of relying on the font's mark positioning: PDF text has no
   * GPOS, and Arial and Arimo place combining marks differently, so this keeps
   * screen, PNG, SVG and PDF identical. Only valid for Arial/Arimo text.
   */
  explicitMarks?: boolean;
  /** Split runs by font (PDF export: one jsPDF font per Unicode subset). */
  fontFor?: (cp: number) => string;
}

interface Piece {
  text: string;
  level: number;
  dx?: number;
  family?: string;
}

function splitPieces(runs: Run[], o: RichSvgOptions): Piece[] {
  const pieces: Piece[] = [];
  for (const r of runs) {
    const size = scriptSize(o.size, r.level);
    const chars = [...r.text];
    let cur: Piece | undefined;
    let pendingDx = 0;
    for (let i = 0; i < chars.length; i++) {
      const cp = chars[i].codePointAt(0)!;
      const family = o.fontFor?.(cp);
      const spacing = o.explicitMarks && i > 0 ? SPACING_ACCENT[cp] : undefined;
      if (spacing !== undefined) {
        // ν̃ -> ν + spacing tilde centred over it: spacing accents are centred in
        // their advance in Arial and Arimo alike, combining marks are not.
        const base = advance(chars[i - 1].codePointAt(0)!, o.bold);
        const acc = advance(spacing, o.bold);
        const dx = (-(base + acc) / 2) * size / 1000;
        pieces.push({ text: String.fromCodePoint(spacing), level: r.level, dx: dx + pendingDx, family: o.fontFor?.(spacing) });
        pendingDx = ((base - acc) / 2) * size / 1000;
        cur = undefined;
        continue;
      }
      if (!cur || cur.family !== family || pendingDx !== 0) {
        cur = { text: '', level: r.level, family, dx: pendingDx || undefined };
        pendingDx = 0;
        pieces.push(cur);
      }
      cur.text += chars[i];
    }
  }
  return pieces;
}

/**
 * Inner markup of a <text> element for a rich label. Scripts become
 * <tspan dy=… font-size=…> (numeric dy: portable to Illustrator, Inkscape and
 * svg2pdf, unlike baseline-shift).
 */
export function richSvg(runs: Run[], o: RichSvgOptions): string {
  const pieces = splitPieces(runs, o);
  let out = '';
  let offset = 0; // current baseline shift (up = positive)
  for (const p of pieces) {
    const shift = levelShift(o.size, p.level);
    const dy = offset - shift; // SVG dy: down = positive
    offset = shift;
    const attrs: string[] = [];
    if (p.dx) {
      attrs.push(`dx="${r2(p.dx)}"`);
    }
    if (Math.abs(dy) > 1e-6) {
      attrs.push(`dy="${r2(dy)}"`);
    }
    if (p.level !== 0) {
      attrs.push(`font-size="${r2(scriptSize(o.size, p.level))}"`);
    }
    if (p.family) {
      attrs.push(`font-family="${p.family}"`);
    }
    const text = escapeXml(p.text);
    out += attrs.length ? `<tspan ${attrs.join(' ')}>${text}</tspan>` : text;
  }
  return out;
}

/** Whitespace-safe check: is the label empty after parsing? */
export function isBlank(s: string | undefined): boolean {
  return !s || !s.trim();
}

/**
 * Greedy line breaking of a rich label at spaces of normal-level text so no
 * line is wider than maxWidth (a single word may still be wider).
 */
export function wrapRuns(runs: Run[], size: number, measure: Measure, maxWidth: number): Run[][] {
  if (richWidth(runs, size, measure) <= maxWidth) {
    return [runs];
  }
  // words: sequences of runs separated by spaces in level-0 text
  const words: Run[][] = [[]];
  for (const r of runs) {
    if (r.level !== 0) {
      words[words.length - 1].push(r);
      continue;
    }
    const parts = r.text.split(' ');
    parts.forEach((p, i) => {
      if (i > 0) {
        words.push([]);
      }
      if (p) {
        words[words.length - 1].push({ text: p, level: 0 });
      }
    });
  }
  const join = (ws: Run[][]): Run[] => {
    const out: Run[] = [];
    ws.forEach((w, i) => {
      const seq = i > 0 ? [{ text: ' ', level: 0 }, ...w] : w;
      for (const r of seq) {
        const last = out[out.length - 1];
        if (last && last.level === r.level) {
          last.text += r.text;
        } else {
          out.push({ ...r });
        }
      }
    });
    return out;
  };
  const lines: Run[][][] = [[]];
  for (const w of words.filter(x => x.length)) {
    const cur = lines[lines.length - 1];
    if (cur.length && richWidth(join([...cur, w]), size, measure) > maxWidth) {
      lines.push([w]);
    } else {
      cur.push(w);
    }
  }
  return lines.map(join);
}
