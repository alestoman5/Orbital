import * as vscode from 'vscode';
import { isKnownSimpleKeyword } from './keywords';

const BLOCK_START_RE = /^\s*%([A-Za-z][A-Za-z0-9_]*)/;
const BLOCK_END_RE = /^\s*end\b/i;
const COORD_START_RE = /^\s*\*\s*(xyz|xyzfile|int|gzmt|internal)?\s*(-?\d+)?\s*(\d+)?/i;
const COORD_END_RE = /^\s*\*\s*$/;
const SIMPLE_INPUT_RE = /^\s*!(.*)$/;

function severityFromSetting(value: string): vscode.DiagnosticSeverity | null {
  switch (value) {
    case 'error': return vscode.DiagnosticSeverity.Error;
    case 'warning': return vscode.DiagnosticSeverity.Warning;
    case 'information': return vscode.DiagnosticSeverity.Information;
    default: return null; // 'off'
  }
}

export function lintDocument(
  doc: vscode.TextDocument,
  collection: vscode.DiagnosticCollection
): void {
  const config = vscode.workspace.getConfiguration('orcaInp');
  if (!config.get<boolean>('diagnostics.enable', true)) {
    collection.delete(doc.uri);
    return;
  }
  const unknownSeverity = severityFromSetting(
    config.get<string>('diagnostics.unknownKeywordSeverity', 'warning')!
  );

  const diagnostics: vscode.Diagnostic[] = [];
  const lineCount = doc.lineCount;

  // --- 1. Balance of %block ... end ---
  const blockStack: { name: string; line: number }[] = [];
  // --- 2. Balance of * ... * coordinate blocks ---
  let coordOpenLine: number | null = null;
  let sawAnySimpleInput = false;
  let sawAnyCoordBlock = false;

  for (let i = 0; i < lineCount; i++) {
    const lineText = doc.lineAt(i).text;
    const trimmed = lineText.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    // Coordinate block tracking takes priority: a line that is exactly "*"
    // either opens or closes a coordinate block.
    if (coordOpenLine === null) {
      const coordStart = COORD_START_RE.exec(lineText);
      if (coordStart && trimmed.startsWith('*')) {
        coordOpenLine = i;
        sawAnyCoordBlock = true;
        const chargeStr = coordStart[2];
        const multStr = coordStart[3];
        const coordType = coordStart[1];
        if (!coordType) {
          // e.g. "* xyz" missing, or malformed header
        }
        if (chargeStr === undefined || multStr === undefined) {
          diagnostics.push(new vscode.Diagnostic(
            doc.lineAt(i).range,
            'Coordinate block header looks incomplete — expected "* xyz <charge> <multiplicity>" (or xyzfile/int variant).',
            vscode.DiagnosticSeverity.Warning
          ));
        }
        continue;
      }
    } else {
      if (COORD_END_RE.test(lineText)) {
        coordOpenLine = null;
      }
      continue; // don't apply block/keyword checks to lines inside coordinates
    }

    // %block ... end tracking
    const blockStart = BLOCK_START_RE.exec(lineText);
    if (blockStart) {
      blockStack.push({ name: blockStart[1], line: i });
      continue;
    }
    if (BLOCK_END_RE.test(lineText)) {
      if (blockStack.length === 0) {
        diagnostics.push(new vscode.Diagnostic(
          doc.lineAt(i).range,
          '"end" found with no matching "%block" before it.',
          vscode.DiagnosticSeverity.Error
        ));
      } else {
        blockStack.pop();
      }
      continue;
    }

    // Simple input line (! keyword keyword ...)
    const simple = SIMPLE_INPUT_RE.exec(lineText);
    if (simple) {
      sawAnySimpleInput = true;
      const rest = simple[1];
      const tokenRe = /\(?[A-Za-z0-9][A-Za-z0-9\-\/\*\(\)]*\)?/g;
      let m: RegExpExecArray | null;
      while ((m = tokenRe.exec(rest)) !== null) {
        const token = m[0];
        if (unknownSeverity !== null && !isKnownSimpleKeyword(token)) {
          const start = simple.index + (simple[0].length - simple[1].length) + m.index;
          const range = new vscode.Range(
            i, lineText.indexOf(token, lineText.indexOf('!')),
            i, lineText.indexOf(token, lineText.indexOf('!')) + token.length
          );
          diagnostics.push(new vscode.Diagnostic(
            range,
            `Unrecognized keyword "${token}" — not in the extension's known keyword list. ` +
            `It may still be valid ORCA syntax; check the manual, or add it to keywords.ts if it's used often.`,
            unknownSeverity
          ));
        }
      }
    }
  }

  // Unclosed %block(s)
  for (const open of blockStack) {
    diagnostics.push(new vscode.Diagnostic(
      doc.lineAt(open.line).range,
      `Block "%${open.name}" is never closed with "end".`,
      vscode.DiagnosticSeverity.Error
    ));
  }

  // Unclosed coordinate block
  if (coordOpenLine !== null) {
    diagnostics.push(new vscode.Diagnostic(
      doc.lineAt(coordOpenLine).range,
      'Coordinate block opened with "*" is never closed with a trailing "*".',
      vscode.DiagnosticSeverity.Error
    ));
  }

  // Sanity: file has neither a simple-input line nor a coordinate block —
  // likely not a real ORCA job yet, worth a gentle heads-up rather than
  // silence.
  if (!sawAnySimpleInput && lineCount > 0 && doc.getText().trim().length > 0) {
    diagnostics.push(new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0),
      'No simple-input line ("! ...") found — ORCA needs at least one to know what to do.',
      vscode.DiagnosticSeverity.Information
    ));
  }
  if (sawAnySimpleInput && !sawAnyCoordBlock) {
    diagnostics.push(new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0),
      'No coordinate block ("* xyz ..." / "* xyzfile ...") found in this file.',
      vscode.DiagnosticSeverity.Information
    ));
  }

  collection.set(doc.uri, diagnostics);
}
