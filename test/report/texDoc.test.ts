import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  escapeLatex,
  FigureBlock,
  figureBlock,
  insertFigure,
  ItemsBlock,
  parseTex,
  RawBlock,
  roundtrip,
  serializeTex,
  TexDoc
} from '../../src/report/texDoc';

const FIX = path.join(__dirname, '../fixtures/report');
const TASKS = fs.readFileSync(path.join(FIX, 'tasks_summary.tex'), 'utf8');
// v_report.py's own parse of the same file (test/fixtures/report/v_report_parity.py)
const PY = JSON.parse(fs.readFileSync(path.join(FIX, 'v_report_parity.json'), 'utf8'));

/** Lines that differ between a and b (same line count expected). */
function changedLines(a: string, b: string): number[] {
  const x = a.split('\n'), y = b.split('\n');
  assert.strictEqual(x.length, y.length, 'line count changed');
  return x.map((l, i) => (l === y[i] ? -1 : i + 1)).filter(i => i > 0);
}

const SYN = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\maketitle',
  '',
  '\\section{Intro} \\label{sec:intro}',
  'First paragraph',
  'continues here.',
  '',
  '',
  '\\begin{enumerate}',
  '% a comment before the first item',
  '\\item[a)] one',
  '  \\begin{itemize}',
  '    \\item nested stays in item one',
  '  \\end{itemize}',
  '\\item two',
  '  continued two',
  '\\end{enumerate}',
  '\\clearpage',
  '\\section[Short]{Long {nested} title}',
  '',
  '\\begin{figure*}[t]',
  '  \\centering',
  '  \\includegraphics[height=3cm, width=0.5\\linewidth]{figs/a.pdf}',
  '  \\caption[short]{A caption with {braces} and $x_1$.}',
  '  \\label{fig:a}',
  '\\end{figure*}',
  'Loose text right after.',
  '\\begin{equation}',
  '  E = mc^2 % \\end{equation} in a comment',
  '\\end{equation}',
  '\\section*{Empty}',
  '\\end{document}',
  '%% trailing notes after the end',
  ''
].join('\n');

