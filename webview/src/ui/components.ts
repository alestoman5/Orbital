// Shared UI components of Orbital Studio. Every tab builds its UI from these
// so the studio looks like one product; styles live in styles/components.css.

import { Child, h, mount, svg } from './dom';
import { ICONS, IconName } from './icons';

export function icon(name: IconName, className = 'icon'): SVGSVGElement {
  return svg(ICONS[name], className);
}

// --- layout -----------------------------------------------------------------

/** Two-column layout: fixed-width controls on the left, content on the right; stacks on narrow panels. */
export function split(sidebar: Child, main: Child, opts: { sidebarWidth?: number } = {}): HTMLElement {
  return h('div.split', { style: { gridTemplateColumns: `minmax(260px, ${opts.sidebarWidth ?? 340}px) minmax(0, 1fr)` } },
    h('aside.split-side', null, sidebar),
    h('section.split-main', null, main)
  );
}

export function card(opts: { title?: string; subtitle?: string; actions?: Child[]; class?: string; flush?: boolean }, ...body: Child[]): HTMLElement {
  const head = opts.title || opts.actions?.length
    ? h('div.card-head', null,
        h('div', null, opts.title ? h('h2', null, opts.title) : null, opts.subtitle ? h('p.muted', null, opts.subtitle) : null),
        h('div.card-actions', null, opts.actions ?? []))
    : null;
  return h('div.card', { class: [opts.class, opts.flush ? 'flush' : ''].filter(Boolean).join(' ') }, head, h('div.card-body', null, body));
}

export function grid(minColumnPx: number, ...items: Child[]): HTMLElement {
  return h('div.grid', { style: { gridTemplateColumns: `repeat(auto-fill, minmax(${minColumnPx}px, 1fr))` } }, items);
}

export function row(...items: Child[]): HTMLElement {
  return h('div.row', null, items);
}

export function stack(...items: Child[]): HTMLElement {
  return h('div.stack', null, items);
}

/** Collapsible section for the sidebar. */
export function section(title: string, open: boolean, ...body: Child[]): HTMLDetailsElement {
  return h('details.section', { open }, h('summary', null, icon('chevronRight', 'icon chevron'), title), h('div.section-body', null, body));
}

// --- data display -----------------------------------------------------------

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted' | 'accent';

/** Headline number: label, value, unit, optional hint underneath. */
export function kpi(label: string, value: string, unit?: string, hint?: string, tone?: Tone): HTMLElement {
  return h('div.kpi', { class: tone ? `tone-${tone}` : '' },
    h('div.kpi-label', null, label),
    h('div.kpi-value', null, value, unit ? h('span.kpi-unit', null, unit) : null),
    hint ? h('div.kpi-hint', null, hint) : null
  );
}

export function badge(text: string, tone: Tone = 'muted'): HTMLElement {
  return h('span.badge', { class: `tone-${tone}` }, text);
}

/** Horizontal stacked bar, e.g. ok / failed / running counts of a geometry set. */
export function stackedBar(segments: { value: number; tone: Tone; label: string }[]): HTMLElement {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  return h('div.stacked-bar', { role: 'img', 'aria-label': segments.map(s => `${s.label}: ${s.value}`).join(', ') },
    segments.filter(s => s.value > 0).map(s =>
      h('span', { class: `tone-${s.tone}`, style: { width: `${(100 * s.value) / total}%` }, title: `${s.label}: ${s.value}` })));
}

export function emptyState(iconName: IconName, title: string, text: string, action?: Child): HTMLElement {
  return h('div.empty', null, icon(iconName, 'icon empty-icon'), h('h3', null, title), h('p.muted', null, text), action ?? null);
}

export function skeleton(lines = 3): HTMLElement {
  return h('div.skeleton', null, Array.from({ length: lines }, (_, i) => h('span', { style: { width: `${90 - i * 17}%` } })));
}

export function callout(tone: Tone, ...body: Child[]): HTMLElement {
  const name: IconName = tone === 'bad' ? 'error' : tone === 'warn' ? 'warning' : tone === 'ok' ? 'check' : 'info';
  return h('div.callout', { class: `tone-${tone}` }, icon(name), h('div', null, body));
}

/** Monospace block with a copy button. */
export function codeBlock(text: string, opts: { maxHeight?: number } = {}): HTMLElement {
  const pre = h('pre.code', { style: opts.maxHeight ? { maxHeight: `${opts.maxHeight}px` } : undefined }, text);
  return h('div.code-wrap', null, pre,
    iconButton('copy', 'Copy', () => void navigator.clipboard.writeText(pre.textContent ?? '')));
}

// --- controls ---------------------------------------------------------------

export function button(label: string, onClick: (e: MouseEvent) => void, opts: { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; icon?: IconName; disabled?: boolean; title?: string } = {}): HTMLButtonElement {
  return h('button.btn', { class: opts.variant ?? 'secondary', onclick: onClick, disabled: opts.disabled, title: opts.title, type: 'button' },
    opts.icon ? icon(opts.icon) : null, label);
}

