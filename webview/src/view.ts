// Contract between the studio shell (main.ts) and a tab's webview side
// (webview/src/tabs/<tab>/index.ts).

import type { StudioMethods, TabId } from '../../src/studio/protocol';

export type ThemeKind = 'dark' | 'light' | 'high-contrast';

export interface ViewContext {
  readonly tab: TabId;
  /** Call a method of this tab's host (src/studio/tabs/<tab>/host.ts). */
  rpc<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Call a shell method shared by all tabs (save file, open file, confirm, ...). */
  studio<K extends keyof StudioMethods>(method: K, params: StudioMethods[K]['params']): Promise<StudioMethods[K]['result']>;
  /** Host event sent to this tab (HostContext.post); returns the unsubscribe function. */
  on(name: string, cb: (payload: any) => void): () => void;
  /** Small persisted state, namespaced per tab (form values, selections). */
  state<T>(key: string, fallback: T): T;
  setState(key: string, value: unknown): void;
  /** Current VS Code theme kind, and a subscription to changes. */
  theme(): ThemeKind;
  onTheme(cb: (kind: ThemeKind) => void): () => void;
  /** Base URL of out/webview/ (for pdf.worker.min.mjs etc.), ends with '/'. */
  readonly assetBase: string;
  /** Short non-modal message in the studio's corner. */
  toast(message: string, level?: 'info' | 'success' | 'warning' | 'error', action?: { label: string; run(): void }): void;
  /** Switch to another tab. */
  navigate(tab: TabId, args?: unknown): void;
  /** Buttons shown on the right of the tab header (replaces the previous ones). */
  setActions(...actions: Node[]): void;
}

export interface TabInstance {
  /** Arguments from a command / another tab (e.g. files to preselect). */
  onNavigate?(args: unknown): void;
  /** The tab became visible again (refresh stale data here). */
  onShow?(): void;
  onHide?(): void;
  dispose?(): void;
}

export interface TabView {
  /** Called the first time the tab is shown; `root` is empty and owned by the tab. */
  mount(root: HTMLElement, ctx: ViewContext): TabInstance | void;
}
