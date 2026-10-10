import * as assert from 'assert';
import { escapePlain, prettyTex, richEditable, texToHtml } from '../../webview/src/tabs/report/richtext';
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

  it('renders section titles with thin spaces, dashes and simple math', () => {
    assert.strictEqual(prettyTex('Task 2: Wigner sampling, 300\\,K, $n = 100\\,000$'),
      'Task 2: Wigner sampling, 300 K, <span class="rp-math">n = 100 000</span>');
    assert.strictEqual(prettyTex('CH$_2$OO vs.\\ CH$_3$ -- ok~now'),
      'CH<span class="rp-math"><sub>2</sub></span>OO vs. CH<span class="rp-math"><sub>3</sub></span> – ok now');
    assert.strictEqual(prettyTex('$\\lambda_{\\mathrm{max}}$ \\& 5\\% \\textbf{b} <x>'),
      '<span class="rp-math">λ<sub>max</sub></span> &amp; 5% <b>b</b> &lt;x&gt;');
    assert.strictEqual(prettyTex('\\unknown{x}'), '\\unknownx');
  });
});
