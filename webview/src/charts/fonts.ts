// Arimo (metric-compatible with Arial) for exports. The fontsource package
// ships per-script subsets as WOFF/WOFF2 only:
//  - PNG: the WOFF2 files are embedded as base64 @font-face in the SVG that is
//    rasterized (an SVG drawn as an image cannot load fonts by URL);
//  - PDF: jsPDF needs TrueType, so the WOFF1 files are unpacked to SFNT here
//    (WOFF1 = zlib-compressed tables, inflated with DecompressionStream), and
//    every subset becomes its own jsPDF font; text runs are split by subset.

import latin400 from '@fontsource/arimo/files/arimo-latin-400-normal.woff';
import latin700 from '@fontsource/arimo/files/arimo-latin-700-normal.woff';
import greek400 from '@fontsource/arimo/files/arimo-greek-400-normal.woff';
import greek700 from '@fontsource/arimo/files/arimo-greek-700-normal.woff';
import latinExt400 from '@fontsource/arimo/files/arimo-latin-ext-400-normal.woff';
import latinExt700 from '@fontsource/arimo/files/arimo-latin-ext-700-normal.woff';
import latin400w2 from '@fontsource/arimo/files/arimo-latin-400-normal.woff2';
import latin700w2 from '@fontsource/arimo/files/arimo-latin-700-normal.woff2';
import greek400w2 from '@fontsource/arimo/files/arimo-greek-400-normal.woff2';
import greek700w2 from '@fontsource/arimo/files/arimo-greek-700-normal.woff2';
import latinExt400w2 from '@fontsource/arimo/files/arimo-latin-ext-400-normal.woff2';
import latinExt700w2 from '@fontsource/arimo/files/arimo-latin-ext-700-normal.woff2';

export type Subset = 'latin' | 'greek' | 'latin-ext';

/** Unicode ranges of the subsets (from @fontsource/arimo/unicode.json). */
const RANGES: Record<Subset, string> = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0300-0301,U+0303-0304,U+0308-0309,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  greek: 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'
};

const WOFF: Record<Subset, [string, string]> = {
  latin: [latin400, latin700],
  greek: [greek400, greek700],
  'latin-ext': [latinExt400, latinExt700]
};
const WOFF2: Record<Subset, [string, string]> = {
  latin: [latin400w2, latin700w2],
  greek: [greek400w2, greek700w2],
  'latin-ext': [latinExt400w2, latinExt700w2]
};

const parsed = new Map<Subset, [number, number][]>();
function ranges(s: Subset): [number, number][] {
  let r = parsed.get(s);
  if (!r) {
    r = RANGES[s].split(',').map(part => {
      const [a, b] = part.replace('U+', '').split('-');
      return [parseInt(a, 16), parseInt(b ?? a, 16)] as [number, number];
    });
    parsed.set(s, r);
  }
  return r;
}

/** Subset that contains a code point (latin for anything not covered). */
export function subsetOf(cp: number): Subset {
  for (const s of ['latin', 'greek', 'latin-ext'] as Subset[]) {
    if (ranges(s).some(([a, b]) => cp >= a && cp <= b)) {
      return s;
    }
  }
  return 'latin';
}

/** Subsets needed for a text. */
export function subsetsFor(text: string): Set<Subset> {
  const out = new Set<Subset>(['latin']);
  for (const ch of text) {
    out.add(subsetOf(ch.codePointAt(0)!));
  }
  return out;
}

// --- asset URLs ----------------------------------------------------------------

// Asset URLs from esbuild are relative to the bundle, not to the document
// (in VS Code the document is the webview shell), so resolve them against the
// script that is running now.
const scriptBase: string | undefined = (() => {
  try {
    const src = (typeof document !== 'undefined' && (document.currentScript as HTMLScriptElement | null)?.src) || undefined;
    return src ? src.replace(/[^/]*$/, '') : undefined;
  } catch {
    return undefined;
  }
})();

