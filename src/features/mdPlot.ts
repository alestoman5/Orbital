// Webview plot of an MD column file (.dat): one panel per column on a shared
// time axis, zoomable, with the least-squares slope and the end − start
// difference of the visible range to check for drift.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { linearFit, parseDat } from '../chem/datFile';
import { targetPath } from './io';
import { nonce } from './spectrumPanel';

export async function showDatPlot(uri?: vscode.Uri): Promise<void> {
  const p = targetPath(uri);
  if (!p) {
    return;
  }
  const table = parseDat(fs.readFileSync(p, 'utf8'));
  if (table.columns.length < 2 || table.data[0].length < 2) {
    vscode.window.showErrorMessage(`${path.basename(p)}: need at least two numeric columns and two rows.`);
    return;
  }
  const panel = vscode.window.createWebviewPanel('orcaDatPlot', `Plot: ${path.basename(p)}`, vscode.ViewColumn.Beside, {
    enableScripts: true
  });
  panel.webview.html = datPlotHtml(path.basename(p), table.columns, table.data, table.skipped, panel.webview.cspSource);
}

export function datPlotHtml(title: string, columns: string[], data: number[][], skipped: number, cspSource: string): string {
  const n = nonce();
  const payload = JSON.stringify({ title, columns, data, skipped }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px 16px; }
  h2 { font-size: 1.1em; margin: 0 0 8px; }
  .controls { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin-bottom: 8px; }
  label { display: flex; gap: 4px; align-items: center; }
  .panel { margin-bottom: 10px; }
  .head { display: flex; flex-wrap: wrap; gap: 18px; font-size: .92em; }
  .name { font-weight: 600; }
  .stat { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  canvas { width: 100%; height: 170px; display: block; cursor: crosshair; }
  .note { color: var(--vscode-descriptionForeground); font-size: .9em; }
</style>
</head>
<body>
<h2 id="title"></h2>
<div class="controls" id="cols"></div>
<p class="note">Wheel: zoom time · drag: select range · double-click: full range. Slope = least-squares fit over the visible range (dashed line).</p>
<div id="panels"></div>
<p class="note" id="range"></p>
<script nonce="${n}">
const D = ${payload};
const linearFit = ${linearFit.toString()};
const $ = id => document.getElementById(id);
const x = D.data[0];
const N = x.length;
const perPs = /fs/i.test(D.columns[0]) ? 1000 : 1;
const slopeUnit = perPs === 1000 ? ' / ps' : ' / ' + D.columns[0];
const css = getComputedStyle(document.body);
const col = (v, fb) => (css.getPropertyValue(v).trim() || fb);
const C = { fg: col('--vscode-foreground', '#ccc'), line: col('--vscode-charts-blue', '#3794ff'), fit: col('--vscode-charts-orange', '#d18616'), grid: col('--vscode-panel-border', '#8884'), sel: col('--vscode-editor-selectionBackground', '#264f78') };
let xa = x[0], xb = x[N - 1];
const shown = D.columns.map((_, j) => j > 0);
$('title').textContent = D.title + ' — ' + N + ' rows' + (D.skipped ? ', ' + D.skipped + ' unreadable skipped' : '');

D.columns.forEach((name, j) => {
  if (j === 0) return;
  const l = document.createElement('label');
  l.innerHTML = '<input type="checkbox" checked> ';
  l.append(name);
  l.firstChild.addEventListener('change', e => { shown[j] = e.target.checked; build(); });
  $('cols').append(l);
});

function lowerBound(v) { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (x[m] < v) lo = m + 1; else hi = m; } return lo; }
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))); const m = raw / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }
function fmt(v, step) { const d = Math.max(0, -Math.floor(Math.log10(step)) + 1); return v.toFixed(Math.min(d, 10)); }
function fmtG(v) { return Number.isFinite(v) ? v.toPrecision(4) : '–'; }

let panels = [];
function build() {
  $('panels').innerHTML = '';
  panels = [];
  D.columns.forEach((name, j) => {
    if (j === 0 || !shown[j]) return;
    const div = document.createElement('div');
    div.className = 'panel';
    div.innerHTML = '<div class="head"><span class="name"></span><span class="stat"></span></div><canvas></canvas>';
    div.querySelector('.name').textContent = name;
    $('panels').append(div);
    const cv = div.querySelector('canvas');
    attach(cv);
    panels.push({ j, cv, stat: div.querySelector('.stat') });
  });
  draw();
}