describe('report/texDoc: roundtrip', () => {
  it('tasks_summary.tex comes back byte for byte (LF and CRLF)', () => {
    assert.ok(roundtrip(TASKS));
    const crlf = TASKS.replace(/\n/g, '\r\n');
    assert.strictEqual(parseTex(crlf).eol, '\r\n');
    assert.strictEqual(serializeTex(parseTex(crlf)), crlf);
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk({ ...parseTex(crlf), eol: '' });
    assert.ok(strings.length > 50 && strings.every(s => !s.includes('\r')), 'CRLF is normalized in the model');
  });

  it('matches v_report.py on tasks_summary.tex (titles, clearpage, items, raw blocks)', () => {
    const doc = parseTex(TASKS);
    assert.strictEqual(doc.preamble, PY.pre);
    assert.strictEqual(doc.sections.length, PY.sections.length);
    doc.sections.forEach((s, k) => {
      const p = PY.sections[k];
      assert.strictEqual(s.title, p.title);
      assert.strictEqual(s.clearpage, p.clearpage);
      assert.strictEqual(s.starred, true);
      assert.strictEqual(s.blocks.length, p.blocks.length, s.title);
      s.blocks.forEach((b, j) => {
        const q = p.blocks[j];
        if (q.type === 'items') {
          assert.strictEqual(b.type, 'items');
          assert.strictEqual((b as ItemsBlock).head, q.head);
          assert.deepStrictEqual((b as ItemsBlock).items.map(i => i.text), q.items);
        } else {
          assert.ok(b.type === 'raw' || b.type === 'figure');
          assert.strictEqual(b.type === 'raw' ? b.tex : (b as FigureBlock).raw, q.tex);
        }
      });
    });
  });

  it('synthetic document: unstarred sections, short titles, nested lists, figure*, comments', () => {
    assert.ok(roundtrip(SYN));
    const doc = parseTex(SYN);
    assert.ok(doc.preamble.endsWith('\\maketitle\n\n'));
    assert.strictEqual(doc.end, '\\end{document}\n%% trailing notes after the end\n');
    const [intro, long, empty] = doc.sections;
    assert.deepStrictEqual([intro.starred, intro.title, intro.headTail, intro.clearpage], [false, 'Intro', ' \\label{sec:intro}\n', false]);
    assert.deepStrictEqual([long.short, long.title, long.clearpage, long.clearpageRaw], ['[Short]', 'Long {nested} title', true, '\\clearpage\n']);
    assert.deepStrictEqual([empty.starred, empty.blocks.length, empty.trailing], [true, 0, '']);
    assert.deepStrictEqual(intro.blocks.map(b => b.type), ['raw', 'items']);
    assert.strictEqual(intro.blocks[1].lead, '\n\n\n');
    const list = intro.blocks[1] as ItemsBlock;
    assert.strictEqual(list.env, 'enumerate');
    assert.strictEqual(list.intro, '% a comment before the first item\n');
    assert.deepStrictEqual(list.items.map(i => i.prefix), ['\\item', '\\item ']);
    assert.strictEqual(list.items[0].text, '[a)] one\n  \\begin{itemize}\n    \\item nested stays in item one\n  \\end{itemize}');
    assert.strictEqual(list.items[1].text, 'two\n  continued two');
    assert.deepStrictEqual(long.blocks.map(b => b.type), ['figure', 'raw', 'raw']);
    const fig = long.blocks[0] as FigureBlock;
    assert.deepStrictEqual([fig.env, fig.path, fig.width, fig.caption, fig.label],
      ['figure*', 'figs/a.pdf', '0.5\\linewidth', 'A caption with {braces} and $x_1$.', 'fig:a']);
    assert.match((long.blocks[2] as RawBlock).tex, /^\\begin\{equation\}[\s\S]*\\end\{equation\}$/);
  });

  it('documents without sections get one implicit section', () => {
    const t = '\\documentclass{article}\n\\begin{document}\nHello.\n\n\\begin{itemize}\n\\item a\n\\end{itemize}\n\\end{document}\n';
    const doc = parseTex(t);
    assert.strictEqual(doc.preamble, '\\documentclass{article}\n\\begin{document}\n');
    assert.strictEqual(doc.sections.length, 1);
    assert.deepStrictEqual([doc.sections[0].heading, doc.sections[0].blocks.map(b => b.type)], [false, ['raw', 'items']]);
    assert.ok(roundtrip(t));
    const frag = 'Just a fragment\nwithout a document environment.\n';
    assert.deepStrictEqual([parseTex(frag).preamble, parseTex(frag).end, parseTex(frag).sections[0].blocks.length], ['', '', 1]);
    for (const s of [frag, '', '\n\n', '\\begin{document}', '\\end{document}', '\\documentclass{x}\n\\begin{document}\\end{document}',
      'no newline at all', '\\section{A}', '\\section{unclosed\n\\end{document}\n']) {
      assert.ok(roundtrip(s), JSON.stringify(s));
    }
  });

  it('edge cases roundtrip: mixed line endings, BOM, unclosed environments, odd items', () => {
    const cases = [
      '\uFEFF\\documentclass{a}\r\n\\begin{document}\n\\section{A}\r\ntext\n\\end{document}\r\n',
      '\\begin{document}\n\\section*{A}\n\\begin{itemize}\n\\item never closed\n\n\\section*{B}\nx\n\\end{document}',
      '\\begin{document}\n\\section*{A}\n\\begin{itemize}\\item a\n\\end{itemize}\n\\begin{itemize}\n\\end{itemize}\n\\end{document}\n',
      '\\begin{document}\n\\section*{A}\n  \\begin{itemize}\n  \\itemsep0pt\n  \\item x \\item y\n  \\end{itemize} % tail\n\\end{document}\n',
      '\\begin{document}\n\\section*{A}\ntext\\end{document}',
      '\\begin{document}\n\\section{A}\n\\begin{figure}\n\\end{figure}\n\\begin{figure}[H]\n\\includegraphics{x}\n\\end{figure}\n\\end{document}\n',
      '\\begin{document}\n\\section*{A}\n\\begin{itemize}\n\\item a\n\\end{enumerate}\n\\end{itemize}\n\\end{document}\n',
      '\\section*{Before begin}\n\\begin{document}\n\\section*{After}\n\\end{document}\n\\end{document}\n'
    ];
    for (const t of cases) assert.ok(roundtrip(t), JSON.stringify(t));
    assert.strictEqual(parseTex(cases[0]).eol, '\n');
    assert.strictEqual(parseTex(cases[7]).sections.length, 1, 'sections only after \\begin{document}');
  });

  it('random documents roundtrip', () => {
    const vocab = ['', '', ' ', 'text', '% c', '\\section{T}', '\\section*{S}', '\\clearpage', '\\begin{itemize}', '\\item a',
      '  \\item b', '\\end{itemize}', '\\begin{figure}[H]', '\\includegraphics[width=1cm]{f.png}', '\\caption{c}',
      '\\end{figure}', '\\begin{table}', '\\end{table}', '\\begin{enumerate}', '\\end{enumerate}', '\\begin{document}',
      '\\end{document}', 'x\\end{document}', '\\section{open', '}'];
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let k = 0; k < 800; k++) {
      const lines = Array.from({ length: 1 + rnd(25) }, () => vocab[rnd(vocab.length)]);
      const t = lines.join(rnd(4) === 0 ? '\r\n' : '\n') + (rnd(2) ? '\n' : '');
      assert.ok(roundtrip(t), JSON.stringify(t));
    }
  });
});

