import * as assert from 'assert';
import { autoDomain, linearTicks, logTicks, minorDivisions, minorTicks, niceStep, Scale, secondaryTicks } from '../../webview/src/charts/scales';
import { decimalsFor, factorMarkup, formatLinearTicks, formatLogTicks, formatValue, labelWithFactor, MINUS } from '../../webview/src/charts/format';
import { decimateMinMax, monotonic, prepareLine, visibleRange } from '../../webview/src/charts/decimate';
import { colorAt, colorLimits, colormapStops, contrast } from '../../webview/src/charts/colormap';
import { arimoMeasure, parseRich, plainText, richSvg, wrapRuns } from '../../webview/src/charts/text';
import { equalAspectBox, gridLayout, maxTickCount, screenHeight, stackLayout } from '../../webview/src/charts/layout';
import { buildCsv } from '../../webview/src/charts/csv';
import { svgString } from '../../webview/src/charts/svgExport';
import type { Figure } from '../../webview/src/charts/api';

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

describe('charts: scales', () => {
  it('nice steps are 1, 2, 5 × 10^k', () => {
    assert.strictEqual(niceStep(0.13), 0.2);
    assert.strictEqual(niceStep(3), 5);
    assert.strictEqual(niceStep(7), 10);
    assert.ok(close(niceStep(2.2e-18), 5e-18));
  });

  it('ticks 250–500 nm every 50 nm', () => {
    const t = linearTicks(250, 500, 8);
    assert.deepStrictEqual(t.major, [250, 300, 350, 400, 450, 500]);
    assert.strictEqual(t.step, 50);
    // minor: 5 divisions of a 5-mantissa step
    assert.ok(t.minor.includes(260) && t.minor.includes(490) && !t.minor.includes(300));
  });

  it('ticks a 0–1.3e-17 cross-section axis with clean multiples', () => {
    const t = linearTicks(0, 1.3e-17, 9);
    assert.ok(close(t.step, 2e-18));
    assert.strictEqual(t.major.length, 7);
    assert.strictEqual(t.major[0], 0);
    assert.ok(close(t.major[6], 1.2e-17));
    t.major.forEach(v => assert.ok(close(v / 2e-18, Math.round(v / 2e-18))));
  });

  it('ticks negative and mixed-sign ranges symmetrically', () => {
    assert.deepStrictEqual(linearTicks(-4.3, -0.2, 6).major, [-4, -3, -2, -1]);
    const t = linearTicks(-2.5e-18, 2.2e-18, 6);
    assert.ok(t.major.some(v => v === 0));
    assert.ok(t.major.every(v => v >= -2.5e-18 && v <= 2.2e-18));
  });

  it('respects the maximum number of ticks', () => {
    for (const [lo, hi] of [[0, 1], [3.1, 7.9], [-180, 180], [0.002, 0.0031], [1e5, 3.7e5]]) {
      for (const n of [3, 5, 8]) {
        assert.ok(linearTicks(lo, hi, n).major.length <= n, `${lo}..${hi} max ${n}`);
      }
    }
  });

  it('keeps at least two major ticks on short axes', () => {
    assert.ok(linearTicks(-4.1e-18, 2.6e-18, 3).major.length >= 2);
    assert.ok(linearTicks(0.31, 0.39, 2).major.length >= 2);
  });

  it('uses a 2.5 step only when 1-2-5 would leave fewer than 4 ticks', () => {
    assert.strictEqual(linearTicks(0, 1.3, 6).step, 0.25);
    assert.strictEqual(linearTicks(0, 10, 6).step, 2);
  });

  it('minor divisions follow AutoMinorLocator', () => {
    assert.strictEqual(minorDivisions(1), 5);
    assert.strictEqual(minorDivisions(2), 4);
    assert.strictEqual(minorDivisions(0.5), 5);
    assert.deepStrictEqual(minorTicks(0, 2, 1).map(v => Number(v.toFixed(6))), [0.2, 0.4, 0.6, 0.8, 1.2, 1.4, 1.6, 1.8]);
  });

  it('log ticks: decades with 2–9 minors, thinned over many decades', () => {
    const t = logTicks(1e-3, 1e2);
    assert.deepStrictEqual(t.major, [1e-3, 1e-2, 1e-1, 1, 10, 100]);
    assert.ok(t.minor.includes(0.002) && t.minor.includes(50));
    const wide = logTicks(1e-20, 1e5, 6);
    assert.ok(wide.major.length <= 6 && wide.major.length >= 3);
    const short = logTicks(2, 30);
    assert.deepStrictEqual(short.major, [2, 5, 10, 20]);
  });

  it('auto limits start at zero for non-negative data and add a margin', () => {
    assert.deepStrictEqual(autoDomain(1e-18, 1e-17, { zero: true }).map(v => Number(v.toPrecision(6))), [0, 1.05e-17]);
    const d = autoDomain(-2, 3, { zero: true });
    assert.ok(d[0] < -2 && d[1] > 3);
    assert.deepStrictEqual(autoDomain(250, 500, { margin: 0 }), [250, 500]);
    const lg = autoDomain(1, 1000, { log: true, margin: 0 });
    assert.ok(close(lg[0], 1) && close(lg[1], 1000));
  });

  it('maps linear, reversed and log scales', () => {
    const s = new Scale(250, 500, 0, 100);
    assert.strictEqual(s.map(375), 50);
    assert.strictEqual(s.invert(25), 312.5);
    const r = new Scale(4000, 400, 0, 100);
    assert.strictEqual(r.map(4000), 0);
    const l = new Scale(1, 1000, 0, 300, true);
    assert.ok(close(l.map(10), 100));
    assert.ok(close(l.invert(200), 100));
  });

  it('places secondary eV ticks above nm at λ = 1239.84 / E', () => {
    const f = (v: number) => 1239.84 / v;
    const t = secondaryTicks(250, 500, f, f, 6);
    const values = t.major.map(m => m.value);
    assert.deepStrictEqual(values, [2.5, 3, 3.5, 4, 4.5]);
    t.major.forEach(m => assert.ok(close(m.at, 1239.84 / m.value)));
    assert.ok(close(t.major.find(m => m.value === 3)!.at, 413.28));
    assert.ok(t.major.every(m => m.at >= 250 && m.at <= 500));
    assert.ok(t.minor.length > 0 && t.minor.every(v => v >= 250 && v <= 500));
  });
});