export function iconButton(name: IconName, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  return h('button.icon-btn', { title, 'aria-label': title, onclick: onClick, type: 'button' }, icon(name));
}

/** Label + control + optional hint, stacked. */
export function field(label: string, control: Child, hint?: string): HTMLElement {
  return h('label.field', null, h('span.field-label', null, label), control, hint ? h('span.field-hint', null, hint) : null);
}

export function textInput(value: string, onInput: (v: string) => void, opts: { placeholder?: string; mono?: boolean; type?: string } = {}): HTMLInputElement {
  return h('input.input', { class: opts.mono ? 'mono' : '', type: opts.type ?? 'text', value, placeholder: opts.placeholder, oninput: (e: Event) => onInput((e.target as HTMLInputElement).value) });
}

export function numberInput(value: number, onChange: (v: number) => void, opts: { min?: number; max?: number; step?: number } = {}): HTMLInputElement {
  return h('input.input.num', {
    type: 'number', value: String(value), min: opts.min, max: opts.max, step: opts.step ?? 'any',
    onchange: (e: Event) => {
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) {
        onChange(v);
      }
    }
  });
}

export function textArea(value: string, onInput: (v: string) => void, opts: { rows?: number; placeholder?: string; mono?: boolean } = {}): HTMLTextAreaElement {
  return h('textarea.input', { class: opts.mono ?? true ? 'mono' : '', rows: opts.rows ?? 6, placeholder: opts.placeholder, value, spellcheck: 'false', oninput: (e: Event) => onInput((e.target as HTMLTextAreaElement).value) });
}

export interface Option<T extends string = string> {
  value: T;
  label: string;
  group?: string;
}

export function select<T extends string>(options: Option<T>[], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const el = h('select.input', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) });
  const groups = new Map<string, HTMLElement>();
  for (const o of options) {
    const opt = h('option', { value: o.value, selected: o.value === value }, o.label);
    if (o.group) {
      let g = groups.get(o.group);
      if (!g) {
        g = h('optgroup', { label: o.group });
        groups.set(o.group, g);
        el.appendChild(g);
      }
      g.appendChild(opt);
    } else {
      el.appendChild(opt);
    }
  }
  return el;
}

/** Switch-style checkbox with a label. */
export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, opts: { disabled?: boolean; hint?: string } = {}): HTMLLabelElement {
  return h('label.toggle', { title: opts.hint },
    h('input', { type: 'checkbox', checked, disabled: opts.disabled, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }),
    h('span.toggle-track', null, h('span.toggle-thumb')),
    h('span', null, label));
}

/** Pill group for 2–5 mutually exclusive options. */
export function segmented<T extends string>(options: Option<T>[], value: T, onChange: (v: T) => void): HTMLElement {
  const el = h('div.segmented', { role: 'radiogroup' });
  const render = (current: T) => mount(el, options.map(o =>
    h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(o.value === current), class: o.value === current ? 'on' : '',
      onclick: () => {
        render(o.value);
        onChange(o.value);
      }
    }, o.label)));
  render(value);
  return el;
}

/** Secondary tab strip inside a tab (e.g. Geometries | Trajectory). */
export function subTabs<T extends string>(items: Option<T>[], active: T, onChange: (v: T) => void): HTMLElement {
  const el = h('nav.subtabs');
  const render = (current: T) => mount(el, items.map(i =>
    h('button', { type: 'button', class: i.value === current ? 'on' : '', onclick: () => { render(i.value); onChange(i.value); } }, i.label)));
  render(active);
  return el;
}

// --- table ------------------------------------------------------------------

export interface Column<R> {
  key: string;
  label: string;
  /** Cell content; default: String(row[key]). */
  render?: (row: R) => Child;
  /** Value used for sorting; default: row[key]. */
  sortValue?: (row: R) => number | string;
  align?: 'left' | 'right' | 'center';
  /** Monospace, tabular numbers. */
  numeric?: boolean;
  width?: string;
  title?: string;
}

export interface TableOptions<R> {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  /** Checkbox column; called with the selected keys. */
  selectable?: { selected: Set<string>; onChange(selected: Set<string>): void };
  onRowClick?: (row: R) => void;
  /** Key of the row to highlight as selected (e.g. the row whose details are shown). */
  selectedKey?: string;
  /** Extra CSS classes per row. */
  rowClass?: (row: R) => string;
  empty?: string;
  /** Text filter box above the table matching this string per row. */
  filterText?: (row: R) => string;
  filterPlaceholder?: string;
  maxHeight?: number;
  initialSort?: { key: string; dir: 1 | -1 };
}

