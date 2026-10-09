// LaTeX document model of the Report tab: parse a .tex into preamble / sections / blocks and
// serialize it back. Pure module (no vscode, no Node), so the webview may import the types.
//
// Ported and generalized from uv-vis/webapp/v_report.py (parse / serialize / roundtrip).
//
// Guarantee: serializeTex(parseTex(text)) === text for ANY input (byte for byte, CRLF too). Every
// piece of text the editor does not model is kept verbatim (leads, trailing blank lines, intro lines
// of a list, the rest of a heading line, ...), and structured blocks rewrite only what changed.
//
// Model:
//   preamble  everything before the first \section / \section* line (with an optional \clearpage
//             or \newpage line right before it belonging to that section). The text between
//             \begin{document} and the first section (\maketitle, abstract, ...) is part of it.
//   sections  each: optional \clearpage line, \section or \section* (kept), optional [short]
//             title, {title} (braces matched, may span lines), the rest of the heading line, then
//             blocks separated by blank lines. Only \section starts a section; \subsection etc.
//             are ordinary text inside blocks.
//   end       '\end{document}' (the last one) and everything after it, verbatim; '' when absent.
//   A document WITHOUT any \section gets one implicit section (heading: false) holding the body
//   after the \begin{document} line (or the whole text when there is no \begin{document}). It
//   serializes without a heading line.
//
// Blocks (split at blank lines; an environment that starts a line runs to its matching \end):
//   items   itemize / enumerate: head line (\begin{itemize}...), optional intro lines before the
//           first \item, items (each: prefix '  \item ' as written + text incl. continuation lines,
//           nested lists stay inside their item), tail line (\end{itemize}...)
//   figure  figure / figure*: path + width of the first \includegraphics, caption, label, and raw
//           (the original LaTeX). Serialization starts from raw and edits only the changed fields.
//   raw     anything else (tables, other environments, paragraphs), as written.
// Every block may carry `lead`, the verbatim text between the previous block (or the heading line)
// and this one. Blocks made by the UI may omit it (default: one blank line before the block).
//
// Line endings: a file that uses CRLF throughout is parsed with '\n' in all fields and eol '\r\n';
// serialization converts back. Mixed files keep their '\r' characters inside the fields.

export type Eol = '\n' | '\r\n';

export interface TexItem {
  /** Verbatim marker before the text, e.g. '  \\item '. Omitted: copied from the previous item. */
  prefix?: string;
  /** Item text; continuation lines after '\n' are kept verbatim. */
  text: string;
}

export interface ItemsBlock {
  type: 'items';
  env: 'itemize' | 'enumerate';
  /** First line, e.g. '\\begin{itemize}\\itemsep2pt'. */
  head: string;
  /** Lines between head and the first \item, each with its '\n' ('' when none). */
  intro?: string;
  items: TexItem[];
  /** Last line, e.g. '\\end{itemize}'. */
  tail: string;
  lead?: string;
}

export interface FigureBlock {
  type: 'figure';
  env: string;
  /** Original LaTeX of the block ('' for a figure made from scratch: then it is generated). */
  raw: string;
  /** File of the first \includegraphics, as written (e.g. 'figures/a.pdf'). */
  path: string | null;
  /** Value of its width= option, e.g. '0.85\\textwidth'. */
  width: string | null;
  /** Content of \caption{...} (LaTeX). */
  caption: string | null;
  label: string | null;
  /** Placement for generated figures (default 'htbp'). Ignored when raw is set. */
  placement?: string;
  lead?: string;
}

export interface RawBlock {
  type: 'raw';
  tex: string;
  lead?: string;
}

export type TexBlock = ItemsBlock | FigureBlock | RawBlock;

export interface TexSection {
  /** false only for the implicit section of a document without \section. */
  heading: boolean;
  /** A \clearpage (or \newpage) line right before the heading. */
  clearpage: boolean;
  /** That line as written (default '\\clearpage\n'). */
  clearpageRaw?: string;
  /** \section* (true) or \section (false). */
  starred: boolean;
  /** Optional short title including the brackets, e.g. '[Intro]'. */
  short?: string;
  title: string;
  /** Rest of the heading line after the closing brace, including its line break (default '\n'). */
  headTail?: string;
  blocks: TexBlock[];
  /** Verbatim text after the last block up to the next section (default '\n'). */
  trailing?: string;
}

