// Webview side of the "viewer" studio tab: a 3D molecule viewer (three.js)
// for .xyz / .allxyz / .out / .hess / .cube files with a trajectory player
// and energy profile, normal-mode animation, atom picking with distances,
// angles and dihedrals, and an orbital panel (MO levels, composition,
// excited states, isosurfaces from cube files). Brings the figures of the
// photoswitch project (scan envelopes, orbitals.png) into the studio.

import './viewer.css';
import type { IsoResult, ModeInfo, ModeResult, SourceFile, SourceList, StructureResult, ViewerNavigateArgs } from '../../../../src/studio/tabs/viewer/types';
import type { TabView, ViewContext } from '../../view';
import { badge, button, callout, card, dataTable, emptyState, iconButton, section, segmented, skeleton, split, toggle, type Column } from '../../ui/components';
import { h, mount } from '../../ui/dom';
import { elementSymbol, measurePicked } from '../geom/molecule';
import { MoleculeScene, type DrawStyle, type SceneOptions } from './scene';
import { createPlayer, type Player, type PlayerState } from './player';
import { isoMeshes, orbitalPanel, type OrbitalPanel, type OrbitalState } from './orbitals';

interface ViewerState {
  path?: string;
  extra: string[];
  filter: string;
  scene: SceneOptions;
  player: PlayerState;
  orb: OrbitalState;
  amplitude: number;
}

const DEFAULT_STATE: ViewerState = {
  extra: [],
  filter: '',
  scene: { style: 'ball', perspective: false, labels: false, dynamicBonds: true },
  player: { fps: 10, mode: 'loop', unit: 'kJ', preset: 'screen' },
  orb: { iso: 0.03, opacity: 0.75, spin: 'restricted' },
  amplitude: 0.35
};

const KIND_TONE: Record<string, 'info' | 'accent' | 'ok' | 'warn' | 'muted'> = { xyz: 'info', allxyz: 'accent', out: 'ok', hess: 'warn', cube: 'muted' };

