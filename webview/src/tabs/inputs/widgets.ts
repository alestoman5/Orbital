// Small widgets of the Input Builder that the shared UI kit does not have:
// a searchable grouped combobox, a pill group, and a syntax-colored code view
// with line numbers. Built with h() and styled in inputs.css.

import { h, mount } from '../../ui/dom';
import { icon, iconButton } from '../../ui/components';
import { tokenizeOrca, tokenizePython, Token } from '../../../../src/inputs/highlight';

// --- combobox ---------------------------------------------------------------

export interface ComboItem {
  value: string;
  label?: string;
  /** Muted text on the right (e.g. "PySCF ✓", "ε 78.4"). */
  hint?: string;
  group?: string;
}

export interface ComboOptions {
  value: string;
  items: ComboItem[];
  onChange: (v: string) => void;
  placeholder?: string;
  /** Accept text that is not in the list (Enter / blur). Default true. */
  free?: boolean;
}

/** Text input with a filtered, grouped dropdown; arrow keys + Enter pick, Escape closes. */
export function combo(o: ComboOptions): HTMLElement {
  const free = o.free !== false;
  let current = o.value;
  let active = -1;
  let shown: ComboItem[] = [];
  const input = h('input.input.mono.combo-input', { type: 'text', value: current, placeholder: o.placeholder, spellcheck: 'false', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false' });
  const list = h('div.combo-list', { role: 'listbox', hidden: true });
  const wrap = h('div.combo', null, input, h('span.combo-caret', null, icon('chevronDown')), list);

  const commit = (v: string) => {
    close();
    input.value = v;
    const changed = v !== current;
    current = v;
    if (document.activeElement === input) {
      input.blur(); // before onChange: a form rebuild must not refocus (and reopen) this input
    }
    if (changed) {
      o.onChange(v);
    }
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const render = (filter: string) => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (i: ComboItem) => {
      const t = `${i.value} ${i.label ?? ''} ${i.group ?? ''}`.toLowerCase();
      return words.every(w => t.includes(w));
    };
    shown = o.items.filter(match);
    const nodes: Node[] = [];
    let group: string | undefined;
    shown.forEach((it, k) => {
      if (it.group && it.group !== group) {
        group = it.group;
        nodes.push(h('div.combo-group', null, it.group));
      }
      nodes.push(h('div.combo-item', {
        role: 'option', class: [k === active ? 'active' : '', it.value === current ? 'selected' : ''].join(' '),
        onmousedown: (e: Event) => { e.preventDefault(); commit(it.value); }
      }, h('span.combo-label', null, it.label ?? it.value), it.hint ? h('span.combo-hint', null, it.hint) : null));
    });
    if (nodes.length === 0) {
      nodes.push(h('div.combo-empty', null, free ? 'Not in the list: Enter keeps your text' : 'No match'));
    }
    mount(list, nodes);
    list.querySelector('.combo-item.active')?.scrollIntoView({ block: 'nearest' });
  };
  const open = (filter = '') => {
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    render(filter);
  };
  input.addEventListener('focus', () => { input.select(); open(); });
  input.addEventListener('input', () => { active = -1; open(input.value); });
  input.addEventListener('blur', () => {
    close();
    if (free && input.value.trim() && input.value.trim() !== current) {
      commit(input.value.trim());
    } else {
      input.value = current;
    }
  });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) {
        open(input.value);
      }
      const n = shown.length;
      if (n > 0) {
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        render(input.value === current ? '' : input.value);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && shown[active]) {
        commit(shown[active].value);
      } else if (free && input.value.trim()) {
        commit(input.value.trim());
      } else if (shown.length === 1) {
        commit(shown[0].value);
      } else {
        input.blur();
      }
    } else if (e.key === 'Escape') {
      input.value = current;
      close();
      input.blur();
    }
  });
  return wrap;
}

// --- pills ------------------------------------------------------------------

export interface Pill<T extends string> {
  value: T;
  label: string;
  title?: string;
}

/** Wrapping group of pill buttons (radio); for 4–8 options where a segmented control gets cramped. */
export function pills<T extends string>(items: Pill<T>[], value: T, onChange: (v: T) => void): HTMLElement {
  const el = h('div.pills', { role: 'radiogroup' });
  const render = (cur: T) => mount(el, items.map(i => h('button.pill', {
    type: 'button', role: 'radio', 'aria-checked': String(i.value === cur), class: i.value === cur ? 'on' : '', title: i.title,
    onclick: () => { render(i.value); onChange(i.value); }
  }, i.label)));
  render(value);
  return el;
}

// --- code view --------------------------------------------------------------

export type CodeLanguage = 'orca' | 'python' | 'shell' | 'plain';

const SH_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function', 'export', 'set', 'cd', 'return', 'exit', 'local']);

function shellTokens(text: string): Token[] {
  const out: Token[] = [];
  const add = (t: string, kind: Token['kind']) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind && kind === 'text') {
      last.text += t;
    } else {
      out.push({ text: t, kind });
    }
  };
  for (const line of text.split(/(\n)/)) {
    if (line === '\n') {
      out.push({ text: line, kind: 'whitespace' });
    } else if (/^\s*#/.test(line)) {
      out.push({ text: line, kind: /^#SBATCH/.test(line) ? 'keyword' : 'comment' });
    } else {
      const re = /("[^"]*"?|'[^']*'?)|(\$\{[^}]*\}|\$\w+|\$\()|([A-Za-z_][\w-]*)|(\s+)|(.)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        add(m[0], m[1] ? 'string' : m[2] ? 'option' : m[3] && SH_KEYWORDS.has(m[3]) ? 'keyword' : 'text');
      }
    }
  }
  return out;
}

export function tokensFor(text: string, lang: CodeLanguage): Token[] {
  switch (lang) {
    case 'orca': return tokenizeOrca(text);
    case 'python': return tokenizePython(text);
    case 'shell': return shellTokens(text);
    default: return [{ text, kind: 'text' }];
  }
}

/** Splits tokens at newlines into rows of tokens. */
export function tokenLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const t of tokens) {
    const parts = t.text.split(/\r\n|\r|\n/);
    parts.forEach((p, k) => {
      if (k > 0) {
        lines.push([]);
      }
      if (p) {
        lines[lines.length - 1].push({ text: p, kind: t.kind });
      }
    });
  }
  if (lines.length > 1 && lines[lines.length - 1].length === 0) {
    lines.pop(); // trailing newline
  }
  return lines;
}

/** Syntax-colored, line-numbered code with a copy button. Line numbers are not part of the selection. */
export function codeView(text: string, lang: CodeLanguage, opts: { maxHeight?: string; copy?: boolean; dim?: boolean } = {}): HTMLElement {
  const lines = tokenLines(tokensFor(text, lang));
  const width = String(lines.length).length;
  const body = h('div.cv-body', { style: { maxHeight: opts.maxHeight ?? '' } },
    h('div.cv-gutter', { 'aria-hidden': 'true', style: { minWidth: `${width + 2}ch` } }, lines.map((_, i) => h('div', null, String(i + 1)))),
    h('pre.cv-code', null, lines.map(l => h('div.cv-line', null, l.length ? l.map(t => (t.kind === 'whitespace' || t.kind === 'text' ? t.text : h('span', { class: `tk-${t.kind}` }, t.text))) : '​'))));
  return h('div.cv', { class: opts.dim ? 'dim' : '' }, body,
    opts.copy === false ? null : iconButton('copy', 'Copy', () => void navigator.clipboard.writeText(text)));
}
