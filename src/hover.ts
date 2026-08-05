import * as vscode from 'vscode';
import {
  KEYWORD_DOCS, BLOCK_DOCS, RUNTYPE_KEYWORDS, WAVEFUNCTION_METHOD_KEYWORDS,
  DFT_FUNCTIONAL_KEYWORDS, BASIS_KEYWORDS, AUX_BASIS_KEYWORDS, ECP_KEYWORDS,
  ALGORITHMIC_KEYWORDS, RELATIVISTIC_KEYWORDS, NEB_KEYWORDS,
  MISC_STRUCTURE_KEYWORDS, BLOCK_NAMES, isKnownSimpleKeyword
} from './keywords';

function categoryFallback(token: string): string | null {
  const lower = token.toLowerCase();
  const inList = (arr: string[]) => arr.some(k => k.toLowerCase() === lower);

  if (inList(RUNTYPE_KEYWORDS)) return 'ORCA runtype keyword (selects what kind of job to run).';
  if (inList(DFT_FUNCTIONAL_KEYWORDS)) return 'DFT exchange-correlation functional or dispersion correction.';
  if (inList(BASIS_KEYWORDS)) return 'Orbital basis set.';
  if (inList(AUX_BASIS_KEYWORDS)) return 'Auxiliary (fitting) basis set.';
  if (inList(ECP_KEYWORDS)) return 'Effective core potential.';
  if (inList(WAVEFUNCTION_METHOD_KEYWORDS)) return 'Wavefunction-based electronic structure method.';
  if (inList(RELATIVISTIC_KEYWORDS)) return 'Relativistic Hamiltonian / spin-orbit coupling option.';
  if (inList(NEB_KEYWORDS)) return 'Nudged Elastic Band job variant.';
  if (inList(ALGORITHMIC_KEYWORDS)) return 'SCF/algorithmic control keyword.';
  if (inList(MISC_STRUCTURE_KEYWORDS)) return 'General input-structure keyword.';
  if (/^CPCM\(/i.test(token)) return 'Implicit solvation via the CPCM model, with the named solvent.';
  if (/^PAL\d+$/i.test(token)) return 'Shorthand for %pal nprocs <n> end.';
  if (/^cc-p/i.test(token)) return 'Dunning correlation-consistent basis set family.';
  if (/^(DKH|ZORA)-/i.test(token)) return 'Relativistically recontracted basis set for use with this Hamiltonian.';
  return null;
}

export class OrcaHoverProvider implements vscode.HoverProvider {
  provideHover(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const range = doc.getWordRangeAtPosition(
      position,
      /[A-Za-z0-9][A-Za-z0-9\-\/\*\(\)\[\]+.]*/
    );
    if (!range) {
      return undefined;
    }
    const word = doc.getText(range);
    const lineText = doc.lineAt(position.line).text;

    // Block name: "%word"
    const blockMatch = /^\s*%([A-Za-z][A-Za-z0-9_]*)/.exec(lineText);
    if (blockMatch && blockMatch[1].toLowerCase() === word.toLowerCase()) {
      const doc2 = BLOCK_DOCS[word.toLowerCase()];
      if (doc2) {
        return new vscode.Hover(new vscode.MarkdownString(`**%${word}** — ${doc2}`));
      }
      return new vscode.Hover(new vscode.MarkdownString(`**%${word}** — ORCA input block.`));
    }

    // Simple-input keyword: only offer hover if the line is a "!" line
    if (/^\s*!/.test(lineText)) {
      const known = isKnownSimpleKeyword(word);
      if (!known) {
        return undefined;
      }
      const exact = KEYWORD_DOCS[word] ||
        KEYWORD_DOCS[Object.keys(KEYWORD_DOCS).find(k => k.toLowerCase() === word.toLowerCase()) || ''];
      const text = exact || categoryFallback(word) || 'Recognized ORCA simple-input keyword.';
      return new vscode.Hover(new vscode.MarkdownString(`**${word}** — ${text}`));
    }

    return undefined;
  }
}
