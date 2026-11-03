// Orbital panel of the viewer tab: MO level diagram and table (energies,
// occupations, c² composition per element, π fraction relative to a picked
// plane — photoswitch scripts/mo_character.py), excited states with their
// main i → a excitations (click one to see both orbitals side by side), the
// isovalue / opacity of the isosurfaces, and a %plots block for MOs that
// have no cube file yet.

import type { CubeRef, IsoResult, LevelRow, OrbitalSetView, OrbitalsResult, PlotsBlockResult, StateRow } from '../../../../src/studio/tabs/viewer/types';
import { figureToolbar, render, type ChartHandle, type Figure, type ToolbarHost } from '../../charts';
import { badge, button, callout, codeBlock, dataTable, emptyState, field, numberInput, segmented, skeleton, type Column } from '../../ui/components';
import { h, mount } from '../../ui/dom';
import type { ViewContext } from '../../view';
import { ISO_NEG, ISO_POS, type MeshData } from './scene';

export interface OrbitalHooks {
  /** Show isosurfaces in the main view (`which` = 'main') or the second view; undefined clears. */
  show(which: 'main' | 'second', iso: IsoResult | undefined, title?: string): void;
  opacity(v: number): void;
  /** Turn the side-by-side view on or off. */
  sideBySide(on: boolean): void;
  /** 1-based atoms picked in the 3D view. */
  picked(): number[];
  symbols(): string[];
}

export interface OrbitalState {
  iso: number;
  opacity: number;
  spin: 'restricted' | 'alpha' | 'beta';
  plane?: number[];
}

export interface OrbitalPanel {
  el: HTMLElement;
  dispose(): void;
}

export function isoMeshes(r: IsoResult): { mesh: MeshData; color: string }[] {
  return [{ mesh: r.positive, color: ISO_POS }, { mesh: r.negative, color: ISO_NEG }];
}

const pct = (v: number | undefined) => (v === undefined ? '–' : `${Math.round(v * 100)} %`);

