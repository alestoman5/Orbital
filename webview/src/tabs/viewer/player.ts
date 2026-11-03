// Trajectory player of the viewer tab: frame slider, play / pause / step,
// speed and loop mode, and the energy profile along the frames (scan
// coordinate or frame index on x, relative energy on y) with a marker at
// the current frame. Clicking the profile jumps to the nearest frame.

import type { StructureResult } from '../../../../src/studio/tabs/viewer/types';
import { figureToolbar, render, type ChartHandle, type Figure, type Preset, type ToolbarHost } from '../../charts';
import { icon, iconButton, select, type Option } from '../../ui/components';
import { h } from '../../ui/dom';
import type { ViewContext } from '../../view';

export type EnergyUnit = 'kJ' | 'kcal' | 'eV';
const UNIT: Record<EnergyUnit, { f: number; label: string }> = {
  kJ: { f: 2625.49964, label: 'kJ mol^{−1}' },
  kcal: { f: 627.509474, label: 'kcal mol^{−1}' },
  eV: { f: 27.211386245988, label: 'eV' }
};

export interface PlayerState {
  fps: number;
  mode: 'loop' | 'bounce' | 'once';
  unit: EnergyUnit;
  preset: Preset;
}

export interface Player {
  el: HTMLElement;
  frame(): number;
  setFrame(i: number): void;
  stop(): void;
  dispose(): void;
}