describe('report/texDoc: editing', () => {
  it('editing one item changes exactly that line', () => {
    const doc = parseTex(TASKS);
    const list = doc.sections[0].blocks[0] as ItemsBlock;
    list.items[0].text = 'Edited bullet';
    const out = serializeTex(doc);
    const changed = changedLines(TASKS, out);
    assert.strictEqual(changed.length, 1);
    assert.strictEqual(out.split('\n')[changed[0] - 1], '  \\item Edited bullet');
  });

  it('new items copy the previous prefix; plain strings are accepted', () => {
    const doc = parseTex(SYN);
    const list = doc.sections[0].blocks[1] as ItemsBlock;
    list.items.push({ text: 'three' });
    (list.items as unknown[]).push('four');
    assert.match(serializeTex(doc), /continued two\n\\item three\n\\item four\n\\end\{enumerate\}/);
  });

  it('section edits: title, star, clearpage', () => {
    const doc = parseTex(SYN);
    doc.sections[0].title = 'Introduction';
    doc.sections[0].starred = true;
    doc.sections[1].clearpage = false;
    doc.sections[2].clearpage = true;
    const out = serializeTex(doc);
    assert.match(out, /\\section\*\{Introduction\} \\label\{sec:intro\}\n/);
    assert.ok(!out.includes('\\clearpage\n\\section[Short]'));
    assert.match(out, /\\clearpage\n\\section\*\{Empty\}/);
  });

  it('figure fields are edited in place, the rest of the block untouched', () => {
    const doc = parseTex(SYN);
    const fig = doc.sections[1].blocks[0] as FigureBlock;
    fig.caption = 'New caption';
    let out = serializeTex(doc);
    assert.deepStrictEqual(changedLines(SYN, out), [25]);
    assert.strictEqual(out.split('\n')[24], '  \\caption[short]{New caption}');
    fig.width = '0.7\\textwidth';
    fig.path = 'figs/b.pdf';
    out = serializeTex(doc);
    assert.strictEqual(out.split('\n')[23], '  \\includegraphics[height=3cm, width=0.7\\textwidth]{figs/b.pdf}');
    fig.label = null;
    out = serializeTex(doc);
    assert.ok(!out.includes('\\label{fig:a}'));
    assert.strictEqual(out.split('\n').length, SYN.split('\n').length - 1, 'label line removed');
    fig.label = 'fig:new';
    fig.width = null;
    out = serializeTex(doc);
    assert.match(out, /\\includegraphics\[height=3cm\]\{figs\/b\.pdf\}/);
    assert.match(out, /  \\caption\[short\]\{New caption\}\n  \\label\{fig:new\}\n\\end\{figure\*\}/);
    // a label added to a figure that has none goes on its own line before \end{figure*}
    const doc2 = parseTex(out.replace('  \\label{fig:new}\n', ''));
    const fig2 = doc2.sections[1].blocks[0] as FigureBlock;
    assert.strictEqual(fig2.label, null);
    fig2.label = 'fig:x';
    assert.match(serializeTex(doc2), /New caption\}\n\\label\{fig:x\}\n\\end\{figure\*\}/);
  });

  it('a figure without caption gets one before its label / end', () => {
    const t = '\\begin{document}\n\\section{A}\n\\begin{figure}[H]\n\\includegraphics{x.png}\n\\end{figure}\n\\end{document}\n';
    const doc = parseTex(t);
    const fig = doc.sections[0].blocks[0] as FigureBlock;
    assert.deepStrictEqual([fig.width, fig.caption, fig.label], [null, null, null]);
    fig.caption = 'C';
    fig.width = '5cm';
    assert.strictEqual(serializeTex(doc),
      '\\begin{document}\n\\section{A}\n\\begin{figure}[H]\n\\includegraphics[width=5cm]{x.png}\n\\caption{C}\n\\end{figure}\n\\end{document}\n');
  });

  it('figureBlock + insertFigure ("Send to report")', () => {
    const b = figureBlock('figures/spectrum.pdf', escapeLatex('UV-vis, 300 K & 5%'), 'fig:spectrum');
    assert.strictEqual(b.raw, '\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=0.85\\textwidth]{figures/spectrum.pdf}\n'
      + '\\caption{UV-vis, 300 K \\& 5\\%}\n\\label{fig:spectrum}\n\\end{figure}');
    const doc = parseTex(TASKS);
    const last = doc.sections.length - 1;
    insertFigure(doc, last, b);
    const out = serializeTex(doc);
    assert.ok(out.startsWith(TASKS.slice(0, TASKS.lastIndexOf('\n\n\\end{document}'))));
    assert.ok(out.endsWith('\\end{itemize}\n\n' + b.raw + '\n\n\\end{document}\n'));
    const again = parseTex(out).sections[last].blocks.pop() as FigureBlock;
    assert.deepStrictEqual([again.type, again.path, again.label], ['figure', 'figures/spectrum.pdf', 'fig:spectrum']);
    insertFigure(doc, 0, figureBlock('a.png', null, '', '', 'H'), 0);
    assert.match(serializeTex(doc), /\\section\*\{Task 1: Opt\+freq PBE, 7 basis sets\}\n\n\\begin\{figure\}\[H\]\n\\centering\n\\includegraphics\{a\.png\}\n\\end\{figure\}\n\n\\begin\{itemize\}/);
    assert.throws(() => insertFigure(doc, 99, b), RangeError);
    assert.throws(() => insertFigure(doc, 0, b, 99), RangeError);
  });

  it('a section added by the UI with only the essential fields', () => {
    const doc: TexDoc = parseTex('\\begin{document}\n\\section*{A}\nx\n\n\\end{document}\n');
    doc.sections.push({ heading: true, clearpage: true, starred: true, title: 'New', blocks: [{ type: 'items', env: 'itemize', head: '\\begin{itemize}', items: [{ text: 'first' }], tail: '\\end{itemize}' }] });
    assert.strictEqual(serializeTex(doc),
      '\\begin{document}\n\\section*{A}\nx\n\n\\clearpage\n\\section*{New}\n\n\\begin{itemize}\n  \\item first\n\\end{itemize}\n\\end{document}\n');
  });

  it('CRLF documents stay CRLF after edits', () => {
    const crlf = SYN.replace(/\n/g, '\r\n');
    const doc = parseTex(crlf);
    (doc.sections[0].blocks[1] as ItemsBlock).items[1].text = 'changed\n  continued two';
    const out = serializeTex(doc);
    assert.ok(!/[^\r]\n/.test(out));
    assert.deepStrictEqual(out.split('\r\n').filter((l, i) => l !== crlf.split('\r\n')[i]), ['\\item changed']);
  });
});
