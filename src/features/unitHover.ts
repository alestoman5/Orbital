// Hover inside .out files: a number followed by an energy unit ("-76.3 Eh",
// "4.271 eV", "290.3 nm", "34451.2 cm**-1", "-29.11 kcal/mol") shows the
// same value in the other units. Only numbers with an explicit unit are
// converted, so table columns without one are never guessed at.

import * as vscode from 'vscode';
import { EnergyUnit, convertEnergy } from '../chem/spectrum';

const VALUE_WITH_UNIT_RE = /(-?\d+\.\d+(?:[eE][-+]?\d+)?)\s*(Eh|eV|nm|cm\*\*-1|cm-1|kcal\/mol|kJ\/mol)\b/g;

const UNIT_OF: Record<string, EnergyUnit> = {
  'Eh': 'Eh',
  'eV': 'eV',
  'nm': 'nm',
  'cm**-1': 'cm-1',
  'cm-1': 'cm-1',
  'kcal/mol': 'kcal/mol',
  'kJ/mol': 'kJ/mol'
};

const ALL_UNITS: EnergyUnit[] = ['Eh', 'eV', 'nm', 'cm-1', 'kcal/mol', 'kJ/mol'];

function fmt(v: number, unit: EnergyUnit): string {
  switch (unit) {
    case 'Eh': return v.toFixed(8);
    case 'eV': return v.toFixed(4);
    case 'nm': return v.toFixed(1);
    case 'cm-1': return v.toFixed(1);
    default: return v.toFixed(3);
  }
}

/** Markdown table of conversions, or undefined when the text at `character` isn't a value+unit. */
export function unitConversionAt(line: string, character: number): { markdown: string; start: number; end: number } | undefined {
  VALUE_WITH_UNIT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VALUE_WITH_UNIT_RE.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (character < start || character > end) {
      continue;
    }
    const value = parseFloat(m[1]);
    const unit = UNIT_OF[m[2]];
    // An absolute energy in Eh is usually a total energy — converting it to
    // nm/cm^-1 is meaningless, so only offer energy-like units for it.
    const targets = ALL_UNITS.filter(u => u !== unit && !(unit === 'Eh' && Math.abs(value) > 1 && (u === 'nm' || u === 'cm-1')));
    if (unit === 'nm' && value <= 0) {
      return undefined;
    }
    const rows = targets
      .filter(u => !(u === 'nm' && value <= 0))
      .map(u => `| ${fmt(convertEnergy(value, unit, u), u)} | ${u} |`);
    return { markdown: `**${m[1]} ${m[2]}**\n\n| value | unit |\n|---:|---|\n${rows.join('\n')}`, start, end };
  }
  return undefined;
}

export class OutUnitHoverProvider implements vscode.HoverProvider {
  provideHover(doc: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const hit = unitConversionAt(doc.lineAt(position.line).text, position.character);
    if (!hit) {
      return undefined;
    }
    return new vscode.Hover(
      new vscode.MarkdownString(hit.markdown),
      new vscode.Range(position.line, hit.start, position.line, hit.end)
    );
  }
}