export function orbitalPanel(ctx: ViewContext, source: { path: string; hasOrbitals: boolean; cubes: CubeRef[] }, st: OrbitalState, save: () => void, hooks: OrbitalHooks): OrbitalPanel {
  let data: OrbitalsResult | undefined;
  let error: string | undefined;
  let shownMain: string | undefined;
  let shownSecond: string | undefined;
  let selectedMo: number | undefined;
  let chart: ChartHandle | undefined;
  let hoverY: number | undefined;
  let disposed = false;
  const plotsSel = new Set<string>();

  const isoHost = h('div.viewer-iso-controls');
  const diagramBox = h('div.viewer-levels-plot');
  const levelsHost = h('div');
  const statesHost = h('div');
  const plotsHost = h('div');
  const status = h('div.viewer-orb-status');
  const el = h('div.stack', null, status, isoHost, levelsHost, statesHost, plotsHost);

  const set = (): OrbitalSetView | undefined => data?.sets.find(s => s.spin === st.spin) ?? data?.sets[0];
  const cubeOf = (mo: number, spin: 'a' | 'b' = st.spin === 'beta' ? 'b' : 'a') =>
    source.cubes.find(c => c.mo === mo && (c.spin ?? 'a') === spin)?.path;

  // ------------------------------------------------------------- isosurfaces

  async function showCube(path: string, which: 'main' | 'second', title: string): Promise<void> {
    try {
      const r = await ctx.rpc<IsoResult>('isosurface', { path, iso: st.iso });
      if (disposed) return;
      const syms = hooks.symbols();
      if (r.atoms.length && syms.length && r.atoms.length !== syms.length) {
        ctx.toast(`${title}: the cube file has ${r.atoms.length} atoms, the structure ${syms.length}.`, 'warning');
      }
      if (which === 'main') shownMain = path;
      else shownSecond = path;
      hooks.show(which, r, title);
      const tri = (r.positive.indices.length + r.negative.indices.length) / 3;
      status.replaceChildren(h('span.muted', null, `${title}: ±${r.iso} (max |ψ| ${r.absMax.toFixed(3)}), ${tri.toLocaleString()} triangles${r.step > 1 ? `, grid subsampled ×${r.step}` : ''}`));
    } catch (e) {
      ctx.toast(`Isosurface failed: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  function rerenderIso(): void {
    const mainTitle = selectedMo !== undefined ? `MO ${selectedMo}` : 'cube';
    if (shownMain) void showCube(shownMain, 'main', mainTitle);
    if (shownSecond) void showCube(shownSecond, 'second', 'acceptor MO');
  }

  function renderIsoControls(): void {
    mount(isoHost,
      h('div.row.viewer-iso-row', null,
        field('Isovalue', numberInput(st.iso, v => {
          st.iso = Math.max(1e-5, Math.abs(v));
          save();
          rerenderIso();
        }, { min: 0.0001, step: 0.005 }), 'a.u. (photoswitch figures: 0.03)'),
        field('Opacity', h('input.viewer-range', {
          type: 'range', min: 0.2, max: 1, step: 0.05, value: String(st.opacity),
          oninput: (e: Event) => {
            st.opacity = Number((e.target as HTMLInputElement).value);
            save();
            hooks.opacity(st.opacity);
          }
        })),
        h('div.viewer-iso-legend', null, h('span.swatch', { style: { background: ISO_POS } }), '+', h('span.swatch', { style: { background: ISO_NEG } }), '−'),
        button('Clear', () => {
          shownMain = shownSecond = undefined;
          hooks.show('main', undefined);
          hooks.sideBySide(false);
          status.replaceChildren();
        }, { variant: 'ghost' })));
  }

  // ------------------------------------------------------------- cube-only source

  function renderCubeList(): void {
    if (!source.cubes.length) return;
    const rows = source.cubes;
    const cols: Column<CubeRef>[] = [
      { key: 'name', label: 'Cube file' },
      { key: 'mo', label: 'MO', numeric: true, align: 'right', render: r => (r.mo === undefined ? '–' : `${r.mo}${r.spin === 'b' ? 'β' : ''}`) }
    ];
    mount(levelsHost, dataTable({ columns: cols, rows, rowKey: r => r.path, onRowClick: r => void showCube(r.path, 'main', r.name), selectedKey: shownMain, maxHeight: 260 }));
  }

  // ------------------------------------------------------------- levels

  function levelName(l: LevelRow, homo: number): string {
    if (l.index === homo) return 'HOMO';
    if (l.index === homo + 1) return 'LUMO';
    if (l.index < homo) return `HOMO−${homo - l.index}`;
    return `LUMO+${l.index - homo - 1}`;
  }

  function compositionText(l: LevelRow): string {
    if (!l.elements) return '';
    return Object.entries(l.elements).sort((a, b) => b[1] - a[1]).filter(e => e[1] >= 0.03).slice(0, 4).map(([k, v]) => `${k} ${Math.round(v * 100)}`).join(' · ');
  }

  function pickLevel(l: LevelRow): void {
    selectedMo = l.index;
    const cube = l.cube ?? cubeOf(l.index);
    hooks.sideBySide(false);
    shownSecond = undefined;
    if (cube) void showCube(cube, 'main', `MO ${l.index} (${levelName(l, set()!.homo)})`);
    else {
      plotsSel.add(String(l.index));
      ctx.toast(`No cube file for MO ${l.index}. Add it to the %plots block below and rerun ORCA.`, 'info');
      renderPlots();
    }
    renderLevels();
  }

  function windowOf(s: OrbitalSetView): LevelRow[] {
    const lo = Math.max(0, s.homo - 10);
    const hi = s.homo + 11;
    return s.levels.filter(l => l.index >= lo && l.index <= hi);
  }

  function diagram(s: OrbitalSetView): Figure {
    const win = windowOf(s);
    const occ = win.filter(l => l.occ > 1e-6);
    const virt = win.filter(l => l.occ <= 1e-6);
    const seg = (ls: LevelRow[]) => {
      const x: number[] = [];
      const y: number[] = [];
      for (const l of ls) x.push(0.15, 0.85, NaN), y.push(l.energyEv, l.energyEv, NaN);
      return { x, y };
    };
    const o = seg(occ);
    const v = seg(virt);
    const homo = s.levels.find(l => l.index === s.homo);
    const lumo = s.levels.find(l => l.index === s.homo + 1);
    const series: Figure['panels'][number]['series'] = [
      { type: 'line', x: o.x, y: o.y, width: 2, label: 'occupied' },
      { type: 'line', x: v.x, y: v.y, width: 2, label: 'virtual', dash: 'solid' }
    ];
    if (homo) series.push({ type: 'text', x: 0.88, y: homo.energyEv, text: `HOMO ${homo.index}`, anchor: 'start' });
    if (lumo) series.push({ type: 'text', x: 0.88, y: lumo.energyEv, text: `LUMO ${lumo.index}`, anchor: 'start' });
    const sel = selectedMo !== undefined ? s.levels.find(l => l.index === selectedMo) : undefined;
    if (sel) series.push({ type: 'hline', value: sel.energyEv, dash: 'dotted', color: 'var(--accent)' });
    if (homo && lumo) series.push({ type: 'text', x: 0.5, y: (homo.energyEv + lumo.energyEv) / 2, text: `gap ${(lumo.energyEv - homo.energyEv).toFixed(2)} eV`, anchor: 'middle' });
    return {
      panels: [{ x: { min: 0, max: 1.35, hideTickLabels: true, grid: false, ticks: [] }, y: { label: 'E / eV', zero: false }, series, legend: 'none' }],
      size: { widthIn: 2.4, heightIn: 3.4 }
    };
  }

  function renderLevels(): void {
    const s = set();
    if (!s) return;
    const fig = diagram(s);
    if (chart) chart.update(fig);
    else {
      chart = render(diagramBox, fig, {
        readout: (_p, _x, y) => {
          hoverY = y;
          const l = nearestLevel(y);
          return l ? `MO ${l.index}: ${l.energyEv.toFixed(2)} eV` : `${y.toFixed(2)} eV`;
        }
      });
      diagramBox.addEventListener('click', () => {
        const l = hoverY !== undefined ? nearestLevel(hoverY) : undefined;
        if (l) pickLevel(l);
      });
    }
    const cols: Column<LevelRow>[] = [
      { key: 'index', label: 'MO', numeric: true, align: 'right' },
      { key: 'name', label: '', render: r => levelName(r, s.homo), sortValue: r => r.index },
      { key: 'energyEv', label: 'E / eV', numeric: true, align: 'right', render: r => r.energyEv.toFixed(3) },
      { key: 'occ', label: 'occ', numeric: true, align: 'right', render: r => r.occ.toFixed(r.occ % 1 ? 3 : 0) }
    ];
    if (data?.hasCoefficients) {
      cols.push({ key: 'comp', label: 'c² by element / %', render: r => compositionText(r), sortValue: r => compositionText(r), title: 'Fraction of c² per element' });
      if (data.plane) cols.push({ key: 'pi', label: 'π', numeric: true, align: 'right', render: r => pct(r.pi), sortValue: r => r.pi ?? -1, title: 'Fraction of c² in p functions along the plane normal' });
    }
    cols.push({ key: 'cube', label: 'cube', align: 'center', render: r => (r.cube ?? cubeOf(r.index) ? badge('cube', 'ok') : h('span.muted', null, '–')), sortValue: r => (r.cube ? 1 : 0) });
    const win = windowOf(s);
    const allRows = s.levels;
    const showAll = st.spin === s.spin && (levelsHost.dataset.all === '1');
    const table = dataTable({
      columns: cols,
      rows: showAll ? allRows : win,
      rowKey: r => String(r.index),
      selectedKey: selectedMo !== undefined ? String(selectedMo) : undefined,
      onRowClick: r => pickLevel(r),
      rowClass: r => (r.index === s.homo || r.index === s.homo + 1 ? 'viewer-frontier' : ''),
      maxHeight: 340,
      filterText: r => `${r.index} ${levelName(r, s.homo)} ${compositionText(r)}`,
      filterPlaceholder: 'Filter MOs (index, HOMO, N …)'
    });
    const planeRow = data?.hasCoefficients
      ? h('div.row.viewer-plane-row', null,
          button(data.plane ? `π plane: atoms ${data.plane.join('–')}` : 'π fraction: use picked atoms as plane', () => void setPlane(), { variant: 'ghost', title: 'Pick 3 atoms (plane) or 4 atoms a–b–c–d (normal (a−b)×(d−c), as mo_character.py) in the 3D view first' }),
          data.plane ? button('Clear plane', () => { st.plane = undefined; save(); void load(); }, { variant: 'ghost' }) : null,
          h('span.muted', null, data.orthogonalBasis ? `${data.method}: orthogonal basis, c² is a population` : 'non-orthogonal basis: c² ignores overlap (qualitative)'))
      : callout('info', 'Print the MO coefficients (', h('code', null, '%output print[p_mos] 1 end'), ') to get the composition and π character of each MO.');
    const spinSel = data && data.sets.length > 1
      ? segmented(data.sets.map(x => ({ value: x.spin, label: x.spin === 'alpha' ? 'α' : x.spin === 'beta' ? 'β' : 'MOs' })), st.spin, v => { st.spin = v; save(); chart?.dispose(); chart = undefined; renderAll(); })
      : null;
    mount(levelsHost,
      h('div.viewer-levels', null,
        h('div.viewer-levels-diagram', null, diagramBox,
          figureToolbar({ figure: () => diagram(s), name: 'mo-levels', host: ctx as unknown as ToolbarHost, caption: () => `MO energies around the frontier orbitals (${data?.method ?? 'ORCA'}).` })),
        h('div.viewer-levels-table', null,
          h('div.row', null, spinSel,
            button(showAll ? `Frontier window` : `All ${allRows.length} MOs`, () => { levelsHost.dataset.all = showAll ? '0' : '1'; renderLevels(); }, { variant: 'ghost' })),
          table, planeRow)));
  }

  function nearestLevel(y: number): LevelRow | undefined {
    const s = set();
    if (!s) return undefined;
    let best: LevelRow | undefined;
    let bd = Infinity;
    for (const l of windowOf(s)) {
      const d = Math.abs(l.energyEv - y);
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    return best;
  }

  async function setPlane(): Promise<void> {
    const p = hooks.picked();
    if (p.length < 3 || p.length > 4) {
      ctx.toast('Pick 3 or 4 atoms in the 3D view (click, Shift+click to add).', 'info');
      return;
    }
    st.plane = p.slice();
    save();
    await load();
  }

  // ------------------------------------------------------------- states

  function renderStates(): void {
    if (!data?.states.length) {
      statesHost.replaceChildren();
      return;
    }
    const chip = (s: StateRow, c: StateRow['contributions'][number]) =>
      h('button.viewer-chip', {
        type: 'button',
        title: `Show MO ${c.from} and MO ${c.to} side by side`,
        onclick: (e: Event) => {
          e.stopPropagation();
          void showTransition(s, c);
        }
      }, `${c.from}${c.spin === 'b' ? 'β' : ''} → ${c.to}${c.spin === 'b' ? 'β' : ''}`, h('span.muted.viewer-chip-w', null, c.weight.toFixed(2)));
    const cols: Column<StateRow>[] = [
      { key: 'state', label: 'State', render: r => `${r.multiplicity === 'triplet' ? 'T' : 'S'}${r.state}`, sortValue: r => r.state },
      { key: 'energyEv', label: 'ΔE / eV', numeric: true, align: 'right', render: r => r.energyEv.toFixed(3) },
      { key: 'wavelengthNm', label: 'λ / nm', numeric: true, align: 'right', render: r => (Number.isFinite(r.wavelengthNm) ? r.wavelengthNm.toFixed(1) : '–') },
      { key: 'fosc', label: 'f', numeric: true, align: 'right', render: r => (r.fosc === undefined ? '–' : r.fosc.toFixed(4)), sortValue: r => r.fosc ?? -1 },
      { key: 'main', label: 'Main excitations (weight)', render: r => h('div.viewer-chips', null, r.contributions.filter(c => c.weight >= 0.05).slice(0, 4).map(c => chip(r, c))), sortValue: r => r.contributions[0]?.weight ?? 0 }
    ];
    mount(statesHost, h('div.viewer-states', null,
      h('h3.viewer-subhead', null, `Excited states (${data.states[0].method})`),
      dataTable({ columns: cols, rows: data.states, rowKey: r => `${r.multiplicity}${r.state}`, maxHeight: 280 }),
      h('p.field-hint', null, 'Click an excitation i → a to show the donor and acceptor orbitals side by side (cameras linked).')));
  }

  async function showTransition(s: StateRow, c: StateRow['contributions'][number]): Promise<void> {
    const a = cubeOf(c.from, c.spin);
    const b = cubeOf(c.to, c.spin);
    if (!a || !b) {
      plotsSel.add(String(c.from));
      plotsSel.add(String(c.to));
      renderPlots();
      ctx.toast(`Cube files missing for MO ${!a ? c.from : ''}${!a && !b ? ' and ' : ''}${!b ? c.to : ''}. Added to the %plots block.`, 'info');
      return;
    }
    selectedMo = c.from;
    hooks.sideBySide(true);
    await showCube(a, 'main', `${s.multiplicity === 'triplet' ? 'T' : 'S'}${s.state}: donor MO ${c.from}`);
    await showCube(b, 'second', `acceptor MO ${c.to}`);
    renderLevels();
  }

  // ------------------------------------------------------------- %plots

  function renderPlots(): void {
    const s = set();
    if (!s) {
      plotsHost.replaceChildren();
      return;
    }
    if (!plotsSel.size) {
      for (let k = s.homo - 2; k <= s.homo + 3; k++) if (k >= 0 && !cubeOf(k)) plotsSel.add(String(k));
    }
    const missing = [...plotsSel].map(Number).filter(n => Number.isInteger(n)).sort((x, y) => x - y);
    const out = h('div');
    const input = h('input.input.mono', { value: missing.join(' '), placeholder: 'MO indices, e.g. 29 33 34', onchange: (e: Event) => {
      plotsSel.clear();
      for (const t of (e.target as HTMLInputElement).value.split(/[\s,;]+/)) {
        const r = /^(\d+)-(\d+)$/.exec(t);
        if (r) for (let k = +r[1]; k <= +r[2] && k - +r[1] < 200; k++) plotsSel.add(String(k));
        else if (/^\d+$/.test(t)) plotsSel.add(t);
      }
      void build();
    } });
    async function build(): Promise<void> {
      const mos = [...plotsSel].map(Number).filter(Number.isInteger);
      if (!mos.length) {
        out.replaceChildren();
        return;
      }
      try {
        const r = await ctx.rpc<PlotsBlockResult>('plotsBlock', { path: source.path, mos });
        mount(out, codeBlock(r.text, { maxHeight: 220 }),
          r.input ? button(`Open ${r.input.split(/[\\/]/).pop()}`, () => void ctx.studio('openFile', { path: r.input!, beside: true }), { variant: 'ghost', icon: 'file' }) : null);
      } catch (e) {
        mount(out, callout('bad', String(e instanceof Error ? e.message : e)));
      }
    }
    mount(plotsHost, h('details.viewer-plots', { open: missing.length > 0 && !source.cubes.length },
      h('summary', null, `Cube files for more MOs (%plots block)`),
      h('p.field-hint', null, `Add this block to the input and rerun ORCA (ZINDO/S: < 1 s). Indices are ORCA's 0-based MO numbers; cube files named <base>_moN.cube are picked up automatically.`),
      field('MOs', input), out));
    void build();
  }

  // ------------------------------------------------------------- load

  function renderAll(): void {
    renderIsoControls();
    if (!source.hasOrbitals) {
      if (source.cubes.length) renderCubeList();
      else mount(levelsHost, emptyState('orbital', 'No orbitals', 'This file has no ORBITAL ENERGIES table and no cube files next to it.'));
      return;
    }
    if (error) {
      mount(levelsHost, callout('bad', error));
      return;
    }
    if (!data) {
      mount(levelsHost, skeleton(4));
      return;
    }
    renderLevels();
    renderStates();
    renderPlots();
  }

  async function load(): Promise<void> {
    if (!source.hasOrbitals) {
      renderAll();
      return;
    }
    try {
      data = await ctx.rpc<OrbitalsResult>('orbitals', { path: source.path, plane: st.plane });
      error = undefined;
      if (!data.sets.some(s => s.spin === st.spin)) st.spin = data.sets[0]?.spin ?? 'restricted';
    } catch (e) {
      error = `Could not read orbitals: ${e instanceof Error ? e.message : e}`;
    }
    if (!disposed) renderAll();
  }

  renderAll();
  void load();
  // a single cube file opened directly: show it right away
  if (!source.hasOrbitals && source.cubes.length === 1 && /\.cube?$/i.test(source.path)) void showCube(source.cubes[0].path, 'main', source.cubes[0].name);

  return {
    el,
    dispose() {
      disposed = true;
      chart?.dispose();
    }
  };
}
