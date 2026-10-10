// Tiny DOM builder used by every tab: h('div.card.wide', { onclick }, ...children).
// No framework — tabs re-render the parts that change.

export type Child = Node | string | number | false | null | undefined | Child[];

export interface Props {
  [key: string]: unknown;
  class?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
}

/**
 * `tag` may carry classes and an id: 'button.btn.primary#save'. Props starting
 * with "on" become listeners, `class`/`style`/`dataset` are merged, booleans
 * toggle attributes, everything else is set as an attribute (or property for
 * value / checked / selected / disabled / innerHTML).
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K | `${K}${'.' | '#'}${string}`, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const m = /^([a-z0-9-]+)((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement(m ? m[1] : 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
      if (part[0] === '.') {
        el.classList.add(part.slice(1));
      } else {
        el.id = part.slice(1);
      }
    }
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) {
        continue;
      }
      if (k === 'class') {
        String(v).split(/\s+/).filter(Boolean).forEach(c => el.classList.add(c));
      } else if (k === 'style') {
        if (typeof v === 'string') {
          el.setAttribute('style', v);
        } else {
          Object.assign(el.style, v);
        }
      } else if (k === 'dataset') {
        Object.assign(el.dataset, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (['value', 'checked', 'selected', 'disabled', 'innerHTML', 'textContent', 'indeterminate'].includes(k)) {
        (el as any)[k] = v;
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) {
      continue;
    }
    if (Array.isArray(c)) {
      append(parent, c);
    } else if (c instanceof Node) {
      parent.appendChild(c);
    } else {
      parent.appendChild(document.createTextNode(String(c)));
    }
  }
}

/** Replace all children of `el`. */
export function mount(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Element from trusted static SVG markup (icons). */
export function svg(markup: string, className = 'icon'): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  const el = t.content.firstElementChild as SVGSVGElement;
  el.classList.add(...className.split(' ').filter(Boolean));
  el.setAttribute('aria-hidden', 'true');
  return el;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms = 150): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (t) {
      clearTimeout(t);
    }
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Number formatting used across tabs: fixed decimals, or 3 significant digits in exponent form for tiny/huge values. */
export function fmt(v: number | undefined | null, digits = 2): string {
  if (v === undefined || v === null || !Number.isFinite(v)) {
    return '–';
  }
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) {
    const [m, e] = v.toExponential(Math.max(digits, 2)).split('e');
    return `${m}×10${superscript(e.replace('+', ''))}`;
  }
  return v.toFixed(digits);
}

const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
export function superscript(s: string): string {
  return s.split('').map(c => SUP[c] ?? c).join('');
}