describe('charts: format', () => {
  it('uses U+2212 and no negative zero', () => {
    const r = formatLinearTicks([-1, -0.5, 0, 0.5]);
    assert.deepStrictEqual(r.labels, [`${MINUS}1.0`, `${MINUS}0.5`, '0.0', '0.5']);
    assert.ok(!r.labels.some(l => l.includes('-')));
  });

  it('shows the shortest clean decimals', () => {
    assert.deepStrictEqual(formatLinearTicks([250, 300, 350]).labels, ['250', '300', '350']);
    assert.deepStrictEqual(formatLinearTicks([0, 0.25, 0.5]).labels, ['0.00', '0.25', '0.50']);
    assert.strictEqual(decimalsFor(0.2), 1);
    assert.strictEqual(decimalsFor(2.5), 1);
  });

  it('factors out ×10⁻¹⁸ for cross sections', () => {
    const r = formatLinearTicks([0, 2e-18, 4e-18, 6e-18, 8e-18, 1e-17, 1.2e-17], 2e-18);
    assert.strictEqual(r.exponent, -18);
    assert.deepStrictEqual(r.labels, ['0', '2', '4', '6', '8', '10', '12']);
    assert.strictEqual(factorMarkup(-18), `10^{${MINUS}18}`);
    assert.strictEqual(labelWithFactor('σ / cm^{2} molecule^{−1}', -18), `σ / 10^{${MINUS}18} cm^{2} molecule^{−1}`);
    assert.strictEqual(labelWithFactor('counts', 5), undefined);
    // a single zero tick on a tiny range still gets the factor of its step
    assert.strictEqual(formatLinearTicks([0], 2e-18).exponent, -18);
    assert.strictEqual(formatLinearTicks([1e5, 2e5, 3e5]).exponent, 5);
  });

  it('formats log ticks as plain numbers or 10^{n}', () => {
    assert.deepStrictEqual(formatLogTicks([0.1, 1, 10, 100]).labels, ['0.1', '1', '10', '100']);
    assert.deepStrictEqual(formatLogTicks([0.16, 0.18, 0.2, 0.22]).labels, ['0.16', '0.18', '0.20', '0.22']);
    assert.deepStrictEqual(formatLogTicks([1e-20, 1e-18]).labels, [`10^{${MINUS}20}`, `10^{${MINUS}18}`]);
  });

  it('formats readout values with 4 significant digits', () => {
    assert.strictEqual(formatValue(345.678), '345.7');
    assert.strictEqual(formatValue(-0.5), `${MINUS}0.5`);
    assert.strictEqual(formatValue(1.2345e-17), '1.235×10⁻¹⁷');
    assert.strictEqual(formatValue(0), '0');
  });
});

