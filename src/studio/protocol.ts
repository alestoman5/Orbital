// Message protocol between the Orbital Studio webview and the extension
// host. Shared by both sides (the webview bundle imports this file too), so
// it must stay free of `vscode`, Node and DOM imports.
//
// The webview calls host methods with a request/response RPC
// (`rpc(tab, method, params)`); the host pushes unsolicited events
// (`ctx.post(name, payload)`), e.g. "a file changed" or "navigate here".

export type TabId = 'spectra' | 'calcs' | 'runs' | 'geom' | 'inputs' | 'ml' | 'report';

export const TAB_IDS: TabId[] = ['spectra', 'calcs', 'runs', 'geom', 'inputs', 'ml', 'report'];

/** Target of a request or event: a tab, or the studio shell itself. */
export type Channel = TabId | 'studio';

/** webview -> host */
export interface RequestMessage {
  kind: 'request';
  id: number;
  channel: Channel;
  method: string;
  params?: unknown;
}

/** host -> webview, answer to a RequestMessage with the same id */
export interface ResponseMessage {
  kind: 'response';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** host -> webview, unsolicited */
export interface EventMessage {
  kind: 'event';
  channel: Channel;
  name: string;
  payload?: unknown;
}

/** webview -> host, once the bundle has loaded and can receive events */
export interface ReadyMessage {
  kind: 'ready';
}

export type ToHost = RequestMessage | ReadyMessage;
export type ToWebview = ResponseMessage | EventMessage;

// ---------------------------------------------------------------------------
// Methods on the 'studio' channel, implemented by the shell for every tab.
// ---------------------------------------------------------------------------

/** Open a tab, optionally with tab-specific arguments (e.g. files to preselect). */
export interface NavigatePayload {
  tab: TabId;
  args?: unknown;
}

export interface SaveFileParams {
  /** Suggested file name, e.g. "spectra.svg". */
  defaultName: string;
  /** Text content, or base64 when `encoding` is 'base64' (PNG, PDF). */
  data: string;
  encoding?: 'utf8' | 'base64';
  /** Save-dialog filters, e.g. { "SVG image": ["svg"] }. */
  filters?: Record<string, string[]>;
  /** Write here without a dialog (absolute path); still asks before overwriting. */
  path?: string;
}

/** Path written, or undefined when the user cancelled. */
export type SaveFileResult = string | undefined;

export interface OpenFileParams {
  path: string;
  /** 0-based line to reveal. */
  line?: number;
  /** Open beside the studio panel instead of in the active column. */
  beside?: boolean;
}

export interface PickFilesParams {
  title?: string;
  canSelectMany?: boolean;
  canSelectFolders?: boolean;
  canSelectFiles?: boolean;
  filters?: Record<string, string[]>;
}

export interface ConfirmParams {
  message: string;
  /** Label of the confirming button, e.g. "Kill". */
  action: string;
  detail?: string;
}

export interface NotifyParams {
  level: 'info' | 'warning' | 'error';
  message: string;
}

/**
 * A figure handed from one tab to the report tab: the files are already
 * written, `latexPath` is relative to the report's figures folder.
 */
export interface SendToReportPayload {
  name: string;
  caption?: string;
  /** base64 PDF (preferred in LaTeX) and/or PNG. */
  pdf?: string;
  png?: string;
}

export interface RunInTerminalParams {
  command: string;
  /** Working directory (absolute). */
  cwd?: string;
  /** Terminal name; a terminal with that name is reused. */
  name?: string;
  /** Press Enter after typing the command (default false: the user reviews it first). */
  execute?: boolean;
}

export interface StudioInfo {
  /** Absolute workspace folder paths. */
  workspaceFolders: string[];
  /** 'dark' | 'light' | 'high-contrast' as reported by the host. */
  colorTheme: 'dark' | 'light' | 'high-contrast';
  platform: string;
  extensionVersion: string;
}

/**
 * Studio-channel method names and their parameter / result types. Tabs use
 * them through the typed helpers on the webview's ViewContext.
 */
export interface StudioMethods {
  info: { params: undefined; result: StudioInfo };
  saveFile: { params: SaveFileParams; result: SaveFileResult };
  openFile: { params: OpenFileParams; result: void };
  pickFiles: { params: PickFilesParams; result: string[] };
  confirm: { params: ConfirmParams; result: boolean };
  notify: { params: NotifyParams; result: void };
  /** Value of an `orcaInp.*` setting, key without the prefix, e.g. "studio.spectraGlobs". */
  getConfig: { params: { key: string }; result: unknown };
  sendToReport: { params: SendToReportPayload; result: void };
  runInTerminal: { params: RunInTerminalParams; result: void };
}