export interface TexDoc {
  eol: Eol;
  preamble: string;
  sections: TexSection[];
  end: string;
}

// ------------------------------------------------------------------ helpers

/** Index of the brace that closes the one at s[i] ('{'), or -1. Backslash escapes are skipped. */
export function matchBrace(s: string, i: number): number {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\') { k++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return k;
  }
  return -1;
}

/** The line without its comment (an unescaped % and what follows). */
function stripComment(line: string): string {
  for (let k = 0; k < line.length; k++) {
    if (line[k] === '\\') { k++; continue; }
    if (line[k] === '%') return line.slice(0, k);
  }
  return line;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function count(s: string, re: RegExp): number {
  return (s.match(re) || []).length;
}

const LIST_ENVS = ['itemize', 'enumerate'];
const NESTED_LIST = /\\(begin|end)\{(itemize|enumerate|description)\}/g;
const ITEM = /^(\s*\\item(?![A-Za-z@])\s?)([\s\S]*)$/;

// ------------------------------------------------------------------ blocks

function parseItems(env: string, lines: string[]): ItemsBlock | null {
  const head = lines[0], tail = lines[lines.length - 1];
  if (/\\item(?![A-Za-z@])/.test(stripComment(head))) return null;
  if (!new RegExp(`^\\s*\\\\end\\{${escapeRe(env)}\\}`).test(tail)) return null;
  let intro = '';
  const items: TexItem[] = [];
  let depth = 0;
  for (const line of lines.slice(1, -1)) {
    const m = depth === 0 ? ITEM.exec(line) : null;
    if (m) items.push({ prefix: m[1], text: m[2] });
    else if (items.length) items[items.length - 1].text += '\n' + line;
    else intro += line + '\n';
    for (const n of stripComment(line).matchAll(NESTED_LIST)) depth += n[1] === 'begin' ? 1 : -1;
    if (depth < 0) return null;
  }
  if (depth !== 0) return null;
  const b: ItemsBlock = { type: 'items', env: env as ItemsBlock['env'], head, items, tail };
  if (intro) b.intro = intro;
  return b;
}

const GRAPHIC = /\\includegraphics\s*(\[[^\]]*\])?\s*\{([^}]*)\}/;

interface FigureFields { path: string | null; width: string | null; caption: string | null; label: string | null }

function findCaption(raw: string): { start: number; open: number; close: number } | null {
  const re = /\\caption\*?\s*(\[[^\]]*\])?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(raw, open);
    if (close > 0) return { start: m.index, open, close };
  }
  return null;
}

function figureFields(raw: string): FigureFields {
  const g = GRAPHIC.exec(raw);
  const w = g?.[1] ? /width\s*=\s*([^,\]]*)/.exec(g[1]) : null;
  const cap = findCaption(raw);
  const lab = /\\label\{([^}]*)\}/.exec(raw);
  return {
    path: g ? g[2] : null,
    width: w ? w[1].trim() : null,
    caption: cap ? raw.slice(cap.open + 1, cap.close) : null,
    label: lab ? lab[1] : null
  };
}

function parseFigure(env: string, tex: string): FigureBlock {
  return { type: 'figure', env, raw: tex, ...figureFields(tex) };
}

function blockOf(lines: string[]): TexBlock {
  const tex = lines.join('\n');
  const env = /^\s*\\begin\{([^}]+)\}/.exec(lines[0])?.[1];
  if (env && lines.length >= 2 && LIST_ENVS.includes(env)) {
    const b = parseItems(env, lines);
    if (b) return b;
  }
  if (env === 'figure' || env === 'figure*') {
    if (new RegExp(`\\\\end\\{${escapeRe(env)}\\}`).test(tex)) return parseFigure(env, tex);
  }
  return { type: 'raw', tex };
}

