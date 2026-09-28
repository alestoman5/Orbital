// Webview preview of the absorption spectrum from one .out (stick spectrum +
// Gaussian broadening) or from a folder of per-geometry .out files (quick
// NEA-style average with a Silverman bandwidth). Meant for a sanity check
// before running PyNEAppLES, which remains the tool for production spectra
// with bootstrap confidence intervals.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Stick, silvermanBandwidth } from '../chem/spectrum';
import { findGeomSets, readGeomSet } from '../chem/neaRun';
import { findOutFiles, loadOutput, runFilesFor, targetPath } from './io';

export interface SpectrumData {
  title: string;
  sticks: Stick[];
  nGeometries: number;
  bandwidth: number;
  skipped: number;
}

async function collect(uri?: vscode.Uri): Promise<SpectrumData | undefined> {
  const p = targetPath(uri);
  if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const fromResults = await collectResultJson(p);
    if (fromResults !== null) {
      return fromResults;
    }
    const outs = await findOutFiles(vscode.Uri.file(p));
    const sticks: Stick[] = [];
    let n = 0;
    let skipped = 0;
    for (const out of outs) {
      const parsed = loadOutput(out);
      const exc = parsed ? [...parsed.jobs].reverse().find(j => j.excitations && j.excitations.length > 0)?.excitations : undefined;
      if (!parsed || parsed.status !== 'normal-termination' || !exc) {
        skipped++;
        continue;
      }
      n++;
      sticks.push(...exc.map(e => ({ energyEv: e.energyEv, weight: e.fosc })));
    }
    if (n === 0) {
      return undefined;
    }
    return { title: `${path.basename(p)} — ${n} geometries`, sticks, nGeometries: n, bandwidth: silvermanBandwidth(sticks), skipped };
  }
  if (!p) {
    return undefined;
  }
  const files = runFilesFor(p);
  const parsed = loadOutput(files.out);
  const exc = parsed ? [...parsed.jobs].reverse().find(j => j.excitations && j.excitations.length > 0)?.excitations : undefined;
  if (!exc) {
    return undefined;
  }
  return {
    title: path.basename(files.out),
    sticks: exc.map(e => ({ energyEv: e.energyEv, weight: e.fosc })),
    nGeometries: 1,
    // A single geometry has no physical band width: use an empirical one.
    bandwidth: vscode.workspace.getConfiguration('orcaInp').get<number>('spectrum.singleGeometryBandwidth', 0.2),
    skipped: 0
  };
}

/**
 * PySCF ADC results of the uv-vis NEA scripts (geom_NNNN/result.json).
 * null = not such a directory (fall back to .out files); undefined = cancelled or empty.
 */
async function collectResultJson(folder: string): Promise<SpectrumData | undefined | null> {
  const sets = findGeomSets(folder);
  if (sets.length === 0) {
    return null;
  }
  let dir = sets[0];
  if (sets.length > 1) {
    const pick = await vscode.window.showQuickPick(sets.map(d => path.relative(folder, d)), { title: 'Geometry set' });
    if (!pick) {
      return undefined;
    }
    dir = path.join(folder, pick);
  }
  const s = readGeomSet(dir);
  if (s.nOk === 0) {
    return undefined;
  }
  const label = path.relative(folder, dir);
  return {
    title: `${path.basename(folder)}${label ? '/' + label : ''} — ${s.nOk} geometries (result.json)`,
    sticks: s.sticks,
    nGeometries: s.nOk,
    bandwidth: silvermanBandwidth(s.sticks),
    skipped: s.byStatus['not converged'].length + s.byStatus.unreadable.length + s.byStatus['not started'].length
  };
}

export async function showSpectrumPreview(uri?: vscode.Uri): Promise<void> {
  const data = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Reading excitations…' },
    () => collect(uri)
  );
  if (!data) {
    vscode.window.showErrorMessage(
      'No ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS table found (open a TD-DFT/EOM .out, or run on a folder of them).'
    );
    return;
  }
  const panel = vscode.window.createWebviewPanel('orcaSpectrum', `Spectrum: ${data.title}`, vscode.ViewColumn.Beside, {
    enableScripts: true
  });
  panel.webview.html = spectrumHtml(data, panel.webview.cspSource);
}

export function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

