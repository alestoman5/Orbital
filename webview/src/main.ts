// Orbital Studio shell: navigation rail, tab header, lazy tab mounting,
// theme tracking, and routing of 'navigate' events from the host.

import './styles/main.css';
import type { NavigatePayload, StudioMethods, TabId } from '../../src/studio/protocol';
import { TABS, TabEntry } from './registry';
import { getState, onEvent, request, setState, signalReady } from './rpc';
import { icon, toast } from './ui/components';
import { h, mount } from './ui/dom';
import type { TabInstance, ThemeKind, ViewContext } from './view';

const app = document.getElementById('app')!;
const assetBase = app.dataset.assetBase ?? './';

// --- theme --------------------------------------------------------------------

function currentTheme(): ThemeKind {
  const c = document.body.classList;
  return c.contains('vscode-high-contrast') && !c.contains('vscode-high-contrast-light') ? 'high-contrast'
    : c.contains('vscode-light') || c.contains('vscode-high-contrast-light') ? 'light' : 'dark';
}
const themeListeners = new Set<(k: ThemeKind) => void>();
let lastTheme = currentTheme();
new MutationObserver(() => {
  const t = currentTheme();
  if (t !== lastTheme) {
    lastTheme = t;
    themeListeners.forEach(cb => cb(t));
  }
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

// --- tabs ---------------------------------------------------------------------

interface Mounted {
  entry: TabEntry;
  root: HTMLElement;
  actions: HTMLElement;
  instance: TabInstance | void;
}

const mounted = new Map<TabId, Mounted>();
let active: TabId | undefined;

const nav = h('nav.rail', { 'aria-label': 'Studio sections' });
const header = h('header.tab-header');
const content = h('main.tab-content');
mount(app, h('div.shell', null, nav, h('div.stage', null, header, content)));

function renderNav(): void {
  const groups: [TabEntry['group'], string][] = [['analyze', 'Analyze'], ['create', 'Create']];
  mount(nav,
    h('div.brand', { title: 'Orbital Studio' }, icon('orbital', 'icon brand-mark'), h('span.brand-name', null, 'Orbital', h('b', null, ' Studio'))),
    groups.map(([g, label]) => [
      h('div.rail-group', null, label),
      TABS.filter(t => t.group === g).map(t =>
        h('button.rail-item', {
          class: t.id === active ? 'on' : '', title: t.subtitle, 'aria-current': t.id === active ? 'page' : undefined, type: 'button',
          onclick: () => show(t.id)
        }, icon(t.icon), h('span', null, t.title)))
    ])
  );
}

function contextFor(entry: TabEntry, actions: HTMLElement): ViewContext {
  const ns = `tab:${entry.id}:`;
  return {
    tab: entry.id,
    rpc: <T>(method: string, params?: unknown) => request<T>(entry.id, method, params),
    studio: <K extends keyof StudioMethods>(method: K, params: StudioMethods[K]['params']) =>
      request<StudioMethods[K]['result']>('studio', method, params),
    on: (name, cb) => onEvent(entry.id, name, cb),
    state: (key, fallback) => getState(ns + key, fallback),
    setState: (key, value) => setState(ns + key, value),
    theme: currentTheme,
    onTheme: cb => {
      themeListeners.add(cb);
      return () => themeListeners.delete(cb);
    },
    assetBase,
    toast,
    navigate: (tab, args) => show(tab, args),
    setActions: (...nodes) => mount(actions, nodes)
  };
}

function show(id: TabId, args?: unknown): void {
  const entry = TABS.find(t => t.id === id) ?? TABS[0];
  if (active && active !== entry.id) {
    const prev = mounted.get(active);
    prev?.instance?.onHide?.();
    if (prev) {
      prev.root.hidden = true;
      prev.actions.hidden = true;
    }
  }
  let m = mounted.get(entry.id);
  const fresh = !m;
  if (!m) {
    const root = h('div.tab-root', { dataset: { tab: entry.id } });
    const actions = h('div.tab-actions');
    content.appendChild(root);
    m = { entry, root, actions, instance: undefined };
    mounted.set(entry.id, m);
    try {
      m.instance = entry.view.mount(root, contextFor(entry, actions));
    } catch (e) {
      console.error(e);
      root.append(h('pre.code', null, `Failed to load ${entry.title}: ${e instanceof Error ? e.stack : String(e)}`));
    }
  }
  active = entry.id;
  setState('activeTab', entry.id);
  m.root.hidden = false;
  m.actions.hidden = false;
  mount(header,
    h('div.tab-title', null, icon(entry.icon, 'icon tab-icon'), h('div', null, h('h1', null, entry.title), h('p', null, entry.subtitle))),
    h('div.tab-header-actions', null, [...mounted.values()].map(x => x.actions)));
  renderNav();
  if (!fresh) {
    m.instance?.onShow?.();
  }
  if (args !== undefined) {
    m.instance?.onNavigate?.(args);
  }
}

onEvent('studio', 'navigate', p => {
  const nav = p as NavigatePayload;
  show(nav.tab, nav.args);
});

const initial = (new URLSearchParams(location.search).get('tab') as TabId | null) ?? getState<TabId>('activeTab', 'spectra');
show(TABS.some(t => t.id === initial) ? initial : 'spectra');
signalReady();