/** Blocks of a section body, plus the verbatim text after the last one. */
export function parseBlocks(body: string): { blocks: TexBlock[]; trailing: string } {
  const lines = body.split('\n');
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) { starts.push(off); off += l.length + 1; }
  const blocks: TexBlock[] = [];
  let prevEnd = 0, i = 0;
  const n = lines.length;
  while (i < n) {
    if (!lines[i].trim()) { i++; continue; }
    const env = /^\s*\\begin\{([^}]+)\}/.exec(lines[i])?.[1];
    let j = i + 1;
    if (env) {
      const begin = new RegExp(`\\\\begin\\{${escapeRe(env)}\\}`, 'g');
      const end = new RegExp(`\\\\end\\{${escapeRe(env)}\\}`, 'g');
      let depth = 0;
      j = n;
      for (let k = i; k < n; k++) {
        const code = stripComment(lines[k]);
        depth += count(code, begin) - count(code, end);
        if (depth <= 0) { j = k + 1; break; }
      }
    } else {
      while (j < n && lines[j].trim() && !/^\s*\\begin\{/.test(lines[j])) j++;
    }
    const b = blockOf(lines.slice(i, j));
    b.lead = body.slice(prevEnd, starts[i]);
    blocks.push(b);
    prevEnd = starts[j - 1] + lines[j - 1].length;
    i = j;
  }
  return { blocks, trailing: body.slice(prevEnd) };
}

// ------------------------------------------------------------------ document

const HEADING = /^(\\(?:clearpage|newpage)[ \t]*\r?\n)?\\section(\*?)(\[[^\]\n]*\])?[ \t]*\{/gm;

function isPureCrlf(text: string): boolean {
  return text.includes('\r\n') && !/(^|[^\r])\n/.test(text);
}

/** Parse a .tex document (never throws; see the header for the model). */
export function parseTex(input: string): TexDoc {
  const eol: Eol = isPureCrlf(input) ? '\r\n' : '\n';
  const text = eol === '\r\n' ? input.replace(/\r\n/g, '\n') : input;

  const endIdx = text.lastIndexOf('\\end{document}');
  const regionEnd = endIdx >= 0 ? endIdx : text.length;
  const end = endIdx >= 0 ? text.slice(endIdx) : '';
  const beginM = /\\begin\{document\}/.exec(text);
  const bodyStart = beginM && beginM.index < regionEnd ? beginM.index + beginM[0].length : 0;

  interface Head { start: number; clearpageRaw?: string; starred: boolean; short?: string; title: string; after: number }
  const heads: Head[] = [];
  HEADING.lastIndex = bodyStart;
  let m: RegExpExecArray | null;
  while ((m = HEADING.exec(text)) && m.index < regionEnd) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(text, open);
    if (close < 0 || close >= regionEnd) continue;
    heads.push({
      start: m.index, clearpageRaw: m[1], starred: m[2] === '*', short: m[3],
      title: text.slice(open + 1, close), after: close + 1
    });
    HEADING.lastIndex = close + 1;
  }

  if (!heads.length) {
    // implicit section: the body after the \begin{document} line
    let start = bodyStart;
    if (beginM && bodyStart > 0) {
      const nl = text.indexOf('\n', bodyStart);
      start = nl >= 0 && nl < regionEnd ? nl + 1 : regionEnd;
    }
    const { blocks, trailing } = parseBlocks(text.slice(start, regionEnd));
    return {
      eol, preamble: text.slice(0, start), end,
      sections: [{ heading: false, clearpage: false, starred: false, title: '', headTail: '', blocks, trailing }]
    };
  }

  const sections: TexSection[] = heads.map((h, k) => {
    const stop = k + 1 < heads.length ? heads[k + 1].start : regionEnd;
    const nl = text.indexOf('\n', h.after);
    const bodyFrom = nl >= 0 && nl < stop ? nl + 1 : stop;
    const { blocks, trailing } = parseBlocks(text.slice(bodyFrom, stop));
    const s: TexSection = {
      heading: true, clearpage: h.clearpageRaw !== undefined, starred: h.starred, title: h.title,
      headTail: text.slice(h.after, bodyFrom), blocks, trailing
    };
    if (h.clearpageRaw !== undefined) s.clearpageRaw = h.clearpageRaw;
    if (h.short !== undefined) s.short = h.short;
    return s;
  });
  return { eol, preamble: text.slice(0, heads[0].start), sections, end };
}

// ------------------------------------------------------------------ serialization

const DEFAULT_ITEM_PREFIX = '  \\item ';

