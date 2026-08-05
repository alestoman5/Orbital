import * as vscode from 'vscode';
import {
  RUNTYPE_KEYWORDS, ALGORITHMIC_KEYWORDS, MISC_STRUCTURE_KEYWORDS,
  RELATIVISTIC_KEYWORDS, NEB_KEYWORDS, WAVEFUNCTION_METHOD_KEYWORDS,
  DFT_FUNCTIONAL_KEYWORDS, BASIS_KEYWORDS, AUX_BASIS_KEYWORDS,
  ECP_KEYWORDS, BLOCK_NAMES, BLOCK_OPTIONS, KEYWORD_DOCS, BLOCK_DOCS
} from './keywords';

function item(
  label: string,
  kind: vscode.CompletionItemKind,
  detail: string,
  doc?: string
): vscode.CompletionItem {
  const it = new vscode.CompletionItem(label, kind);
  it.detail = detail;
  if (doc) {
    it.documentation = new vscode.MarkdownString(doc);
  }
  return it;
}

function isInsideOpenBlock(doc: vscode.TextDocument, line: number): boolean {
  // Walk upward: if we find an unmatched "%block" before hitting the start
  // of file (counting nested end/% pairs), we're inside a block.
  let depth = 0;
  for (let i = line - 1; i >= 0; i--) {
    const text = doc.lineAt(i).text;
    if (/^\s*end\b/i.test(text)) {
      depth++;
    } else if (/^\s*%[A-Za-z]/.test(text)) {
      if (depth === 0) {
        return true;
      }
      depth--;
    }
  }
  return false;
}

export class OrcaCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const linePrefix = doc.lineAt(position).text.slice(0, position.character);

    // Inside a simple-input line ("! ...") -> offer runtype/method/functional/
    // basis/algorithmic keywords
    if (/^\s*!/.test(linePrefix)) {
      const items: vscode.CompletionItem[] = [];
      const push = (arr: string[], kind: vscode.CompletionItemKind, detail: string) => {
        for (const k of arr) {
          items.push(item(k, kind, detail, KEYWORD_DOCS[k]));
        }
      };
      push(RUNTYPE_KEYWORDS, vscode.CompletionItemKind.Keyword, 'ORCA runtype keyword');
      push(WAVEFUNCTION_METHOD_KEYWORDS, vscode.CompletionItemKind.Function, 'ORCA wavefunction method');
      push(DFT_FUNCTIONAL_KEYWORDS, vscode.CompletionItemKind.Function, 'DFT functional / dispersion');
      push(BASIS_KEYWORDS, vscode.CompletionItemKind.Struct, 'ORCA basis set');
      push(AUX_BASIS_KEYWORDS, vscode.CompletionItemKind.Struct, 'Auxiliary (fitting) basis set');
      push(ECP_KEYWORDS, vscode.CompletionItemKind.Struct, 'Effective core potential');
      push(RELATIVISTIC_KEYWORDS, vscode.CompletionItemKind.Keyword, 'Relativistic / spin-orbit option');
      push(NEB_KEYWORDS, vscode.CompletionItemKind.Keyword, 'NEB job variant');
      push(ALGORITHMIC_KEYWORDS, vscode.CompletionItemKind.Property, 'SCF/algorithmic keyword');
      push(MISC_STRUCTURE_KEYWORDS, vscode.CompletionItemKind.Property, 'General input keyword');
      return items;
    }

    // Starting a block name ("%" typed, nothing after) -> offer block names
    if (/^\s*%[A-Za-z]*$/.test(linePrefix)) {
      return BLOCK_NAMES.map(b =>
        item(b, vscode.CompletionItemKind.Module, 'ORCA input block', BLOCK_DOCS[b])
      );
    }

    // Inside an open %block ... end region -> offer common block options
    if (isInsideOpenBlock(doc, position.line)) {
      return BLOCK_OPTIONS.map(o =>
        item(o, vscode.CompletionItemKind.Property, 'ORCA block option')
      );
    }

    // Start of coordinate block header
    if (/^\s*\*\s*\w*$/.test(linePrefix)) {
      return ['xyz', 'xyzfile', 'int', 'gzmt'].map(o =>
        item(o, vscode.CompletionItemKind.EnumMember, 'coordinate block type')
      );
    }

    return [];
  }
}