function mount3d(root: HTMLElement, ctx: ViewContext) {
  const saved = ctx.state<Partial<ViewerState>>('viewer', {});
  const st: ViewerState = {
    ...DEFAULT_STATE,
    ...saved,
    scene: { ...DEFAULT_STATE.scene, ...saved.scene },
    player: { ...DEFAULT_STATE.player, ...saved.player },
    orb: { ...DEFAULT_STATE.orb, ...saved.orb }
  };
  const save = () => ctx.setState('viewer', st);

  let files: SourceFile[] = [];
  let capped = false;
  let listing = true;
  let structure: StructureResult | undefined;
  let loadError: string | undefined;
  let loading = false;
  let picked: number[] = [];
  let player: Player | undefined;
  let orbPanel: OrbitalPanel | undefined;
  let modeAnim = 0;
  let activeMode: number | undefined;
  let seq = 0;
  const disposers: (() => void)[] = [];

  // ------------------------------------------------------------- 3D views

  const scene = new MoleculeScene(st.scene, (i, add) => onPick(i, add));
  let second: MoleculeScene | undefined;
  const sceneGrid = h('div.viewer-scenes', null, scene.el);
  const sceneTitles = [h('div.viewer-scene-title'), h('div.viewer-scene-title')];
  scene.el.append(sceneTitles[0]);
  const measureBox = h('div.viewer-measure');
  scene.el.append(measureBox);
  scene.onCameraChange(() => second?.syncFrom(scene));

  function sideBySide(on: boolean): void {
    if (on && !second) {
      second = new MoleculeScene(st.scene, (i, add) => onPick(i, add));
      second.isoOpacity = st.orb.opacity;
      second.el.append(sceneTitles[1]);
      second.onCameraChange(() => scene.syncFrom(second!));
      sceneGrid.append(second.el);
      sceneGrid.classList.add('two');
      if (structure) second.setMolecule(structure.symbols, scene.coords(), false);
      second.setPicked(picked.map(i => i - 1));
      requestAnimationFrame(() => second?.syncFrom(scene));
    } else if (!on && second) {
      second.dispose();
      second = undefined;
      sceneGrid.classList.remove('two');
      sceneTitles[1].textContent = '';
    }
  }

  disposers.push(ctx.onTheme(() => {
    scene.setBackground();
    second?.setBackground();
    if (structure) scene.setOptions({});
  }));

  // ------------------------------------------------------------- picking

  function onPick(i: number, additive: boolean): void {
    if (i < 0) {
      if (picked.length) {
        picked = [];
        syncPick();
      }
      return;
    }
    const idx = i + 1;
    if (picked.includes(idx)) picked = picked.filter(x => x !== idx);
    else picked = additive || picked.length < 4 ? [...picked, idx].slice(-4) : [idx];
    syncPick();
  }

  function syncPick(): void {
    scene.setPicked(picked.map(i => i - 1));
    second?.setPicked(picked.map(i => i - 1));
    renderMeasure();
    renderPickSection();
  }

  function currentAtoms() {
    const xyz = scene.coords();
    return (structure?.symbols ?? []).map((symbol, i) => ({ index: i + 1, symbol, x: xyz[3 * i], y: xyz[3 * i + 1], z: xyz[3 * i + 2], px: 0, py: 0, depth: 0, radius: 1 }));
  }

  function renderMeasure(): void {
    if (!structure || picked.length === 0) {
      measureBox.replaceChildren();
      measureBox.hidden = true;
      return;
    }
    const atoms = currentAtoms();
    const names = picked.map(i => `${elementSymbol(structure!.symbols[i - 1])}${i}`).join('–');
    const v = picked.length >= 2 ? measurePicked(atoms, picked) : undefined;
    const kind = picked.length === 2 ? 'r' : picked.length === 3 ? 'θ' : picked.length === 4 ? 'φ' : '';
    const unit = picked.length === 2 ? 'Å' : '°';
    measureBox.hidden = false;
    measureBox.replaceChildren(h("span", null, names), ...(v !== undefined ? [h("strong", null, ` ${kind} = ${v.toFixed(picked.length === 2 ? 4 : 2)} ${unit}`)] : []));
  }

  // ------------------------------------------------------------- layout

  const fileHost = h('div.viewer-files');
  const displayHost = h('div.stack');
  const pickHost = h('div.stack');
  const sidebar = h('div.stack', null,
    section('Files', true,
      h('div.row', null,
        button('Open…', () => void addFiles(), { icon: 'plus', variant: 'ghost' }),
        iconButton('refresh', 'Rescan the workspace', () => void loadList())),
      h('input.input', { type: 'search', placeholder: 'Filter files', value: st.filter, oninput: (e: Event) => { st.filter = (e.target as HTMLInputElement).value; save(); renderFiles(); } }),
      fileHost),
    section('Display', true, displayHost),
    section('Picked atoms', true, pickHost));

  const headTitle = h('span.viewer-title');
  const headNote = h('span.muted.viewer-note');
  const viewActions = h('div.row.viewer-actions', null,
    iconButton('zoomReset', 'Fit molecule', () => scene.fit()),
    button('PNG', () => void savePng(), { variant: 'ghost', icon: 'image', title: 'Save a 3× resolution PNG on white' }),
    button('Report', () => void sendPng(), { variant: 'ghost', icon: 'send', title: 'Send the view to the report' }),
    button('.xyz', () => void saveXyz(), { variant: 'ghost', icon: 'download', title: 'Save the current frame as .xyz' }));
  const viewerCard = card({ title: '', class: 'viewer-card' }, h('div.viewer-head', null, h('div', null, headTitle, headNote), viewActions), sceneGrid);
  const playerHost = h('div');
  const modesHost = h('div');
  const orbHost = h('div');
  const mainCol = h('div.stack', null, viewerCard, playerHost, modesHost, orbHost);
  const emptyHost = h('div');
  mount(root, h('div.viewer', null, split(sidebar, h('div', null, emptyHost, mainCol), { sidebarWidth: 320 })));

  // ------------------------------------------------------------- sidebar

  function renderDisplay(): void {
    const styleOptions: { value: DrawStyle; label: string }[] = [
      { value: 'ball', label: 'Ball & stick' }, { value: 'licorice', label: 'Licorice' }, { value: 'spacefill', label: 'Spacefill' }, { value: 'wire', label: 'Wire' }
    ];
    const set = (o: Partial<SceneOptions>) => {
      Object.assign(st.scene, o);
      save();
      scene.setOptions(o);
      second?.setOptions(o);
      second?.syncFrom(scene);
    };
    mount(displayHost,
      segmented(styleOptions, st.scene.style, v => set({ style: v })),
      toggle('Perspective camera', st.scene.perspective, v => set({ perspective: v })),
      toggle('Atom labels', st.scene.labels, v => set({ labels: v })),
      toggle('Bonds follow the frame', st.scene.dynamicBonds, v => set({ dynamicBonds: v }), { hint: 'Recompute bonds from covalent radii in every frame (bond breaking along a path)' }),
      h('div.row', null,
        h('span.muted', null, 'View along'),
        button('x', () => scene.viewAxis('x'), { variant: 'ghost' }),
        button('y', () => scene.viewAxis('y'), { variant: 'ghost' }),
        button('z', () => scene.viewAxis('z'), { variant: 'ghost' })));
  }

  function renderPickSection(): void {
    const atoms = structure?.symbols ?? [];
    mount(pickHost,
      h('p.field-hint', null, 'Click atoms in the view (Shift+click adds) to measure: 2 atoms = distance, 3 = angle, 4 = dihedral.'),
      picked.length ? h('div.viewer-chips', null, picked.map((i, k) => h('span.viewer-chip.static', null, `${k + 1}: ${elementSymbol(atoms[i - 1] ?? '?')}${i}`))) : null,
      h('div.row', null,
        button('Align to plane', () => {
          if (!scene.alignTo(picked.map(i => i - 1))) ctx.toast('Pick 3 atoms (plane) or 4 atoms a–b–c–d (dihedral) first.', 'info');
        }, { variant: 'ghost', title: 'Look along the plane normal (4 atoms: like plot_orbitals.py, central bond horizontal)' }),
        picked.length ? button('Clear', () => { picked = []; syncPick(); }, { variant: 'ghost' }) : null,
        picked.length >= 2 && picked.length <= 4 && structure?.kind === 'xyz' && structure.frames.length > 1 ? button('Watch in Geometries', () => watchInGeom(), { variant: 'ghost', title: 'Open this coordinate as a distribution over the trajectory' }) : null));
  }

  function watchInGeom(): void {
    if (!structure) return;
    const name = picked.map(i => `${elementSymbol(structure!.symbols[i - 1])}${i}`).join('-');
    ctx.navigate('geom', { xyz: [structure.path], specs: [`${name}: ${picked.join('-')}`] });
  }

  function renderFiles(): void {
    if (listing && !files.length) {
      mount(fileHost, skeleton(4));
      return;
    }
    const words = st.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = files.filter(f => words.every(w => f.rel.toLowerCase().includes(w)));
    if (!shown.length) {
      mount(fileHost, h('p.muted', null, files.length ? 'No file matches the filter.' : 'No .xyz, .allxyz, .out, .hess or .cube files in the workspace.'));
      return;
    }
    const groups = new Map<string, SourceFile[]>();
    for (const f of shown.slice(0, 600)) {
      const g = groups.get(f.folder) ?? [];
      g.push(f);
      groups.set(f.folder, g);
    }
    mount(fileHost,
      [...groups].map(([folder, fs]) => h('div.viewer-group', null,
        h('div.viewer-group-head', null, folder === '.' ? '(workspace root)' : folder),
        fs.map(f => h('button.viewer-file', {
          type: 'button',
          class: f.path === st.path ? 'on' : '',
          title: f.rel,
          onclick: () => void open(f.path)
        }, h('span.viewer-file-name', null, f.rel.split('/').pop()), badge(f.kind, KIND_TONE[f.kind]))))),
      shown.length > 600 ? h('p.muted', null, `${shown.length - 600} more — refine the filter.`) : null,
      capped ? h('p.muted', null, 'File limit reached; refine viewerGlobs in the settings.') : null);
  }

  async function loadList(): Promise<void> {
    listing = true;
    renderFiles();
    try {
      const r = await ctx.rpc<SourceList>('list', { extra: [...new Set([...st.extra, ...(st.path ? [st.path] : [])])] });
      files = r.files;
      capped = r.capped;
    } catch (e) {
      ctx.toast(`Could not list files: ${e instanceof Error ? e.message : e}`, 'error');
    }
    listing = false;
    renderFiles();
  }

  async function addFiles(): Promise<void> {
    const picked = await ctx.rpc<string[]>('pick', {});
    if (!picked.length) return;
    st.extra = [...new Set([...st.extra, ...picked])].slice(-50);
    save();
    await loadList();
    await open(picked[0]);
  }

  // ------------------------------------------------------------- open

  function stopMode(): void {
    if (modeAnim) cancelAnimationFrame(modeAnim);
    modeAnim = 0;
    activeMode = undefined;
  }

  async function open(path: string, opts: { orbitals?: boolean; mode?: number } = {}): Promise<void> {
    const my = ++seq;
    st.path = path;
    save();
    loading = true;
    loadError = undefined;
    renderFiles();
    renderMain();
    try {
      const s = await ctx.rpc<StructureResult>('open', { path });
      if (my !== seq) return;
      structure = s;
    } catch (e) {
      if (my !== seq) return;
      structure = undefined;
      loadError = e instanceof Error ? e.message : String(e);
    }
    loading = false;
    stopMode();
    player?.dispose();
    player = undefined;
    orbPanel?.dispose();
    orbPanel = undefined;
    sideBySide(false);
    scene.setIsosurfaces([]);
    picked = [];
    if (structure) {
      scene.setMolecule(structure.symbols, structure.frames[0], true);
      scene.setPicked([]);
    }
    renderMain();
    renderPickSection();
    if (opts.mode !== undefined && structure?.modes?.some(m => m.index === opts.mode)) void animateMode(opts.mode);
    if (opts.orbitals) orbHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderMain(): void {
    if (!st.path) {
      mainCol.hidden = true;
      mount(emptyHost, emptyState('viewer', 'Open a structure', 'Pick an .xyz, .allxyz (relaxed scan), ORCA .out, .hess or .cube file on the left. Trajectories play with their energy profile; outputs with MO energies show orbitals and excited states.'));
      return;
    }
    if (loading && !structure) {
      mainCol.hidden = true;
      mount(emptyHost, card({}, skeleton(6)));
      return;
    }
    if (loadError) {
      mainCol.hidden = true;
      mount(emptyHost, callout('bad', loadError));
      return;
    }
    emptyHost.replaceChildren();
    mainCol.hidden = false;
    const s = structure!;
    headTitle.textContent = s.path.split(/[\\/]/).pop() ?? s.path;
    const facts = [`${s.symbols.length} atoms`, formula(s.symbols)];
    if (s.frames.length > 1) facts.push(`${s.totalFrames} frames${s.stride > 1 ? ` (every ${s.stride}th shown)` : ''}${s.truncated ? ', truncated' : ''}`);
    if (s.note) facts.push(s.note);
    headNote.textContent = ` · ${facts.join(' · ')}`;
    sceneTitles[0].textContent = '';

    // player
    if (s.frames.length > 1) {
      player = createPlayer(ctx, s, st.player, save, i => {
        stopMode();
        scene.setCoords(s.frames[i]);
        second?.setCoords(s.frames[i]);
        renderMeasure();
      });
      mount(playerHost, card({ title: 'Trajectory', subtitle: s.energies ? 'Frames with the energy profile (relative to the first frame)' : 'Frames' }, player.el));
    } else playerHost.replaceChildren();

    renderModes();

    // orbitals
    if (s.hasOrbitals || s.cubes.length) {
      orbPanel = orbitalPanel(ctx, { path: s.path, hasOrbitals: s.hasOrbitals, cubes: s.cubes }, st.orb, save, {
        show: (which, iso, title) => showIso(which, iso, title),
        opacity: v => {
          scene.setIsoOpacity(v);
          second?.setIsoOpacity(v);
        },
        sideBySide,
        picked: () => picked.slice(),
        symbols: () => structure?.symbols ?? []
      });
      mount(orbHost, card({ title: 'Orbitals', subtitle: s.hasOrbitals ? 'MO energies, composition and excited states; isosurfaces from cube files' : 'Isosurfaces of cube files' }, orbPanel.el));
    } else orbHost.replaceChildren();
    renderMeasure();
  }

  function showIso(which: 'main' | 'second', iso: IsoResult | undefined, title?: string): void {
    const target = which === 'main' ? scene : second;
    if (!target) return;
    target.isoOpacity = st.orb.opacity;
    target.setIsosurfaces(iso ? isoMeshes(iso) : []);
    sceneTitles[which === 'main' ? 0 : 1].textContent = iso ? title ?? '' : '';
    if (!iso && which === 'main') {
      second?.setIsosurfaces([]);
      sceneTitles[1].textContent = '';
    }
  }

  // ------------------------------------------------------------- modes

  function renderModes(): void {
    const s = structure;
    if (!s?.modes?.length) {
      modesHost.replaceChildren();
      return;
    }
    const cols: Column<ModeInfo>[] = [
      { key: 'index', label: 'Mode', numeric: true, align: 'right' },
      { key: 'freq', label: 'ν̃ / cm⁻¹', numeric: true, align: 'right', render: m => (m.freq < 0 ? h('span', null, `${Math.abs(m.freq).toFixed(1)}i `, badge('imag', 'bad')) : m.freq.toFixed(1)), sortValue: m => m.freq }
    ];
    const amp = h('input.viewer-range', {
      type: 'range', min: 0.05, max: 1.0, step: 0.05, value: String(st.amplitude), title: 'Largest atom displacement / Å',
      oninput: (e: Event) => { st.amplitude = Number((e.target as HTMLInputElement).value); save(); }
    });
    mount(modesHost, card({ title: 'Normal modes', subtitle: 'Click a mode to animate it', actions: [button('Stop', () => { stopMode(); resetFrame(); renderModes(); }, { variant: 'ghost', icon: 'stop' })] },
      h('div.row', null, h('span.muted', null, 'Amplitude'), amp),
      dataTable({ columns: cols, rows: s.modes, rowKey: m => String(m.index), selectedKey: activeMode !== undefined ? String(activeMode) : undefined, onRowClick: m => void animateMode(m.index), maxHeight: 240 })));
  }

  function resetFrame(): void {
    if (!structure) return;
    const f = structure.frames[player?.frame() ?? 0];
    scene.setCoords(f);
    second?.setCoords(f);
    renderMeasure();
  }

  async function animateMode(index: number): Promise<void> {
    if (!structure) return;
    player?.stop();
    let m: ModeResult;
    try {
      m = await ctx.rpc<ModeResult>('mode', { path: structure.path, index });
    } catch (e) {
      ctx.toast(`Mode ${index}: ${e instanceof Error ? e.message : e}`, 'error');
      return;
    }
    stopMode();
    activeMode = index;
    renderModes();
    const base = Float32Array.from(structure.frames[player?.frame() ?? 0]);
    let maxNorm = 0;
    for (let a = 0; a < base.length / 3; a++) maxNorm = Math.max(maxNorm, Math.hypot(m.vector[3 * a], m.vector[3 * a + 1], m.vector[3 * a + 2]));
    if (!(maxNorm > 0)) return;
    const xyz = new Float32Array(base.length);
    const t0 = performance.now();
    const step = (t: number) => {
      const s = (Math.sin(((t - t0) / 1000) * 2 * Math.PI * 0.8) * st.amplitude) / maxNorm;
      for (let k = 0; k < xyz.length; k++) xyz[k] = base[k] + s * m.vector[k];
      scene.setCoords(xyz);
      second?.setCoords(xyz);
      modeAnim = requestAnimationFrame(step);
    };
    modeAnim = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------- export

  function baseName(): string {
    const n = (structure?.path.split(/[\\/]/).pop() ?? 'structure').replace(/\.[^.]+$/, '');
    return structure && structure.frames.length > 1 ? `${n}_frame${(player?.frame() ?? 0) + 1}` : n;
  }

  async function savePng(): Promise<void> {
    if (!structure) return;
    const data = scene.snapshot(3, '#ffffff');
    const p = await ctx.studio('saveFile', { defaultName: `${baseName()}.png`, data, encoding: 'base64', filters: { 'PNG image': ['png'] } });
    if (p) ctx.toast(`Saved ${p.split(/[\\/]/).pop()}`, 'success');
  }

  async function sendPng(): Promise<void> {
    if (!structure) return;
    const png = scene.snapshot(3, '#ffffff');
    await ctx.studio('sendToReport', { name: baseName(), caption: `${baseName().replace(/_/g, ' ')}.`, png });
  }

  async function saveXyz(): Promise<void> {
    if (!structure) return;
    const xyz = scene.coords();
    const lines = [String(structure.symbols.length), structure.comments[player?.frame() ?? 0] ?? baseName()];
    structure.symbols.forEach((s, i) => lines.push(`${elementSymbol(s).padEnd(3)} ${xyz[3 * i].toFixed(6).padStart(12)} ${xyz[3 * i + 1].toFixed(6).padStart(12)} ${xyz[3 * i + 2].toFixed(6).padStart(12)}`));
    const p = await ctx.studio('saveFile', { defaultName: `${baseName()}.xyz`, data: lines.join('\n') + '\n', filters: { 'XYZ': ['xyz'] } });
    if (p) ctx.toast(`Saved ${p.split(/[\\/]/).pop()}`, 'success');
  }

  // ------------------------------------------------------------- start

  renderDisplay();
  renderPickSection();
  renderMain();
  void loadList();
  if (st.path) void open(st.path);

  return {
    onNavigate(raw: unknown) {
      const a = (raw ?? {}) as ViewerNavigateArgs;
      if (typeof a.file === 'string') {
        if (!st.extra.includes(a.file)) st.extra = [...st.extra, a.file].slice(-50);
        void open(a.file, { orbitals: a.orbitals, mode: typeof a.mode === 'number' ? a.mode : undefined }).then(() => loadList());
      }
    },
    onShow() {
      scene.invalidate();
      second?.invalidate();
    },
    onHide() {
      player?.stop();
      stopMode();
    },
    dispose() {
      stopMode();
      player?.dispose();
      orbPanel?.dispose();
      second?.dispose();
      scene.dispose();
      disposers.forEach(d => d());
    }
  };
}

function formula(symbols: string[]): string {
  const c = new Map<string, number>();
  for (const s of symbols) c.set(elementSymbol(s), (c.get(elementSymbol(s)) ?? 0) + 1);
  const order = [...c.keys()].sort((a, b) => (a === 'C' ? -1 : b === 'C' ? 1 : a === 'H' ? -1 : b === 'H' ? 1 : a.localeCompare(b)));
  const sub = (n: number) => (n === 1 ? '' : String(n).replace(/\d/g, d => '₀₁₂₃₄₅₆₇₈₉'[+d]));
  return order.map(e => `${e}${sub(c.get(e)!)}`).join('');
}

export const view: TabView = {
  mount(root, ctx) {
    return mount3d(root, ctx);
  }
};
