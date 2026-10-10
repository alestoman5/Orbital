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

// --- display of short LaTeX (section titles) ---------------------------------------------

const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', pm: '±', cdot: '·', approx: '≈', sim: '∼', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', to: '→', rightarrow: '→',
  infty: '∞', circ: '°', degree: '°', AA: 'Å', ldots: '…', dots: '…', quad: '\u2003', qquad: '\u2003\u2003'
};
const SPACES: Record<string, string> = { ',': '\u202f', ';': '\u2005', ':': '\u2005', '!': '', ' ': ' ' };
const WRAPPERS: Record<string, string> = {
  textbf: 'b', mathbf: 'b', textit: 'i', emph: 'i', mathit: 'i', texttt: 'code',
  text: '', textrm: '', textsf: '', mathrm: '', mbox: '', ensuremath: ''
};

/** One argument at i: a {group}, a control sequence or a single character; returns [source, next index]. */
function texArg(s: string, i: number): [string, number] {
  if (s[i] === '{') {
    const end = matchBrace(s, i);
    if (end > 0) return [s.slice(i + 1, end), end + 1];
  }
  const m = s[i] === '\\' ? /^\\([A-Za-z]+|.)/.exec(s.slice(i)) : null;
  return m ? [m[0], i + m[0].length] : [s[i] ?? '', i + 1];
}

function inlineTex(s: string, math: boolean): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
      if (!m) { out += '\\'; i++; continue; }
      const name = m[1];
      i += m[0].length;
      if (name in SPACES) out += SPACES[name];
      else if (name in WRAPPERS) {
        const [inner, next] = texArg(s, i);
        i = next;
        const tag = WRAPPERS[name];
        const body = inlineTex(inner, math && !name.startsWith('text') && name !== 'mbox');
        out += tag ? `<${tag}>${body}</${tag}>` : body;
      } else if (SYMBOLS[name]) out += SYMBOLS[name];
      else if (name.length === 1 && !/[A-Za-z]/.test(name)) out += escHtml(name); // \% \& \_ \$ \{ \}
      else out += escHtml(m[0]); // unknown command: keep the source
      if (/^[A-Za-z]+$/.test(name) && s[i] === ' ' && !(name in WRAPPERS)) i++; // the space ending a control word
      continue;
    }
    if (math && (c === '^' || c === '_')) {
      const [inner, next] = texArg(s, i + 1);
      i = next;
      const tag = c === '^' ? 'sup' : 'sub';
      out += `<${tag}>${inlineTex(inner, true)}</${tag}>`;
      continue;
    }
    if (!math && c === '$') {
      const end = s.indexOf('$', i + 1);
      if (end > i) {
        out += `<span class="rp-math">${inlineTex(s.slice(i + 1, end), true)}</span>`;
        i = end + 1;
        continue;
      }
    }
    if (!math && s.startsWith('---', i)) { out += '—'; i += 3; continue; }
    if (!math && s.startsWith('--', i)) { out += '–'; i += 2; continue; }
    if (c === '~') { out += '\u00a0'; i++; continue; }
    if (c === '{' || c === '}') { i++; continue; }
    if (math && c === ' ') { i++; continue; }
    if (math && c === '-') { out += '−'; i++; continue; }
    if (math && c === '=') { out += ' = '; i++; continue; }
    out += escHtml(c);
    i++;
  }
  return out;
}

/**
 * Display HTML of a short LaTeX text such as a section title: thin spaces (\,), ~, -- and ---,
 * escaped characters and simple inline math ($n = 100\,000$, CH$_2$OO, $\lambda_{max}$).
 * Unknown commands stay as source; editing still uses the LaTeX source.
 */
export function prettyTex(tex: string): string {
  return inlineTex(tex.replace(/\s*\n\s*/g, ' '), false);
}