export function createPlayer(ctx: ViewContext, s: StructureResult, st: PlayerState, save: () => void, onFrame: (i: number) => void): Player {
  const n = s.frames.length;
  let cur = 0;
  let playing = false;
  let dir = 1;
  let timer = 0;
  let last = 0;
  let chart: ChartHandle | undefined;
  let hoverX: number | undefined;

  const xs: number[] = s.coordinate && s.coordinate.values.every(v => v !== null) ? (s.coordinate.values as number[]) : s.frames.map((_, i) => i * s.stride + 1);
  // scans of angles/dihedrals run over tens of degrees, bond scans over a few Å
  const xLabel = s.coordinate && s.coordinate.values.every(v => v !== null) ? `${s.coordinate.label} / ${Math.max(...xs.map(Math.abs)) > 6 ? '°' : 'Å'}` : 'frame';
  const energies = s.energies;
  const eMin = energies ? Math.min(...(energies.filter(e => e !== null) as number[])) : 0;
  const eRef = energies?.[0] ?? eMin;

  const label = h('span.viewer-frame-label');
  const slider = h('input.viewer-slider', { type: 'range', min: 0, max: Math.max(0, n - 1), step: 1, value: '0', 'aria-label': 'Frame' }) as HTMLInputElement;
  slider.addEventListener('input', () => {
    stop();
    go(Number(slider.value));
  });
  const playBtn = iconButton('play', 'Play / pause (space)', () => (playing ? stop() : play()));
  const fpsOptions: Option<string>[] = [2, 5, 10, 15, 24, 30, 60].map(v => ({ value: String(v), label: `${v} fps` }));
  const modeOptions: Option<PlayerState['mode']>[] = [{ value: 'loop', label: 'Loop' }, { value: 'bounce', label: 'Bounce' }, { value: 'once', label: 'Once' }];
  const unitOptions: Option<EnergyUnit>[] = [{ value: 'kJ', label: 'kJ/mol' }, { value: 'kcal', label: 'kcal/mol' }, { value: 'eV', label: 'eV' }];

  const controls = h('div.viewer-player-row', null,
    iconButton('skipBack', 'First frame', () => { stop(); go(0); }),
    iconButton('chevronLeft', 'Previous frame', () => { stop(); go(cur - 1); }),
    playBtn,
    iconButton('chevronRight', 'Next frame', () => { stop(); go(cur + 1); }),
    iconButton('skipForward', 'Last frame', () => { stop(); go(n - 1); }),
    slider,
    label,
    select(fpsOptions, String(st.fps), v => { st.fps = Number(v); save(); }),
    select(modeOptions, st.mode, v => { st.mode = v; save(); }),
    energies ? select(unitOptions, st.unit, v => { st.unit = v; save(); drawChart(); }) : null);

  const plotBox = h('div.viewer-energy-plot');
  const toolbar = energies
    ? figureToolbar({
        figure: () => figure(),
        name: 'trajectory-energy',
        host: ctx as unknown as ToolbarHost,
        initialPreset: st.preset,
        caption: () => `Relative energy along ${xLabel.split(' / ')[0]}.`,
        onLayoutChange: preset => {
          st.preset = preset;
          save();
          drawChart();
        }
      })
    : null;
  const el = h('div.viewer-player', null, controls, energies ? h('div.viewer-energy', null, h('div.viewer-energy-head', null, h('span.muted', null, 'Energy profile · click to jump to a frame'), toolbar), plotBox) : null);

  function rel(e: number | null): number {
    return e === null ? NaN : (e - (Number.isFinite(eRef as number) ? (eRef as number) : eMin)) * UNIT[st.unit].f;
  }

  function figure(): Figure {
    const y = (energies ?? []).map(rel);
    const fx: number[] = [];
    const fy: number[] = [];
    xs.forEach((x, i) => {
      if (Number.isFinite(y[i])) {
        fx.push(x);
        fy.push(y[i]);
      }
    });
    return {
      preset: st.preset,
      panels: [{
        x: { label: xLabel, reverse: s.coordinate ? xs[0] > xs[xs.length - 1] : false },
        y: { label: `ΔE / ${UNIT[st.unit].label}`, zero: false },
        series: [
          { type: 'line', x: fx, y: fy, markers: fx.length <= 200, label: 'E − E(first frame)' },
          { type: 'vline', value: xs[cur], dash: 'dashed', color: 'var(--accent)' }
        ],
        legend: 'none'
      }]
    };
  }

  function drawChart(): void {
    if (!energies) return;
    const f = figure();
    if (chart) chart.update(f);
    else {
      chart = render(plotBox, f, {
        readout: (_p, x, y) => {
          hoverX = x;
          const k = nearest(x);
          return `${xLabel.startsWith('frame') ? 'frame' : xLabel.split(' / ')[0]} ${fmt(xs[k])}: ΔE = ${y.toFixed(2)} ${st.unit === 'kJ' ? 'kJ/mol' : st.unit === 'kcal' ? 'kcal/mol' : 'eV'}`;
        }
      });
      plotBox.addEventListener('click', () => {
        if (hoverX === undefined) return;
        stop();
        go(nearest(hoverX));
      });
    }
  }

  function nearest(x: number): number {
    let best = 0;
    let bd = Infinity;
    xs.forEach((v, i) => {
      const d = Math.abs(v - x);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  function fmt(v: number): string {
    return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) >= 100 ? 1 : 3);
  }

  let chartPending = 0;
  function go(i: number): void {
    cur = Math.max(0, Math.min(n - 1, i));
    slider.value = String(cur);
    const e = energies?.[cur];
    const parts = [`${cur + 1} / ${n}`];
    if (s.coordinate?.values[cur] !== null && s.coordinate?.values[cur] !== undefined) parts.push(`${s.coordinate.label} ${fmt(s.coordinate.values[cur] as number)}`);
    if (e !== undefined && e !== null) parts.push(`ΔE ${rel(e).toFixed(2)} ${st.unit === 'kJ' ? 'kJ/mol' : st.unit === 'kcal' ? 'kcal/mol' : 'eV'}`);
    label.textContent = parts.join(' · ');
    label.title = s.comments[cur] ?? '';
    onFrame(cur);
    // the profile marker: throttle while playing
    if (!chartPending) {
      chartPending = window.setTimeout(() => {
        chartPending = 0;
        drawChart();
      }, playing ? 120 : 0);
    }
  }

  function tick(t: number): void {
    if (!playing) return;
    if (t - last >= 1000 / st.fps) {
      last = t;
      let next = cur + dir;
      if (next >= n || next < 0) {
        if (st.mode === 'once') {
          stop();
          return;
        }
        if (st.mode === 'bounce') {
          dir = -dir;
          next = cur + dir;
        } else next = next >= n ? 0 : n - 1;
      }
      go(next);
    }
    timer = requestAnimationFrame(tick);
  }

  function play(): void {
    if (n < 2) return;
    if (st.mode === 'once' && cur === n - 1) go(0);
    playing = true;
    playBtn.classList.add('on');
    playBtn.title = 'Pause';
    playBtn.replaceChildren(icon('pause'));
    timer = requestAnimationFrame(tick);
  }

  function stop(): void {
    playing = false;
    playBtn.classList.remove('on');
    playBtn.title = 'Play';
    playBtn.replaceChildren(icon('play'));
    if (timer) cancelAnimationFrame(timer);
    timer = 0;
  }

  go(0);
  return {
    el,
    frame: () => cur,
    setFrame: go,
    stop,
    dispose() {
      stop();
      if (chartPending) clearTimeout(chartPending);
      chart?.dispose();
    }
  };
}
