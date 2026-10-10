// Tiny tokenizers for the live input preview: ORCA .inp and Python. The
// tokens are lossless (their texts concatenate to the input), so the UI can
// render them as colored spans. Pure, no DOM; safe to import in the webview.

import { isKnownSimpleKeyword } from '../keywords';
import { atomicNumber } from '../chem/elements';

export type TokenKind =
  | 'comment' | 'keyword' | 'block' | 'option' | 'number' | 'string' | 'element'
  | 'punct' | 'builtin' | 'function' | 'text' | 'whitespace';

export interface Token {
  text: string;
  kind: TokenKind;
}

function push(out: Token[], text: string, kind: TokenKind): void {
  if (!text) {
    return;
  }
  const last = out[out.length - 1];
  if (last && last.kind === kind && (kind === 'whitespace' || kind === 'text' || kind === 'comment')) {
    last.text += text;
  } else {
    out.push({ text, kind });
  }
}

const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Splits a code fragment into words, whitespace and punctuation. */
function words(code: string): string[] {
  return code.match(/\s+|"[^"]*"?|[A-Za-z0-9_.+\-/()*[\]]+|./g) ?? [];
}

export function tokenizeOrca(text: string): Token[] {
  const out: Token[] = [];
  const lines = text.split(/(\r\n|\r|\n)/);
  let inBlock = false;
  let inCoords = false;
  for (const line of lines) {
    if (/^(\r\n|\r|\n)$/.test(line)) {
      push(out, line, 'whitespace');
      continue;
    }
    const hash = line.indexOf('#');
    const code = hash >= 0 ? line.slice(0, hash) : line;
    const comment = hash >= 0 ? line.slice(hash) : '';
    const trimmed = code.trim();

    if (inCoords) {
      if (/^\*$/.test(trimmed)) {
        inCoords = false;
        for (const w of words(code)) push(out, w, /^\s+$/.test(w) ? 'whitespace' : 'punct');
      } else {
        let first = true;
        for (const w of words(code)) {
          if (/^\s+$/.test(w)) {
            push(out, w, 'whitespace');
          } else if (first && atomicNumber(w) !== undefined) {
            push(out, w, 'element');
            first = false;
          } else {
            push(out, w, NUMBER_RE.test(w) ? 'number' : 'text');
            first = false;
          }
        }
      }
    } else if (trimmed.startsWith('!')) {
      for (const w of words(code)) {
        if (/^\s+$/.test(w)) push(out, w, 'whitespace');
        else if (w === '!') push(out, w, 'punct');
        else push(out, w, isKnownSimpleKeyword(w) ? 'keyword' : 'text');
      }
    } else if (trimmed.startsWith('*')) {
      const oneLine = /^\*\s*\w*file\b/i.test(trimmed);
      inCoords = !oneLine;
      for (const w of words(code)) {
        if (/^\s+$/.test(w)) push(out, w, 'whitespace');
        else if (w === '*') push(out, w, 'punct');
        else if (NUMBER_RE.test(w)) push(out, w, 'number');
        else if (/^(xyz|xyzfile|int|internal|gzmt|gzmtfile|pdbfile)$/i.test(w)) push(out, w, 'keyword');
        else push(out, w, 'string');
      }
    } else {
      const startsBlock = /^%\s*[A-Za-z]/.test(trimmed);
      if (startsBlock && !/^%\s*(maxcore|moinp|base|id)\b/i.test(trimmed)) {
        inBlock = !/\bend\s*$/i.test(trimmed);
      }
      let first = true;
      for (const w of words(code)) {
        if (/^\s+$/.test(w)) {
          push(out, w, 'whitespace');
          continue;
        }
        if (w === '%' || /^%/.test(w)) {
          push(out, w, 'block');
        } else if (first && startsBlock) {
          push(out, w, 'block');
        } else if (/^end$/i.test(w)) {
          push(out, w, 'block');
          if (trimmed.toLowerCase() === 'end') {
            inBlock = false;
          }
        } else if (/^".*"?$/.test(w)) {
          push(out, w, 'string');
        } else if (NUMBER_RE.test(w)) {
          push(out, w, 'number');
        } else if (/^(true|false)$/i.test(w)) {
          push(out, w, 'keyword');
        } else if (/^[{}=,;[\]()]$/.test(w)) {
          push(out, w, 'punct');
        } else {
          push(out, w, inBlock || startsBlock ? 'option' : 'text');
        }
        if (w !== '%') {
          first = false;
        }
      }
    }
    push(out, comment, 'comment');
  }
  return out;
}

const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
]);
const PY_BUILTINS = new Set([
  'abs', 'all', 'any', 'bool', 'dict', 'enumerate', 'float', 'int', 'isinstance', 'len', 'list', 'max',
  'min', 'open', 'print', 'range', 'round', 'set', 'sorted', 'str', 'sum', 'tuple', 'zip', 'self', '__name__',
  '__doc__', '__file__'
]);

export function tokenizePython(text: string): Token[] {
  const out: Token[] = [];
  const re = /(#[^\r\n]*)|([rRbBuUfF]{0,2}("""|''')[\s\S]*?(\3|$))|([rRbBuUfF]{0,2}("|')(?:\\.|(?!\6)[^\\\r\n])*\6?)|(\b\d[\d_]*\.?[\d_]*(?:[eE][-+]?\d+)?j?\b|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_]\w*)|(\s+)|([^\sA-Za-z_\d#'"]+|.)/g;
  let m: RegExpExecArray | null;
  let prevWord = '';
  while ((m = re.exec(text)) !== null) {
    const [tok] = m;
    if (m[1] !== undefined) {
      push(out, tok, 'comment');
    } else if (m[2] !== undefined || m[5] !== undefined) {
      push(out, tok, 'string');
    } else if (m[7] !== undefined) {
      push(out, tok, 'number');
    } else if (m[8] !== undefined) {
      if (PY_KEYWORDS.has(tok)) {
        push(out, tok, 'keyword');
      } else if (prevWord === 'def' || prevWord === 'class') {
        push(out, tok, 'function');
      } else if (PY_BUILTINS.has(tok)) {
        push(out, tok, 'builtin');
      } else {
        push(out, tok, 'text');
      }
      prevWord = tok;
      continue;
    } else if (m[9] !== undefined) {
      push(out, tok, 'whitespace');
      continue;
    } else {
      push(out, tok, 'punct');
    }
    prevWord = '';
  }
  return out;
}
