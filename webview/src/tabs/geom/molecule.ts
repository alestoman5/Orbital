// Atom picker of the geom tab: a small 2D sketch of the first frame (atoms
// as element-colored circles, bonds from covalent radii) and a compact atom
// table. Clicking 2–4 atoms builds a bond / angle / dihedral.

import type { MoleculeAtom, MoleculeResult } from '../../../../src/studio/tabs/geom/types';
import { h, mount } from '../../ui/dom';

const SVGNS = 'http://www.w3.org/2000/svg';

/** Jmol/CPK element colors (element identity, not theme colors). */
const ELEMENT_COLORS: Record<string, string> = {
  H: '#f4f4f4', He: '#d9ffff', Li: '#cc80ff', Be: '#c2ff00', B: '#ffb5b5', C: '#909090', N: '#3050f8', O: '#ff0d0d',
  F: '#90e050', Ne: '#b3e3f5', Na: '#ab5cf2', Mg: '#8aff00', Al: '#bfa6a6', Si: '#f0c8a0', P: '#ff8000', S: '#ffff30',
  Cl: '#1ff01f', Ar: '#80d1e3', K: '#8f40d4', Ca: '#3dff00', Ti: '#bfc2c7', Cr: '#8a99c7', Mn: '#9c7ac7', Fe: '#e06633',
  Co: '#f090a0', Ni: '#50d050', Cu: '#c88033', Zn: '#7d80b0', Ge: '#668f8f', As: '#bd80e3', Se: '#ffa100', Br: '#a62929',
  Kr: '#5cb8d1', Ru: '#248f8f', Rh: '#0a7d8c', Pd: '#006985', Ag: '#c0c0c0', Sn: '#668080', I: '#940094', Xe: '#429eb0',
  Pt: '#d0d0e0', Au: '#ffd123', Hg: '#b8b8d0'
};

export function elementSymbol(label: string): string {
  const m = /^([A-Za-z]{1,2})/.exec(label.trim());
  if (!m) return label;
  const s = m[1];
  const two = s[0].toUpperCase() + (s[1] ?? '').toLowerCase();
  return ELEMENT_COLORS[two] ? two : s[0].toUpperCase();
}

export function elementColor(label: string): string {
  return ELEMENT_COLORS[elementSymbol(label)] ?? '#ff1493';
}

/** Dark or light label ink for an element color (relative luminance). */
function inkOn(hex: string): string {
  const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  return lum > 0.3 ? '#14161c' : '#ffffff';
}

type V = [number, number, number];
const sub = (a: MoleculeAtom, b: MoleculeAtom): V => [a.x - b.x, a.y - b.y, a.z - b.z];
const dot = (u: V, v: V) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const cross = (u: V, v: V): V => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const len = (u: V) => Math.sqrt(dot(u, u));

/** Value of the picked coordinate in the first frame (Å or °), as the host measures it. */
export function measurePicked(atoms: MoleculeAtom[], pick: number[]): number | undefined {
  const a = pick.map(i => atoms[i - 1]);
  if (a.some(x => !x)) return undefined;
  if (a.length === 2) return len(sub(a[0], a[1]));
  if (a.length === 3) {
    const u = sub(a[0], a[1]);
    const v = sub(a[2], a[1]);
    return (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (len(u) * len(v))))) * 180) / Math.PI;
  }
  if (a.length === 4) {
    const b0 = sub(a[0], a[1]);
    const ax = sub(a[2], a[1]);
    const n = len(ax);
    const u: V = [ax[0] / n, ax[1] / n, ax[2] / n];
    const b2 = sub(a[3], a[2]);
    const v: V = [b0[0] - u[0] * dot(b0, u), b0[1] - u[1] * dot(b0, u), b0[2] - u[2] * dot(b0, u)];
    const w: V = [b2[0] - u[0] * dot(b2, u), b2[1] - u[1] * dot(b2, u), b2[2] - u[2] * dot(b2, u)];
    return (Math.atan2(dot(cross(u, v), w), dot(v, w)) * 180) / Math.PI;
  }
  return undefined;
}

export function pickLabel(atoms: MoleculeAtom[], pick: number[]): string {
  return pick.map(i => `${elementSymbol(atoms[i - 1]?.symbol ?? '?')}${i}`).join('–');
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: (SVGElement | string)[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const c of children) e.append(c);
  return e;
}