describe('charts: decimation', () => {
  const n = 100000;
  const x = Float64Array.from({ length: n }, (_, i) => i);
  const y = Float64Array.from({ length: n }, (_, i) => Math.sin(i / 500));
  y[31337] = 50;
  y[77777] = -40;

  it('keeps the min and max of every pixel column, including spikes', () => {
    const d = decimateMinMax(x, y, 0, n - 1, 500);
    assert.ok(d.x.length <= 4 * 501);
    assert.ok(d.y.includes(50) && d.y.includes(-40));
    // per column min/max preserved
    for (let c = 0; c < 500; c += 37) {
      const a = Math.ceil((c * (n - 1)) / 500);
      const b = Math.ceil(((c + 1) * (n - 1)) / 500);
      let lo = Infinity, hi = -Infinity;
      for (let i = a; i < b; i++) {
        lo = Math.min(lo, y[i]);
        hi = Math.max(hi, y[i]);
      }
      let dlo = Infinity, dhi = -Infinity;
      d.x.forEach((xv, k) => {
        if (xv >= a && xv < b) {
          dlo = Math.min(dlo, d.y[k]);
          dhi = Math.max(dhi, d.y[k]);
        }
      });
      assert.strictEqual(dlo, lo);
      assert.strictEqual(dhi, hi);
    }
    // order of x preserved
    for (let i = 1; i < d.x.length; i++) {
      assert.ok(d.x[i] >= d.x[i - 1]);
    }
  });

  it('crops to the visible window (plus one point each side) and keeps short lines', () => {
    assert.deepStrictEqual(visibleRange(x, 100.5, 200.5, 1), [100, 202]);
    const rev = Float64Array.from(x).reverse();
    const [a, b] = visibleRange(rev, 100.5, 200.5, -1);
    assert.ok(rev[a] >= 200.5 && rev[b - 1] <= 100.5);
    assert.strictEqual(monotonic([1, 2, 2, 3]), 1);
    assert.strictEqual(monotonic([3, 1, 2]), 0);
    const short = prepareLine([1, 2, 3], [4, 5, 6], 0, 10, 100);
    assert.strictEqual(short.i1 - short.i0, 3);
    const long = prepareLine(x, y, 0, n - 1, 400);
    assert.ok(long.i1 < 2000 && Array.from(long.y).includes(50));
  });
});