const ML = 90, MR = 12, MT = 8, MB = 22;
let drag = null;
function draw() {
  const i0 = lowerBound(xa), i1 = Math.max(i0 + 1, lowerBound(xb + 1e-12));
  $('range').textContent = D.columns[0] + ': ' + x[i0] + ' – ' + x[Math.min(i1, N) - 1] + ' (' + (i1 - i0) + ' points)';
  for (const p of panels) {
    const y = D.data[p.j];
    const dpr = window.devicePixelRatio || 1;
    const W = p.cv.clientWidth, H = p.cv.clientHeight;
    p.cv.width = W * dpr; p.cv.height = H * dpr;
    const g = p.cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let ymin = Infinity, ymax = -Infinity;
    for (let i = i0; i < i1; i++) { if (y[i] < ymin) ymin = y[i]; if (y[i] > ymax) ymax = y[i]; }
    if (ymin === ymax) { ymin -= 1e-9 + Math.abs(ymin) * 1e-9; ymax += 1e-9 + Math.abs(ymax) * 1e-9; }
    const pad = (ymax - ymin) * 0.05; ymin -= pad; ymax += pad;
    const pw = W - ML - MR, ph = H - MT - MB;
    const X = v => ML + (v - xa) / (xb - xa) * pw;
    const Y = v => MT + (ymax - v) / (ymax - ymin) * ph;
    g.font = '11px ' + css.fontFamily; g.fillStyle = C.fg; g.strokeStyle = C.grid; g.lineWidth = 1;
    const ys = niceStep((ymax - ymin) / 4);
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let t = Math.ceil(ymin / ys) * ys; t <= ymax; t += ys) {
      g.beginPath(); g.moveTo(ML, Y(t)); g.lineTo(W - MR, Y(t)); g.stroke();
      g.fillText(fmt(t, ys), ML - 4, Y(t));
    }
    const xs = niceStep((xb - xa) / 8);
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let t = Math.ceil(xa / xs) * xs; t <= xb; t += xs) g.fillText(fmt(t, xs), X(t), H - MB + 4);
    g.strokeRect(ML, MT, pw, ph);
    // min/max per pixel column keeps 10^5 points fast and spikes visible
    g.save(); g.beginPath(); g.rect(ML, MT, pw, ph); g.clip();
    g.strokeStyle = C.line; g.beginPath();
    let px = -1, lo = 0, hi = 0;
    for (let i = i0; i < i1; i++) {
      const cx = Math.floor(X(x[i]));
      if (cx !== px) {
        if (px >= 0) { g.lineTo(px + .5, Y(lo)); g.lineTo(px + .5, Y(hi)); }
        else g.moveTo(cx + .5, Y(y[i]));
        px = cx; lo = hi = y[i];
      } else { if (y[i] < lo) lo = y[i]; if (y[i] > hi) hi = y[i]; }
    }
    if (px >= 0) { g.lineTo(px + .5, Y(lo)); g.lineTo(px + .5, Y(hi)); }
    g.stroke();
    const f = linearFit(x, y, i0, i1);
    if (Number.isFinite(f.slope)) {
      g.strokeStyle = C.fit; g.setLineDash([6, 4]); g.lineWidth = 1.5; g.beginPath();
      g.moveTo(X(xa), Y(f.slope * xa + f.intercept)); g.lineTo(X(xb), Y(f.slope * xb + f.intercept)); g.stroke();
      g.setLineDash([]);
    }
    if (drag && drag.cv === p.cv) { g.fillStyle = C.sel; g.globalAlpha = .5; g.fillRect(Math.min(drag.a, drag.b), MT, Math.abs(drag.b - drag.a), ph); g.globalAlpha = 1; }
    g.restore();
    p.stat.textContent = 'slope ' + fmtG(f.slope * perPs) + slopeUnit + '   ·   end − start ' + fmtG(y[i1 - 1] - y[i0]);
  }
}

function toX(cv, px) { const pw = cv.clientWidth - ML - MR; return xa + (px - ML) / pw * (xb - xa); }
function setRange(a, b) {
  const full = x[N - 1] - x[0];
  if (b - a < full * 1e-6) return;
  xa = Math.max(x[0], a); xb = Math.min(x[N - 1], b); draw();
}
function attach(cv) {
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect(), c = toX(cv, e.clientX - r.left), k = e.deltaY > 0 ? 1.25 : 0.8;
    setRange(c - (c - xa) * k, c + (xb - c) * k);
  }, { passive: false });
  cv.addEventListener('mousedown', e => { const r = cv.getBoundingClientRect(); drag = { cv, a: e.clientX - r.left, b: e.clientX - r.left }; });
  cv.addEventListener('mousemove', e => { if (drag && drag.cv === cv) { drag.b = e.clientX - cv.getBoundingClientRect().left; draw(); } });
  cv.addEventListener('dblclick', () => { xa = x[0]; xb = x[N - 1]; draw(); });
}
window.addEventListener('mouseup', () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (Math.abs(d.b - d.a) > 4) setRange(toX(d.cv, Math.min(d.a, d.b)), toX(d.cv, Math.max(d.a, d.b))); else draw();
});
window.addEventListener('resize', draw);
build();
</script>
</body>
</html>`;
}