function serializeItems(b: ItemsBlock): string {
  // items may also arrive as plain strings from a UI; a missing prefix copies the previous one
  const list = (b.items || []).map(raw => (typeof raw === 'string' ? { text: raw } as TexItem : raw));
  let prefix = list.find(it => it.prefix !== undefined)?.prefix ?? DEFAULT_ITEM_PREFIX;
  const items = list.map(it => {
    if (it.prefix !== undefined) prefix = it.prefix;
    return prefix + (it.text ?? '');
  });
  return `${b.head}\n${b.intro ?? ''}${items.length ? items.join('\n') + '\n' : ''}${b.tail}`;
}

function setOption(opts: string | undefined, width: string | null): string {
  const inner = opts ? opts.slice(1, -1) : '';
  let parts = inner.split(',').map(p => p);
  const k = parts.findIndex(p => /^\s*width\s*=/.test(p));
  if (width === null || width === '') {
    if (k >= 0) parts.splice(k, 1);
  } else if (k >= 0) {
    parts[k] = parts[k].replace(/(width\s*=\s*)[^,]*?(\s*)$/, `$1${width}$2`);
  } else {
    parts = inner.trim() ? [`width=${width}`, ...parts] : [`width=${width}`];
  }
  const out = parts.join(',');
  return out.trim() ? `[${out}]` : '';
}

/** LaTeX of a figure made from scratch. */
function generateFigure(b: FigureBlock): string {
  const env = b.env || 'figure';
  const lines = [`\\begin{${env}}[${b.placement || 'htbp'}]`, '\\centering'];
  if (b.path) lines.push(`\\includegraphics${setOption(undefined, b.width ?? null)}{${b.path}}`);
  if (b.caption !== null && b.caption !== undefined) lines.push(`\\caption{${b.caption}}`);
  if (b.label) lines.push(`\\label{${b.label}}`);
  lines.push(`\\end{${env}}`);
  return lines.join('\n');
}

/** Insert a new line `line` before the \end{env} line (or before \label for a caption). */
function insertLine(raw: string, line: string, beforeLabel: boolean): string {
  const lab = beforeLabel ? /^[ \t]*\\label\{/m.exec(raw) : null;
  const at = lab ? lab.index : raw.search(/^[ \t]*\\end\{figure\*?\}/m);
  if (at < 0) return raw + '\n' + line;
  return raw.slice(0, at) + line + '\n' + raw.slice(at);
}

/** Remove a command occurrence [start, stop) and its line when nothing else is on it. */
function removeSpan(raw: string, start: number, stop: number): string {
  const ls = raw.lastIndexOf('\n', start - 1) + 1;
  let le = raw.indexOf('\n', stop);
  if (le < 0) le = raw.length;
  if (!raw.slice(ls, start).trim() && !raw.slice(stop, le).trim()) {
    return raw.slice(0, ls) + raw.slice(Math.min(le + 1, raw.length));
  }
  return raw.slice(0, start) + raw.slice(stop);
}

function serializeFigure(b: FigureBlock): string {
  if (!b.raw) return generateFigure(b);
  let raw = b.raw;
  const orig = figureFields(raw);
  const want: FigureFields = {
    path: b.path ?? null, width: b.width ?? null, caption: b.caption ?? null, label: b.label ?? null
  };
  if (want.path !== orig.path || want.width !== orig.width) {
    const g = GRAPHIC.exec(raw);
    if (g) {
      if (want.path === null) {
        raw = removeSpan(raw, g.index, g.index + g[0].length);
      } else {
        const opts = want.width !== orig.width ? setOption(g[1], want.width) : (g[1] ?? '');
        const path = want.path;
        raw = raw.slice(0, g.index) + `\\includegraphics${opts}{${path}}` + raw.slice(g.index + g[0].length);
      }
    } else if (want.path !== null) {
      const line = `\\includegraphics${setOption(undefined, want.width)}{${want.path}}`;
      const cap = findCaption(raw);
      if (cap) {
        const ls = raw.lastIndexOf('\n', cap.start - 1) + 1;
        raw = raw.slice(0, ls) + line + '\n' + raw.slice(ls);
      } else {
        raw = insertLine(raw, line, false);
      }
    }
  }
  if (want.caption !== orig.caption) {
    const cap = findCaption(raw);
    if (cap && want.caption === null) raw = removeSpan(raw, cap.start, cap.close + 1);
    else if (cap) raw = raw.slice(0, cap.open + 1) + want.caption + raw.slice(cap.close);
    else if (want.caption !== null) raw = insertLine(raw, `\\caption{${want.caption}}`, true);
  }
  if (want.label !== orig.label) {
    const lab = /\\label\{([^}]*)\}/.exec(raw);
    if (lab && !want.label) raw = removeSpan(raw, lab.index, lab.index + lab[0].length);
    else if (lab) raw = raw.slice(0, lab.index) + `\\label{${want.label}}` + raw.slice(lab.index + lab[0].length);
    else if (want.label) raw = insertLine(raw, `\\label{${want.label}}`, false);
  }
  return raw;
}

