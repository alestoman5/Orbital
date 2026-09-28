import * as vscode from 'vscode';
import {
  RUNTYPE_KEYWORDS, ALGORITHMIC_KEYWORDS, MISC_STRUCTURE_KEYWORDS,
  RELATIVISTIC_KEYWORDS, NEB_KEYWORDS, WAVEFUNCTION_METHOD_KEYWORDS,
  DFT_FUNCTIONAL_KEYWORDS, BASIS_KEYWORDS, AUX_BASIS_KEYWORDS,
  ECP_KEYWORDS, BLOCK_NAMES, BLOCK_OPTIONS, BLOCK_OPTIONS_BY_BLOCK,
  KEYWORD_DOCS, BLOCK_DOCS
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

/**
 * Name (lower-case) of the %block the given line sits in, or undefined when
 * outside any block. Walks upward counting nested end/% pairs, so an
 * inner "Constraints ... end" sub-block doesn't end the enclosing %geom.
 * One-line blocks ("%pal nprocs 4 end") are closed on their own line.
 */
export function enclosingBlock(doc: vscode.TextDocument, line: number): string | undefined {
  let depth = 0;
  for (let i = line - 1; i >= 0; i--) {
    const text = doc.lineAt(i).text;
    const block = /^\s*%([A-Za-z][A-Za-z0-9_]*)/.exec(text);
    if (block) {
      if (/\bend\s*$/i.test(text)) {
        continue; // one-line block, already closed
      }
      if (depth === 0) {
        return block[1].toLowerCase();
      }
      depth--;
    } else if (/^\s*end\b/i.test(text)) {
      depth++;
    } else if (/^\s*(Constraints|Scan|Nuclei)\b/i.test(text) && !/\bend\s*$/i.test(text) && depth > 0) {
      depth--; // opener of a sub-block whose "end" we already counted
    }
  }
  return undefined;
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

    // Inside an open %block ... end region -> offer that block's options,
    // or the generic list for blocks without a curated entry
    const block = enclosingBlock(doc, position.line);
    if (block !== undefined) {
      const specific = BLOCK_OPTIONS_BY_BLOCK[block];
      if (specific) {
        return specific.map(o =>
          item(o.name, vscode.CompletionItemKind.Property, `%${block} option`, o.doc)
        );
      }
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
