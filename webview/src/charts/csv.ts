// CSV of a figure's data: one x column per distinct x array, each followed by
// the y / lo / hi (…) columns of the series that use it. Rows run to the
// longest column; shorter columns are left empty. DOM-free.

import type { Figure, Series } from './api';
import { plainText } from './text';

interface Column {
  header: string;
  values: ArrayLike<number>;
}

interface XGroup {
  x: ArrayLike<number>;
  header: string;
  cols: Column[];
}

function sameArray(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) {
      return false;
    }
  }
  return true;
}

function quote(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function num(v: number | undefined): string {
  return v === undefined || !Number.isFinite(v) ? '' : String(v);
}

function seriesName(s: Series, i: number): string {
  return s.label ? plainText(s.label) : s.group ? plainText(s.group) : `series ${i + 1}`;
}

/** CSV text (RFC 4180, "\n" line ends, header row first). */
export function buildCsv(figure: Figure): string {
  const groups: XGroup[] = [];
  const multi = figure.panels.length > 1;
  figure.panels.forEach((panel, pi) => {
    const prefix = multi ? `${panel.tag ?? `(${String.fromCharCode(97 + pi)})`} ` : '';
    const xLabel = plainText(panel.x.label ?? 'x');
    const yLabel = plainText(panel.y.label ?? 'y');
    const groupFor = (x: ArrayLike<number>, header: string): XGroup => {
      let g = groups.find(q => sameArray(q.x, x));
      if (!g) {
        g = { x, header: prefix + header, cols: [] };
        groups.push(g);
      }
      return g;
    };
    panel.series.forEach((s, si) => {
      const name = prefix + seriesName(s, si);
      switch (s.type) {
        case 'line':
        case 'sticks':
          groupFor(s.x, xLabel).cols.push({ header: name, values: s.y });
          break;
        case 'band': {
          const g = groupFor(s.x, xLabel);
          g.cols.push({ header: `${name} lo`, values: s.lo }, { header: `${name} hi`, values: s.hi });
          break;
        }
        case 'scatter': {
          const g = groupFor(s.x, xLabel);
          g.cols.push({ header: name, values: s.y });
          if (s.yErr) {
            g.cols.push({ header: `${name} y error`, values: s.yErr });
          }
          if (s.xErr) {
            g.cols.push({ header: `${name} x error`, values: s.xErr });
          }
          break;
        }
        case 'histogram': {
          const n = Math.min(s.values.length, s.edges.length - 1);
          const lo = Float64Array.from({ length: n }, (_, i) => s.edges[i]);
          const hi = Float64Array.from({ length: n }, (_, i) => s.edges[i + 1]);
          const g = groupFor(lo, `${xLabel} bin start`);
          g.cols.push({ header: `${xLabel} bin end`, values: hi }, { header: name, values: Float64Array.from({ length: n }, (_, i) => s.values[i]) });
          break;
        }
        case 'heatmap': {
          // long format: x centre, y centre, z
          const xs: number[] = [];
          const ys: number[] = [];
          const zs: number[] = [];
          for (let iy = 0; iy < s.z.length; iy++) {
            for (let ix = 0; ix < s.z[iy].length; ix++) {
              xs.push((s.xEdges[ix] + s.xEdges[ix + 1]) / 2);
              ys.push((s.yEdges[iy] + s.yEdges[iy + 1]) / 2);
              zs.push(s.z[iy][ix]);
            }
          }
          const g: XGroup = { x: xs, header: prefix + xLabel, cols: [{ header: prefix + yLabel, values: ys }, { header: s.colorbarLabel ? prefix + plainText(s.colorbarLabel) : name, values: zs }] };
          groups.push(g);
          break;
        }
        default:
          break; // rules and text carry no data columns
      }
    });
  });
  const cols: Column[] = [];
  for (const g of groups) {
    cols.push({ header: g.header, values: g.x }, ...g.cols);
  }
  if (!cols.length) {
    return '';
  }
  const rows = Math.max(...cols.map(c => c.values.length));
  const lines = [cols.map(c => quote(c.header)).join(',')];
  for (let r = 0; r < rows; r++) {
    lines.push(cols.map(c => (r < c.values.length ? num(c.values[r]) : '')).join(','));
  }
  return lines.join('\n') + '\n';
}
