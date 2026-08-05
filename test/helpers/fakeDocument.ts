// Lightweight stand-ins for the vscode.TextDocument / DiagnosticCollection
// surface that src/diagnostics.ts touches, so lintDocument() can be unit
// tested without a running extension host.

import { Range } from '../mocks/vscode';

export interface FakeTextDocument {
  uri: { toString(): string };
  lineCount: number;
  lineAt(i: number): { text: string; range: Range };
  getText(): string;
}

export function makeDoc(lines: string[]): FakeTextDocument {
  return {
    uri: { toString: () => 'fake://doc' },
    lineCount: lines.length,
    lineAt(i: number) {
      const text = lines[i];
      return { text, range: new Range(i, 0, i, text.length) };
    },
    getText() {
      return lines.join('\n');
    }
  };
}

export interface FakeDiagnosticCollection {
  set(uri: unknown, diags: unknown[]): void;
  delete(uri: unknown): void;
  readonly diagnostics: unknown[] | null;
  readonly wasDeleted: boolean;
}

export function makeCollection(): FakeDiagnosticCollection {
  let diagnostics: unknown[] | null = null;
  let deleted = false;
  return {
    set(_uri: unknown, diags: unknown[]) {
      diagnostics = diags;
      deleted = false;
    },
    delete(_uri: unknown) {
      diagnostics = null;
      deleted = true;
    },
    get diagnostics() {
      return diagnostics;
    },
    get wasDeleted() {
      return deleted;
    }
  };
}