export function spectrumHtml(data: SpectrumData, cspSource: string): string {
  const n = nonce();
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px 16px; }
  h2 { font-size: 1.1em; margin: 0 0 8px; }
  .controls { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; margin-bottom: 8px; }
  label { display: flex; gap: 6px; align-items: center; }
  svg { width: 100%; height: auto; max-height: 70vh; }
  .axis { stroke: var(--vscode-foreground); stroke-width: 1; opacity: .6; }
  .tick { fill: var(--vscode-descriptionForeground); font-size: 11px; }
  .curve { fill: none; stroke: var(--vscode-charts-blue, #3794ff); stroke-width: 2; }
  .stick { stroke: var(--vscode-charts-orange, #d18616); stroke-width: 1; opacity: .7; }
  table { border-collapse: collapse; margin-top: 8px; }
  td, th { padding: 2px 10px; text-align: right; border-bottom: 1px solid var(--vscode-panel-border, #8884); }
  .note { color: var(--vscode-descriptionForeground); font-size: .9em; margin-top: 8px; }
</style>
</head>
<body>
<h2 id="title"></h2>
<div class="controls">
  <label>axis <select id="unit"><option value="ev">E / eV</option><option value="nm">λ / nm</option></select></label>
  <label>h / eV <input id="h" type="range" min="0.01" max="0.6" step="0.005"><span id="hval"></span></label>
  <label><input id="sticks" type="checkbox" checked> sticks</label>
</div>
<svg id="plot" viewBox="0 0 800 420" role="img" aria-label="absorption spectrum"></svg>
<table id="desc"></table>
<p class="note" id="note"></p>
<script nonce="${n}">
const data = ${payload};
const EVNM = 1239.84198;
const $ = id => document.getElementById(id);
$('title').textContent = data.title;
$('h').value = data.bandwidth.toFixed(3);
$('note').textContent = (data.nGeometries > 1
  ? 'NEA-style average over ' + data.nGeometries + ' geometries, Silverman h = ' + data.bandwidth.toFixed(3) + ' eV. No bootstrap interval — use PyNEAppLES for production spectra.'
  : 'Single geometry: band width is empirical (h), not physical.')
  + (data.skipped ? ' Skipped ' + data.skipped + ' unfinished/empty outputs.' : '')
  + ' y = Σ f·K_h(E−ΔE)/N (relative; the πE/3ħε₀c prefactor is omitted).';

function draw() {
  const h = parseFloat($('h').value);
  $('hval').textContent = h.toFixed(3);
  const unit = $('unit').value;
  const es = data.sticks.map(s => s.energyEv);
  const lo = Math.max(0.5, Math.min(...es) - 4 * h), hi = Math.max(...es) + 4 * h;
  const N = 600, grid = [], y = [];
  for (let i = 0; i < N; i++) grid.push(lo + (hi - lo) * i / (N - 1));
  const norm = 1 / (h * Math.sqrt(2 * Math.PI) * data.nGeometries);
  for (const E of grid) {
    let s = 0;
    for (const st of data.sticks) s += st.weight * Math.exp(-((E - st.energyEv) ** 2) / (2 * h * h));
    y.push(s * norm);
  }
  // band descriptors on the energy grid
  let iMax = 0; for (let i = 1; i < N; i++) if (y[i] > y[iMax]) iMax = i;
  let I = 0, M = 0;
  for (let i = 1; i < N; i++) { const dx = grid[i] - grid[i-1]; I += .5 * (y[i] + y[i-1]) * dx; M += .5 * (grid[i]*y[i] + grid[i-1]*y[i-1]) * dx; }
  const half = y[iMax] / 2; let L = grid[0], R = grid[N-1];
  for (let i = 1; i <= iMax; i++) if (y[i-1] < half && y[i] >= half) { L = grid[i-1] + (half - y[i-1]) * (grid[i]-grid[i-1]) / (y[i]-y[i-1]); break; }
  for (let i = N-1; i > iMax; i--) if (y[i] < half && y[i-1] >= half) { R = grid[i-1] + (half - y[i-1]) * (grid[i]-grid[i-1]) / (y[i]-y[i-1]); break; }
  const Ec = M / I;
  $('desc').innerHTML = '<tr><th></th><th>E / eV</th><th>λ / nm</th></tr>'
    + '<tr><td>maximum</td><td>' + grid[iMax].toFixed(3) + '</td><td>' + (EVNM / grid[iMax]).toFixed(1) + '</td></tr>'
    + '<tr><td>centroid</td><td>' + Ec.toFixed(3) + '</td><td>' + (EVNM / Ec).toFixed(1) + '</td></tr>'
    + '<tr><td>FWHM</td><td>' + (R - L).toFixed(3) + '</td><td>' + (EVNM / L - EVNM / R).toFixed(1) + '</td></tr>'
    + '<tr><td>∫ y dE (≈ Σf / N)</td><td>' + I.toFixed(4) + '</td><td></td></tr>';

  const xs = unit === 'nm' ? grid.map(E => EVNM / E) : grid;
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymax = Math.max(...y) * 1.08 || 1;
  const W = 800, H = 420, ml = 50, mr = 15, mt = 10, mb = 40;
  const X = v => ml + (v - xmin) / (xmax - xmin) * (W - ml - mr);
  const Y = v => H - mb - v / ymax * (H - mt - mb);
  let svg = '<line class="axis" x1="' + ml + '" y1="' + (H-mb) + '" x2="' + (W-mr) + '" y2="' + (H-mb) + '"/>'
          + '<line class="axis" x1="' + ml + '" y1="' + mt + '" x2="' + ml + '" y2="' + (H-mb) + '"/>';
  const step = niceStep((xmax - xmin) / 8);
  for (let t = Math.ceil(xmin / step) * step; t <= xmax; t += step) {
    svg += '<line class="axis" x1="' + X(t) + '" y1="' + (H-mb) + '" x2="' + X(t) + '" y2="' + (H-mb+4) + '"/>'
         + '<text class="tick" x="' + X(t) + '" y="' + (H-mb+17) + '" text-anchor="middle">' + +t.toFixed(3) + '</text>';
  }
  svg += '<text class="tick" x="' + (W/2) + '" y="' + (H-4) + '" text-anchor="middle">' + (unit === 'nm' ? 'λ / nm' : 'E / eV') + '</text>';
  if ($('sticks').checked) {
    const fmax = Math.max(...data.sticks.map(s => s.weight)) || 1;
    for (const st of data.sticks) {
      const xv = unit === 'nm' ? EVNM / st.energyEv : st.energyEv;
      if (xv < xmin || xv > xmax) continue;
      svg += '<line class="stick" x1="' + X(xv) + '" x2="' + X(xv) + '" y1="' + (H-mb) + '" y2="' + (H - mb - st.weight / fmax * 0.35 * (H-mt-mb)) + '"/>';
    }
  }
  svg += '<path class="curve" d="' + xs.map((xv, i) => (i ? 'L' : 'M') + X(xv).toFixed(1) + ',' + Y(y[i]).toFixed(1)).join('') + '"/>';
  $('plot').innerHTML = svg;
}
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))); const m = raw / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }
for (const id of ['h', 'unit', 'sticks']) $(id).addEventListener('input', draw);
draw();
</script>
</body>
</html>`;
}