/** LaTeX of one block (without its lead). */
export function serializeBlock(b: TexBlock): string {
  if (b.type === 'items') return serializeItems(b);
  if (b.type === 'figure') return serializeFigure(b);
  return b.tex ?? '';
}

function serializeSection(s: TexSection): string {
  let out = '';
  if (s.heading !== false) {
    if (s.clearpage) out += s.clearpageRaw ?? '\\clearpage\n';
    out += `\\section${s.starred ? '*' : ''}${s.short ?? ''}{${s.title ?? ''}}${s.headTail ?? '\n'}`;
  }
  (s.blocks || []).forEach((b, k) => {
    out += (b.lead ?? (k === 0 && s.heading !== false ? '\n' : '\n\n')) + serializeBlock(b);
  });
  out += s.trailing ?? '\n';
  return out;
}

/** The document as text (see the roundtrip guarantee in the header). */
export function serializeTex(doc: TexDoc): string {
  const text = (doc.preamble ?? '') + (doc.sections || []).map(serializeSection).join('') + (doc.end ?? '');
  return doc.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

/** True when parse + serialize gives the text back unchanged. */
export function roundtrip(text: string): boolean {
  return serializeTex(parseTex(text)) === text;
}

// ------------------------------------------------------------------ building blocks

/** Escape plain text for LaTeX (for captions typed as plain text). */
export function escapeLatex(text: string): string {
  return text.replace(/[\\{}$&#^_%~]/g, ch => ({
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&', '#': '\\#',
    '^': '\\^{}', '_': '\\_', '%': '\\%', '~': '\\~{}'
  } as Record<string, string>)[ch]);
}

/**
 * New figure block for "Send to report":
 *   \begin{figure}[htbp]
 *   \centering
 *   \includegraphics[width=0.85\textwidth]{figures/name.pdf}
 *   \caption{...}
 *   \label{fig:...}
 *   \end{figure}
 * caption is LaTeX (use escapeLatex for plain text); null omits it, as an empty label does.
 */
export function figureBlock(path: string, caption: string | null = '', label = '', width = '0.85\\textwidth',
  placement = 'htbp'): FigureBlock {
  const b: FigureBlock = { type: 'figure', env: 'figure', raw: '', path, width: width || null, caption, label: label || null, placement };
  b.raw = generateFigure(b);
  return b;
}

/**
 * Insert a block into section `sectionIndex` at `position` (default: the end), separated by a blank
 * line. Mutates and returns doc. Throws RangeError for a bad index.
 */
export function insertFigure(doc: TexDoc, sectionIndex: number, block: TexBlock, position?: number): TexDoc {
  const s = doc.sections[sectionIndex];
  if (!s || !Number.isInteger(sectionIndex)) throw new RangeError(`no section ${sectionIndex}`);
  const at = position === undefined ? s.blocks.length : position;
  if (!Number.isInteger(at) || at < 0 || at > s.blocks.length) throw new RangeError(`bad position ${position}`);
  const b = { ...block };
  if (b.lead === undefined) {
    if (at === 0 && s.blocks.length) {
      b.lead = s.blocks[0].lead ?? '\n';   // take the place of the old first block ...
      s.blocks[0].lead = '\n\n';            // ... which now follows after a blank line
    } else {
      b.lead = at === 0 && s.heading !== false ? '\n' : '\n\n';
    }
  }
  s.blocks.splice(at, 0, b);
  if (at === s.blocks.length - 1 && s.trailing !== undefined && !s.trailing.startsWith('\n')) {
    s.trailing = '\n' + s.trailing;   // the block must end its line before e.g. \end{document}
  }
  return doc;
}
