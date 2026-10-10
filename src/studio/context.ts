// What a tab's host side may use. Tab handlers get a HostContext instead of
// importing `vscode`, so the same handler code runs inside VS Code
// (src/studio/vscodeContext.ts) and in the browser dev harness
// (webview/dev/server.mjs, plain Node) — and is unit-testable.

import type {
  ConfirmParams,
  NotifyParams,
  OpenFileParams,
  PickFilesParams,
  RunInTerminalParams,
  SaveFileParams,
  SaveFileResult,
  TabId
} from './protocol';

export interface Disposable {
  dispose(): void;
}

export interface FindFilesOptions {
  /** Absolute folder the glob is relative to; default: every workspace folder. */
  base?: string;
  /** Glob of paths to skip; default: the orcaInp.runs.exclude setting. */
  exclude?: string;
  /** Stop after this many matches. */
  max?: number;
}

export interface HostContext {
  /** The tab this context belongs to; `post` sends events to it. */
  readonly tab: TabId;
  /** Absolute path of the installed extension (to find python/ml_worker.py etc.). */
  readonly extensionPath: string;

  workspaceFolders(): string[];
  /**
   * Per-workspace scratch folder `<first workspace folder>/.orbital` (ML runs,
   * report backups). Created on first call. Undefined without a workspace.
   */
  storageDir(): string | undefined;

  /** `orcaInp.<key>` setting, e.g. config('studio.spectraGlobs', []). */
  config<T>(key: string, fallback: T): T;

  /** Absolute paths matching a glob, naturally sorted. */
  findFiles(include: string, options?: FindFilesOptions): Promise<string[]>;
  /** Calls onChange (debounced by the caller if needed) when a matching file changes. */
  watch(include: string, onChange: (path: string) => void, base?: string): Disposable;

  /** Event to this tab's webview side. */
  post(name: string, payload?: unknown): void;
  /** Switch the studio to another tab. */
  navigate(tab: TabId, args?: unknown): void;

  saveFile(params: SaveFileParams): Promise<SaveFileResult>;
  openFile(params: OpenFileParams): Promise<void>;
  pickFiles(params: PickFilesParams): Promise<string[]>;
  confirm(params: ConfirmParams): Promise<boolean>;
  notify(params: NotifyParams): void;
  /** Types a command into an integrated terminal (dev harness: logs it). */
  runInTerminal(params: RunInTerminalParams): void;
  /** File of the active (or most recently active) text editor, if any. */
  activeEditorPath(): string | undefined;
  /** Line in the "Orbital Studio" output channel (stderr in the dev harness). */
  log(message: string): void;
}

/** A host-side method; params come straight from the webview (validate them). */
export type HostMethod = (params: any, ctx: HostContext) => unknown | Promise<unknown>;

export interface TabHost {
  id: TabId;
  methods: Record<string, HostMethod>;
  /**
   * Called once per panel when the studio opens. Return a Disposable to stop
   * watchers or timers when the panel closes.
   */
  activate?(ctx: HostContext): Disposable | void;
}
