// LaTeX <-> HTML for one list item or caption in the Word-like editor
// (ported from uv-vis/webapp/report_editor.js). Only \textbf, \textit,
// \emph and \texttt become formatting; math ($...$) is shown as code-like
// spans and kept verbatim; every other command stays as text. A field is
// converted back only when the user edits it, so untouched text is never
// rewritten.

const WRAP: Record<string, 'b' | 'i' | 'code'> = { '\\textbf{': 'b', '\\textit{': 'i', '\\emph{': 'i', '\\texttt{': 'code' };

export function matchBrace(s: string, i: number): number {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] === '{') depth++;
    else if (s[k] === '}' && --depth === 0) return k;
  }
  return -1;
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plainHtml(t: string): string {
  return escHtml(t).replace(/\$[^$]*\$/g, m => `<span class="m">${m}</span>`);
}

export function texToHtml(tex: string): string {
  tex = tex.replace(/\s*\n\s*/g, ' ');
  let out = '';
  let plain = '';
  let i = 0;
  const flush = () => { out += plainHtml(plain); plain = ''; };
  while (i < tex.length) {
    const cmd = Object.keys(WRAP).find(c => tex.startsWith(c, i));
    const end = cmd ? matchBrace(tex, i + cmd.length - 1) : -1;
    if (cmd && end > 0) {
      const inner = tex.slice(i + cmd.length, end);
      flush();
      if (WRAP[cmd] === 'code') {
        out += /\\(?![_%&#])/.test(inner) ? plainHtml(tex.slice(i, end + 1)) : '<code>' + escHtml(inner.replace(/\\([_%&#])/g, '$1')) + '</code>';
      } else {
        out += `<${WRAP[cmd]}>${texToHtml(inner)}</${WRAP[cmd]}>`;
      }
      i = end + 1;
    } else {
      plain += tex[i++];
    }
  }
  flush();
  return out;
}

/** Typed _ % & # become valid LaTeX outside math, unless already escaped. */
export function escapePlain(t: string): string {
  let math = false;
  let out = '';
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    const prev = k ? t[k - 1] : '';
    if (c === '$' && prev !== '\\') math = !math;
    out += !math && '_%&#'.includes(c) && prev !== '\\' ? '\\' + c : c;
  }
  return out;
}

function nodeToTex(n: Node, inMath = false): string {
  if (n.nodeType === Node.TEXT_NODE) {
    const t = (n.nodeValue ?? '').replace(/ /g, ' ');
    return inMath ? t : escapePlain(t);
  }
  if (!(n instanceof HTMLElement)) return '';
  const kids = () => [...n.childNodes].map(c => nodeToTex(c, inMath || n.classList.contains('m'))).join('');
  const tag = n.tagName;
  const style = n.getAttribute('style') || '';
  if (tag === 'CODE') return n.textContent ? '\\texttt{' + n.textContent.replace(/([_%&#])/g, '\\$1') + '}' : '';
  if (tag === 'B' || tag === 'STRONG' || /font-weight:\s*(bold|[6-9]00)/.test(style)) { const k = kids(); return k && `\\textbf{${k}}`; }
  if (tag === 'I' || tag === 'EM' || /font-style:\s*italic/.test(style)) { const k = kids(); return k && `\\textit{${k}}`; }
  if (tag === 'BR') return ' ';
  if (tag === 'DIV' || tag === 'P') return ' ' + kids();
  return kids();
}

export function htmlToTex(root: Node): string {
  return nodeToTex(root).replace(/\s+/g, ' ').trim();
}

/**
 * Whether the text can be edited as rich text without losing structure: no nested environments,
 * no comments, no explicit line breaks.
 */
export function richEditable(tex: string): boolean {
  if (/\\begin\{|\\\\|\\item(?![A-Za-z])/.test(tex)) return false;
  for (let k = 0; k < tex.length; k++) {
    if (tex[k] === '\\') { k++; continue; }
    if (tex[k] === '%') return false;
  }
  return true;
}