/** Sortable table with sticky header, optional selection and text filter. */
export function dataTable<R>(o: TableOptions<R>): HTMLElement {
  let sort = o.initialSort;
  let filter = '';
  const wrap = h('div.table-wrap', { style: o.maxHeight ? { maxHeight: `${o.maxHeight}px` } : undefined });
  const host = h('div.table-host');
  const visible = () => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    let rows = o.filterText && words.length ? o.rows.filter(r => { const t = o.filterText!(r).toLowerCase(); return words.every(w => t.includes(w)); }) : o.rows.slice();
    if (sort) {
      const col = o.columns.find(c => c.key === sort!.key);
      const val = (r: R) => (col?.sortValue ? col.sortValue(r) : (r as any)[sort!.key]);
      rows = rows.sort((a, b) => {
        const va = val(a), vb = val(b);
        const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
        return cmp * sort!.dir;
      });
    }
    return rows;
  };
  const render = () => {
    const rows = visible();
    const sel = o.selectable;
    const allOn = sel && rows.length > 0 && rows.every(r => sel.selected.has(o.rowKey(r)));
    const head = h('tr', null,
      sel ? h('th.sel', null, h('input', {
        type: 'checkbox', checked: allOn, title: 'Select all shown',
        onchange: (e: Event) => {
          const on = (e.target as HTMLInputElement).checked;
          rows.forEach(r => (on ? sel.selected.add(o.rowKey(r)) : sel.selected.delete(o.rowKey(r))));
          sel.onChange(new Set(sel.selected));
          render();
        }
      })) : null,
      o.columns.map(c => h('th', {
        class: [c.align ?? (c.numeric ? 'right' : 'left'), sort?.key === c.key ? 'sorted' : ''].join(' '),
        style: c.width ? { width: c.width } : undefined, title: c.title,
        onclick: () => { sort = { key: c.key, dir: sort?.key === c.key ? (-sort.dir as 1 | -1) : 1 }; render(); }
      }, c.label, sort?.key === c.key ? h('span.sort', null, sort.dir === 1 ? '▲' : '▼') : null)));
    const body = rows.map(r => {
      const key = o.rowKey(r);
      return h('tr', { class: [o.onRowClick ? 'clickable' : '', sel?.selected.has(key) || o.selectedKey === key ? 'selected' : '', o.rowClass?.(r) ?? ''].join(' '), onclick: o.onRowClick ? () => o.onRowClick!(r) : undefined },
        sel ? h('td.sel', { onclick: (e: Event) => e.stopPropagation() }, h('input', {
          type: 'checkbox', checked: sel.selected.has(key),
          onchange: (e: Event) => {
            (e.target as HTMLInputElement).checked ? sel.selected.add(key) : sel.selected.delete(key);
            sel.onChange(new Set(sel.selected));
            render();
          }
        })) : null,
        o.columns.map(c => h('td', { class: [c.align ?? (c.numeric ? 'right' : 'left'), c.numeric ? 'num' : ''].join(' ') },
          c.render ? c.render(r) : String((r as any)[c.key] ?? ''))));
    });
    mount(wrap, h('table.table', null, h('thead', null, head), h('tbody', null, body.length ? body : h('tr', null, h('td.empty-row', { colspan: o.columns.length + (sel ? 1 : 0) }, o.empty ?? 'Nothing to show')))));
  };
  render();
  if (o.filterText) {
    const box = h('div.table-filter', null, icon('search'), h('input.input', {
      type: 'search', placeholder: o.filterPlaceholder ?? 'Filter…',
      oninput: (e: Event) => { filter = (e.target as HTMLInputElement).value; render(); }
    }));
    mount(host, box, wrap);
  } else {
    mount(host, wrap);
  }
  return host;
}

// --- feedback ---------------------------------------------------------------

let toastHost: HTMLElement | undefined;
export interface ToastAction {
  label: string;
  run(): void;
}

/** Corner message; with an action it stays longer and shows a button (e.g. "Show in Calculations"). */
export function toast(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info', action?: ToastAction): void {
  toastHost ??= document.body.appendChild(h('div.toasts', { role: 'status', 'aria-live': 'polite' }));
  const tone: Tone = level === 'success' ? 'ok' : level === 'warning' ? 'warn' : level === 'error' ? 'bad' : 'info';
  const t = h('div.toast', { class: `tone-${tone}` }, icon(tone === 'ok' ? 'check' : tone === 'bad' ? 'error' : tone === 'warn' ? 'warning' : 'info'), h('span', null, message),
    action ? h('button.toast-action', { type: 'button', onclick: () => { t.remove(); action.run(); } }, action.label) : null);
  toastHost.appendChild(t);
  const life = action ? 9000 : level === 'error' ? 7000 : 3500;
  setTimeout(() => t.classList.add('out'), life);
  setTimeout(() => t.remove(), life + 400);
}

/** Run an async action with a busy state on its button and a toast on failure. */
export async function busy<T>(btn: HTMLButtonElement | undefined, work: () => Promise<T>): Promise<T | undefined> {
  btn?.classList.add('busy');
  if (btn) {
    btn.disabled = true;
  }
  try {
    return await work();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
    return undefined;
  } finally {
    btn?.classList.remove('busy');
    if (btn) {
      btn.disabled = false;
    }
  }
}
