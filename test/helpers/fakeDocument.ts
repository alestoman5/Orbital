// Lightweight stand-ins for the vscode.TextDocument / DiagnosticCollection
// surface that src/diagnostics.ts, src/completion.ts and src/hover.ts touch,
// so their exported functions/providers can be unit tested without a
// running extension host.

import { Position, Range } from '../mocks/vscode';

export interface FakeTextDocument {
  uri: { toString(): string };
  lineCount: number;
  lineAt(lineOrPosition: number | Position): { text: string; range: Range };
  getText(range?: Range): string;
  getWordRangeAtPosition(position: Position, regex: RegExp): Range | undefined;
}

export function makeDoc(lines: string[]): FakeTextDocument {
  return {
    uri: { toString: () => 'fake://doc' },
    lineCount: lines.length,
    lineAt(lineOrPosition: number | Position) {
      const i = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
      const text = lines[i];
      return { text, range: new Range(i, 0, i, text.length) };
    },
    getText(range?: Range) {
      if (!range) {
        return lines.join('\n');
      }
      // Only single-line ranges are needed by the code under test.
      const line = lines[range.start.line];
      return line.slice(range.start.character, range.end.character);
    },
    getWordRangeAtPosition(position: Position, regex: RegExp) {
      const line = lines[position.line];
      const global = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
      let m: RegExpExecArray | null;
      while ((m = global.exec(line)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (position.character >= start && position.character <= end) {
          return new Range(position.line, start, position.line, end);
        }
        if (m[0].length === 0) {
          global.lastIndex++;
        }
      }
      return undefined;
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
