// Column data files written by MD codes (ABIN energies.dat, est_energy.dat,
// temper.dat, ...): an optional "#" header with column names, then rows of
// numbers whose first column is time. Plus the least-squares line used to
// judge drift on a zoomed range. Pure logic, no `vscode` import.

export interface DatTable {
  /** Names of all columns, the first one being the x axis (time). */
  columns: string[];
  /** columns.length arrays of equal length. */
  data: number[][];
  /** Non-empty, non-comment rows that could not be read. */
  skipped: number;
}

export function parseDat(text: string): DatTable {
  let header: string[] | undefined;
  const rows: number[][] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0) {
      continue;
    }
    if (t.startsWith('#')) {
      if (!header && rows.length === 0) {
        header = t.slice(1).trim().split(/\s+/).filter(s => s.length > 0);
      }
      continue;
    }
    const values = t.split(/\s+/).map(Number);
    if (values.some(v => !Number.isFinite(v)) || (rows.length > 0 && values.length !== rows[0].length)) {
      skipped++;
      continue;
    }
    rows.push(values);
  }
  const ncol = rows.length > 0 ? rows[0].length : header?.length ?? 0;
  const columns = header && header.length === ncol
    ? header
    : Array.from({ length: ncol }, (_, i) => (i === 0 ? 'x' : `col ${i + 1}`));
  const data = columns.map((_, j) => rows.map(r => r[j]));
  return { columns, data, skipped };
}

/**
 * Least-squares line y = slope·x + intercept through points i0..i1-1.
 * Self-contained (no closures or imports) so the plot webview can reuse
 * its source via Function.prototype.toString().
 */
export function linearFit(x: number[], y: number[], i0: number, i1: number): { slope: number; intercept: number } {
  const n = i1 - i0;
  if (n < 2) {
    return { slope: NaN, intercept: NaN };
  }
  let mx = 0;
  let my = 0;
  for (let i = i0; i < i1; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = i0; i < i1; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) * (x[i] - mx);
  }
  const slope = sxx > 0 ? sxy / sxx : NaN;
  return { slope, intercept: my - slope * mx };
}
