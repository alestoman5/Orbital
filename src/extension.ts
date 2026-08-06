import * as vscode from 'vscode';
import { lintDocument } from './diagnostics';
import { OrcaCompletionProvider } from './completion';
import { OrcaHoverProvider } from './hover';
import { OutputStatusBar } from './outparser/statusBar';

const LANGUAGE_ID = 'orca-inp';

export function activate(context: vscode.ExtensionContext): void {
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('orca-inp');
  context.subscriptions.push(diagnosticCollection);

  function lintIfOrca(doc: vscode.TextDocument): void {
    if (doc.languageId === LANGUAGE_ID) {
      lintDocument(doc, diagnosticCollection);
    }
  }

  // Lint already-open documents on activation
  vscode.workspace.textDocuments.forEach(lintIfOrca);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(lintIfOrca),
    vscode.workspace.onDidChangeTextDocument(e => lintIfOrca(e.document)),
    vscode.workspace.onDidSaveTextDocument(lintIfOrca),
    vscode.workspace.onDidCloseTextDocument(doc => diagnosticCollection.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('orcaInp')) {
        vscode.workspace.textDocuments.forEach(lintIfOrca);
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      LANGUAGE_ID,
      new OrcaCompletionProvider(),
      '!', '%', '*', ' '
    )
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(LANGUAGE_ID, new OrcaHoverProvider())
  );

  context.subscriptions.push(new OutputStatusBar());
}

export function deactivate(): void {
  // nothing to clean up
}