describe('charts: colormaps', () => {
  it('has matplotlib endpoints', () => {
    assert.strictEqual(colorAt('viridis', 0), '#440154');
    assert.strictEqual(colorAt('viridis', 1), '#fde725');
    assert.strictEqual(colorAt('magma', 0), '#000004');
    assert.strictEqual(colorAt('cividis', 0), '#00224e');
    assert.strictEqual(colorAt('diverging', 0), '#053061');
    assert.strictEqual(colorAt('diverging', 1), '#67001f');
    // clamped, and the diverging middle is near white
    assert.strictEqual(colorAt('viridis', 2), '#fde725');
    assert.ok(contrast(colorAt('diverging', 0.5), '#ffffff') < 1.1);
    assert.strictEqual(colormapStops('magma').length, 33);
  });

  it('centres diverging limits on zero', () => {
    assert.deepStrictEqual(colorLimits([[-1, 3], [2, 0]], 'diverging'), [-3, 3]);
    assert.deepStrictEqual(colorLimits([[-1, 3], [2, 0]], 'viridis'), [-1, 3]);
  });
});

describe('charts: rich text', () => {
  it('parses ^{…}, _{…} and Unicode scripts', () => {
    assert.deepStrictEqual(parseRich('σ / cm^{2} molecule^{-1}'), [
      { text: 'σ / cm', level: 0 }, { text: '2', level: 1 }, { text: ' molecule', level: 0 }, { text: '−1', level: 1 }
    ]);
    assert.deepStrictEqual(parseRich('E_{pot}'), [{ text: 'E', level: 0 }, { text: 'pot', level: -1 }]);
    assert.deepStrictEqual(parseRich('cm⁻¹'), [{ text: 'cm', level: 0 }, { text: '−1', level: 1 }]);
    assert.deepStrictEqual(parseRich('x^{a_{b}}'), [{ text: 'x', level: 0 }, { text: 'a', level: 1 }, { text: 'b', level: 0 }]);
    assert.deepStrictEqual(parseRich('file_name^2'), [{ text: 'file_name^2', level: 0 }]);
  });

  it('renders tspans with numeric dy and a smaller size', () => {
    const svg = richSvg(parseRich('cm^{2}'), { size: 10 });
    assert.match(svg, /^cm<tspan dy="-3\.6" font-size="7">2<\/tspan>$/);
    const back = richSvg(parseRich('a_{i} b'), { size: 10 });
    assert.match(back, /<tspan dy="1\.7" font-size="7">i<\/tspan><tspan dy="-1\.7"> b<\/tspan>/);
    assert.strictEqual(plainText('σ / cm^{2} molecule^{−1}'), 'σ / cm² molecule⁻¹');
  });

  it('measures with Arial metrics and wraps long labels', () => {
    assert.ok(close(arimoMeasure('0', 10), 5.56, 1e-6));
    const lines = wrapRuns(parseRich('σ / 10^{−18} cm^{2} molecule^{−1}'), 9, arimoMeasure, 70);
    assert.strictEqual(lines.length, 2);
    assert.ok(lines.every(l => l.length > 0));
  });

  it('places accents of ν̃ explicitly as a spacing tilde', () => {
    const svg = richSvg(parseRich('ν̃'), { size: 10, explicitMarks: true });
    assert.match(svg, /ν<tspan dx="-4\.1[67]">˜<\/tspan>/);
  });
});

describe('charts: layout', () => {
  it('stacks panels with shared margins and height ratios', () => {
    const reqs = [{ left: 30, right: 5, top: 5, bottom: 4 }, { left: 40, right: 2, top: 4, bottom: 25 }];
    const b = stackLayout(234, 200, 2, reqs, [2, 1], 4);
    assert.strictEqual(b[0].x, b[1].x);
    assert.strictEqual(b[0].x, 42);
    assert.strictEqual(b[0].w, 234 - 4 - 40 - 5);
    assert.ok(close(b[0].h, 2 * b[1].h));
    assert.ok(close(b[1].y + b[1].h + 25 + 2, 200));
  });

  it('lays out grids and keeps equal aspect boxes centred', () => {
    const b = gridLayout(300, 200, 0, Array.from({ length: 4 }, () => ({ left: 10, right: 0, top: 0, bottom: 10 })), 2, 10, 10);
    assert.strictEqual(b.length, 4);
    assert.strictEqual(b[1].x, b[0].x + b[0].w + 10 + 10);
    assert.strictEqual(b[2].y, b[0].y + b[0].h + 10 + 10);
    const e = equalAspectBox({ x: 0, y: 0, w: 200, h: 100 }, 4, 4);
    assert.deepStrictEqual(e, { x: 50, y: 0, w: 100, h: 100 });
  });

  it('screen height and tick budget', () => {
    assert.strictEqual(screenHeight(1000), 560);
    assert.strictEqual(screenHeight(300), 260);
    assert.strictEqual(screenHeight(3000), 620);
    assert.strictEqual(screenHeight(800, 400), 400);
    assert.strictEqual(maxTickCount(160, 16), 11);
  });
});

