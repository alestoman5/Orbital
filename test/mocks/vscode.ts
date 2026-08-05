// Minimal stand-in for the 'vscode' module, used only when running these
// unit tests outside a real extension host (see test/register-vscode-mock.js,
// which intercepts `require('vscode')` and points it here).
//
// This is deliberately NOT a faithful reimplementation of the VS Code API --
// it only implements the bits src/diagnostics.ts, src/completion.ts and
// src/hover.ts actually touch at runtime. Type-checking against the real
// @types/vscode declarations still happens for the production build
// (`npm run compile`); tests run with ts-node's transpileOnly mode (see
// tsconfig.json's "ts-node" block) so mismatches against the real .d.ts
// don't block test runs.

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  public start: Position;
  public end: Position;

  constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
    this.start = new Position(startLine, startChar);
    this.end = new Position(endLine, endChar);
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3
}

export class Diagnostic {
  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity = DiagnosticSeverity.Error
  ) {}
}

export class MarkdownString {
  public value: string;
  constructor(value: string = '') {
    this.value = value;
  }
}

export enum CompletionItemKind {
  Keyword = 0,
  Function = 1,
  Struct = 2,
  Property = 3,
  Module = 4,
  EnumMember = 5
}

export class CompletionItem {
  public detail?: string;
  public documentation?: MarkdownString;
  constructor(public label: string, public kind?: CompletionItemKind) {}
}

export class Hover {
  constructor(public contents: MarkdownString) {}
}

// ---------------------------------------------------------------------
// workspace.getConfiguration -- backed by a settable in-memory store so
// tests can control `orcaInp.*` settings per case.
// ---------------------------------------------------------------------
type ConfigStore = Record<string, Record<string, unknown>>;
let configStore: ConfigStore = {};

export function __setConfig(section: string, values: Record<string, unknown>): void {
  configStore[section] = { ...(configStore[section] || {}), ...values };
}

export function __resetConfig(): void {
  configStore = {};
}

export const workspace = {
  getConfiguration(section: string) {
    const store = configStore[section] || {};
    return {
      get<T>(key: string, defaultValue?: T): T {
        return key in store ? (store[key] as T) : (defaultValue as T);
      }
    };
  }
};