export function assetUrl(rel: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(rel)) {
    return rel;
  }
  const appBase = typeof document !== 'undefined' ? document.getElementById('app')?.dataset.assetBase : undefined;
  const base = scriptBase ?? (appBase ? new URL(appBase, document.baseURI).href : document.baseURI);
  return new URL(rel.replace(/^\.\//, ''), base).href;
}

const bytesCache = new Map<string, Promise<Uint8Array>>();
function fetchBytes(rel: string): Promise<Uint8Array> {
  let p = bytesCache.get(rel);
  if (!p) {
    p = fetch(assetUrl(rel)).then(async r => {
      if (!r.ok) {
        throw new Error(`font ${rel}: HTTP ${r.status}`);
      }
      return new Uint8Array(await r.arrayBuffer());
    });
    p.catch(() => bytesCache.delete(rel));
    bytesCache.set(rel, p);
  }
  return p;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

// --- WOFF1 -> SFNT ---------------------------------------------------------------

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Unpacks a WOFF 1.0 file into the TrueType/OpenType file it wraps. */
export async function woffToSfnt(woff: Uint8Array): Promise<Uint8Array> {
  const dv = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (dv.getUint32(0) !== 0x774f4646) {
    throw new Error('not a WOFF 1.0 file');
  }
  const flavor = dv.getUint32(4);
  const numTables = dv.getUint16(12);
  const tables: { tag: number; checksum: number; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    const tag = dv.getUint32(o);
    const offset = dv.getUint32(o + 4);
    const compLength = dv.getUint32(o + 8);
    const origLength = dv.getUint32(o + 12);
    const checksum = dv.getUint32(o + 16);
    const raw = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? await inflate(raw) : raw.slice();
    if (data.length !== origLength) {
      throw new Error('corrupt WOFF table');
    }
    tables.push({ tag, checksum, data });
  }
  tables.sort((a, b) => a.tag - b.tag);
  const headerLen = 12 + 16 * numTables;
  let total = headerLen;
  for (const t of tables) {
    total += (t.data.length + 3) & ~3;
  }
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  let es = 0;
  while (2 ** (es + 1) <= numTables) {
    es++;
  }
  const searchRange = 2 ** es * 16;
  ov.setUint32(0, flavor);
  ov.setUint16(4, numTables);
  ov.setUint16(6, searchRange);
  ov.setUint16(8, es);
  ov.setUint16(10, numTables * 16 - searchRange);
  let offset = headerLen;
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    ov.setUint32(r, t.tag);
    ov.setUint32(r + 4, t.checksum);
    ov.setUint32(r + 8, offset);
    ov.setUint32(r + 12, t.data.length);
    out.set(t.data, offset);
    offset += (t.data.length + 3) & ~3;
  });
  return out;
}

// --- PDF fonts ---------------------------------------------------------------------

export interface PdfFont {
  subset: Subset;
  /** Family name used in the SVG, in jsPDF and in the document (for svg2pdf's measuring). */
  family: string;
  regular: Uint8Array;
  bold: Uint8Array;
}

export function pdfFamily(subset: Subset): string {
  return `OrbitalArimo${subset === 'latin' ? '' : subset === 'greek' ? 'Greek' : 'LatinExt'}`;
}

const documentFaces = new Set<string>();

/**
 * Loads the subsets as TrueType for jsPDF and registers the same files under
 * the same family names with the document, so svg2pdf measures text with the
 * very font that ends up in the PDF.
 */
export async function loadPdfFonts(subsets: Iterable<Subset>): Promise<PdfFont[]> {
  const list = [...new Set(subsets)];
  return Promise.all(list.map(async subset => {
    const [r, b] = await Promise.all(WOFF[subset].map(fetchBytes));
    const family = pdfFamily(subset);
    if (typeof FontFace !== 'undefined' && !documentFaces.has(family)) {
      const faces = [new FontFace(family, r.slice().buffer as ArrayBuffer, { weight: '400' }), new FontFace(family, b.slice().buffer as ArrayBuffer, { weight: '700' })];
      await Promise.all(faces.map(face => face.load()));
      faces.forEach(face => document.fonts.add(face));
      documentFaces.add(family);
    }
    const [regular, bold] = await Promise.all([woffToSfnt(r), woffToSfnt(b)]);
    return { subset, family, regular, bold };
  }));
}

// --- PNG fonts ------------------------------------------------------------------------

/** @font-face rules embedding Arimo (WOFF2, base64) for an SVG that is drawn as an image. */
export async function embeddedFontCss(subsets: Iterable<Subset>): Promise<string> {
  const rules: string[] = [];
  for (const subset of new Set(subsets)) {
    const [r, b] = await Promise.all(WOFF2[subset].map(fetchBytes));
    for (const [bytes, weight] of [[r, 400], [b, 700]] as [Uint8Array, number][]) {
      rules.push(`@font-face{font-family:'Arimo';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${toBase64(bytes)}) format('woff2');unicode-range:${RANGES[subset]};}`);
    }
  }
  return rules.join('');
}