describe('charts: CSV and SVG export', () => {
  const x = [250, 300, 350];
  const fig: Figure = {
    panels: [{
      x: { label: 'λ / nm' }, y: { label: 'σ / cm^{2}' },
      series: [
        { type: 'band', x, lo: [0, 1, 2], hi: [2, 3, 4], group: 'A' },
        { type: 'line', x: [250, 300, 350], y: [1, 2, 3], label: 'A', group: 'A' },
        { type: 'line', x: [260, 280], y: [5, 6], label: 'exp, "Ting"' },
        { type: 'hline', value: 0 }
      ]
    }]
  };

  it('builds one x column per distinct x array', () => {
    const csv = buildCsv(fig).trim().split('\n');
    assert.strictEqual(csv[0], 'λ / nm,A lo,A hi,A,λ / nm,"exp, ""Ting"""');
    assert.strictEqual(csv.length, 4);
    assert.strictEqual(csv[1], '250,0,2,1,260,5');
    assert.strictEqual(csv[3], '350,2,4,3,,');
  });

  it('writes a standalone SVG in pt with concrete colours and editable text', () => {
    const svg = svgString(fig, { size: { widthIn: 3.25, heightIn: 2.4 } });
    assert.match(svg, /^<\?xml/);
    assert.match(svg, /width="234pt" height="172\.8pt" viewBox="0 0 234 172\.8"/);
    assert.match(svg, /font-family="Arial, Helvetica, Arimo, sans-serif"/);
    assert.ok(!svg.includes('var('));
    assert.ok(svg.includes('>σ / cm<tspan'));
    assert.ok(svg.includes('fill-opacity="0.22"'));
    // band drawn before (under) its curve
    assert.ok(svg.indexOf('fill-opacity="0.22"') < svg.indexOf('stroke-width="1.25"'));
  });
});

describe('charts: publication legend placement', () => {
  const xs = Array.from({ length: 101 }, (_, i) => i);
  const legendY = (svg: string) => Number(/<g class="chart-legend">.*?<text x="[\d.]+" y="([\d.]+)"/.exec(svg)![1]);
  const frameTop = (svg: string) => Number(/<clipPath id="[^"]*clip0"><rect x="[\d.]+" y="([\d.]+)"/.exec(svg)![1]);

  it('keeps an auto legend inside when a corner is free', () => {
    const fig: Figure = { panels: [{ x: {}, y: {}, series: [{ type: 'line', x: xs, y: xs.map(x => Math.exp(-((x - 20) ** 2) / 50)), label: 'peak' }] }] };
    const svg = svgString(fig, { size: { widthIn: 3.25, heightIn: 2.4 } });
    assert.ok(legendY(svg) > frameTop(svg));
  });

  it('moves an auto legend above the frame when every corner holds data', () => {
    const fig: Figure = {
      panels: [{
        x: {}, y: {},
        series: [
          { type: 'line', x: xs, y: xs.map(() => 1), label: 'a rather long series name number one' },
          { type: 'line', x: xs, y: xs.map(() => 0), label: 'a rather long series name number two' },
          { type: 'line', x: xs, y: xs.map(x => x / 100), label: 'three' }
        ]
      }]
    };
    const svg = svgString(fig, { size: { widthIn: 3.25, heightIn: 2.4 } });
    assert.ok(legendY(svg) < frameTop(svg), `legend at ${legendY(svg)}, frame top ${frameTop(svg)}`);
  });
});
