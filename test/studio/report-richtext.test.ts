import * as assert from 'assert';
import { escapePlain, richEditable, texToHtml } from '../../webview/src/tabs/report/richtext';
import { sanitizeName } from '../../webview/src/tabs/report/names';
import { sanitizeFigureName } from '../../src/report/compile';

describe('studio report: rich text', () => {
  it('turns \\textbf / \\emph / \\texttt and math into HTML, escaping the rest', () => {
    assert.strictEqual(texToHtml('a \\textbf{b \\emph{c}} <d> $x_1$'), 'a <b>b <i>c</i></b> &lt;d&gt; <span class="m">$x_1$</span>');
    assert.strictEqual(texToHtml('\\texttt{a\\_b}'), '<code>a_b</code>');
    assert.strictEqual(texToHtml('\\texttt{\\foo}'), '\\texttt{\\foo}');
  });

  it('escapes typed special characters outside math only', () => {
    assert.strictEqual(escapePlain('5% of a_b & $x_1$ \\% ok'), '5\\% of a\\_b \\& $x_1$ \\% ok');
  });

  it('edits structured items as LaTeX', () => {
    assert.strictEqual(richEditable('plain \\textbf{x} 50\\%'), true);
    assert.strictEqual(richEditable('a % comment'), false);
    assert.strictEqual(richEditable('a\\\\b'), false);
    assert.strictEqual(richEditable('x\n\\begin{itemize}\n\\item y\n\\end{itemize}'), false);
  });

  it('previews figure names like the host sanitizes them', () => {
    for (const n of ['ML parity: test?', 'a/b/c.pdf', '..hidden', 'con', '', 'Spectrum (S1)']) {
      assert.strictEqual(sanitizeName(n), sanitizeFigureName(n).replace(/^_(?=con$)/, ''), n);
    }
  });
});