/** SVG sketch; `pick` are the selected 1-based indices in click order. */
export function moleculeSketch(m: MoleculeResult, pick: number[], onClick: (index: number) => void): SVGSVGElement {
  const atoms = m.atoms;
  const scale = 46; // px per Å
  const r = (a: MoleculeAtom) => 0.22 + 0.25 * Math.min(a.radius, 1.6);
  const xs = atoms.map(a => a.px);
  const ys = atoms.map(a => -a.py);
  const pad = 0.75;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  const W = Math.max(3, maxX - minX) * scale;
  const H = Math.max(2.2, maxY - minY) * scale;
  const ox = (W - (maxX - minX) * scale) / 2;
  const oy = (H - (maxY - minY) * scale) / 2;
  const X = (a: MoleculeAtom) => ox + (a.px - minX) * scale;
  const Y = (a: MoleculeAtom) => oy + (-a.py - minY) * scale;
  const svg = el('svg', { viewBox: `0 0 ${W.toFixed(1)} ${H.toFixed(1)}`, class: 'geom-sketch', role: 'img', 'aria-label': 'Molecule sketch, click atoms to pick a coordinate' });
  const depthMin = Math.min(...atoms.map(a => a.depth));
  const depthMax = Math.max(...atoms.map(a => a.depth));
  const shade = (a: MoleculeAtom) => (depthMax - depthMin > 0.2 ? 0.55 + 0.45 * ((a.depth - depthMin) / (depthMax - depthMin)) : 1);
  const bonds = el('g', { class: 'geom-bonds' });
  for (const [i, j] of m.bonds) {
    const a = atoms[i - 1];
    const b = atoms[j - 1];
    const picked = pick.includes(i) && pick.includes(j) && Math.abs(pick.indexOf(i) - pick.indexOf(j)) === 1;
    bonds.append(el('line', { x1: X(a).toFixed(1), y1: Y(a).toFixed(1), x2: X(b).toFixed(1), y2: Y(b).toFixed(1), class: picked ? 'on' : '' }));
  }
  // path through the picked atoms
  if (pick.length >= 2) {
    const pts = pick.map(i => atoms[i - 1]).filter(Boolean).map(a => `${X(a).toFixed(1)},${Y(a).toFixed(1)}`).join(' ');
    bonds.append(el('polyline', { points: pts, class: 'geom-pickpath' }));
  }
  svg.append(bonds);
  const order = atoms.slice().sort((a, b) => a.depth - b.depth);
  for (const a of order) {
    const k = pick.indexOf(a.index);
    const g = el('g', { class: `geom-atom${k >= 0 ? ' on' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${a.symbol}${a.index}`, 'data-index': a.index });
    const rad = r(a) * scale;
    if (k >= 0) g.append(el('circle', { cx: X(a).toFixed(1), cy: Y(a).toFixed(1), r: (rad + 4).toFixed(1), class: 'ring' }));
    g.append(el('circle', { cx: X(a).toFixed(1), cy: Y(a).toFixed(1), r: rad.toFixed(1), fill: elementColor(a.symbol), 'fill-opacity': shade(a).toFixed(2), class: 'ball' }));
    g.append(el('text', { x: X(a).toFixed(1), y: (Y(a) + 3.5).toFixed(1), class: 'lbl', fill: inkOn(elementColor(a.symbol)), 'text-anchor': 'middle' }, `${elementSymbol(a.symbol)}${a.index}`));
    if (k >= 0) {
      g.append(el('circle', { cx: (X(a) + rad * 0.8).toFixed(1), cy: (Y(a) - rad * 0.8).toFixed(1), r: 7, class: 'order' }));
      g.append(el('text', { x: (X(a) + rad * 0.8).toFixed(1), y: (Y(a) - rad * 0.8 + 3.3).toFixed(1), class: 'order-n', 'text-anchor': 'middle' }, String(k + 1)));
    }
    g.append(el('title', {}, `${a.symbol}${a.index}  (${a.x.toFixed(3)}, ${a.y.toFixed(3)}, ${a.z.toFixed(3)}) Å`));
    g.addEventListener('click', () => onClick(a.index));
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick(a.index);
      }
    });
    svg.append(g);
  }
  return svg;
}

/** Compact atom table (index, element, x, y, z); rows toggle the pick. */
export function atomTable(m: MoleculeResult, pick: number[], onClick: (index: number) => void): HTMLElement {
  const body = m.atoms.map(a => {
    const k = pick.indexOf(a.index);
    return h('tr', { class: k >= 0 ? 'on' : '', onclick: () => onClick(a.index), title: 'Click to add to / remove from the picked atoms' },
      h('td.num', null, String(a.index)),
      h('td', null, h('span.geom-dot', { style: { background: elementColor(a.symbol) } }), elementSymbol(a.symbol), k >= 0 ? h('span.geom-pickno', null, String(k + 1)) : null),
      h('td.num', null, a.x.toFixed(3)),
      h('td.num', null, a.y.toFixed(3)),
      h('td.num', null, a.z.toFixed(3)));
  });
  const wrap = h('div.geom-atoms');
  mount(wrap, h('table', null,
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'El'), h('th', null, 'x / Å'), h('th', null, 'y / Å'), h('th', null, 'z / Å'))),
    h('tbody', null, body)));
  return wrap;
}
