// Small glob helpers shared by the calcs and runs tab hosts: brace expansion
// (to merge several exclude globs into one `{a,b,c}` pattern that both VS
// Code's findFiles and Node's path.matchesGlob accept), and a glob → RegExp
// matcher for paths that did not come from findFiles (watcher events).
// Pure, no Node or vscode imports.

/** 'a/{b,c}/{d,e}' → ['a/b/d', 'a/b/e', 'a/c/d', 'a/c/e'] (nested braces supported). */
export function expandBraces(glob: string): string[] {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        const inner = glob.slice(start + 1, i);
        const parts: string[] = [];
        let d = 0;
        let from = 0;
        for (let j = 0; j < inner.length; j++) {
          if (inner[j] === '{') d++;
          else if (inner[j] === '}') d--;
          else if (inner[j] === ',' && d === 0) {
            parts.push(inner.slice(from, j));
            from = j + 1;
          }
        }
        parts.push(inner.slice(from));
        const pre = glob.slice(0, start);
        const rest = expandBraces(glob.slice(i + 1));
        const out: string[] = [];
        for (const p of parts) for (const e of expandBraces(p)) for (const r of rest) out.push(pre + e + r);
        return out;
      }
    }
  }
  return [glob];
}

/** One glob for findFiles' `exclude` from several (each may contain braces); undefined for none. */
export function mergeGlobs(globs: string[]): string | undefined {
  const flat = [...new Set(globs.filter(Boolean).flatMap(expandBraces))];
  if (flat.length === 0) return undefined;
  return flat.length === 1 ? flat[0] : `{${flat.join(',')}}`;
}

/** RegExp for a glob over '/'-separated relative paths: **, *, ?, {a,b}, [abc]. */
export function globToRegExp(glob: string, ignoreCase = false): RegExp {
  const alts = expandBraces(glob).map(g => {
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*') {
        if (g[i + 1] === '*') {
          const slashAfter = g[i + 2] === '/';
          re += slashAfter ? '(?:.*/)?' : '.*';
          i += slashAfter ? 2 : 1;
        } else {
          re += '[^/]*';
        }
      } else if (c === '?') {
        re += '[^/]';
      } else if (c === '[') {
        const end = g.indexOf(']', i + 1);
        if (end > i) {
          re += `[${g.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
          i = end;
        } else {
          re += '\\[';
        }
      } else {
        re += c.replace(/[.+^${}()|\\]/g, '\\$&');
      }
    }
    return re;
  });
  return new RegExp(`^(?:${alts.join('|')})$`, ignoreCase ? 'i' : '');
}

/** Does the '/'-separated relative path (or any of its parent folders, for globs ending in /**) match? */
export function matchesAny(relPath: string, globs: string[], ignoreCase = false): boolean {
  const p = relPath.replace(/\\/g, '/');
  return globs.some(g => {
    const re = globToRegExp(g, ignoreCase);
    return re.test(p) || re.test(`${p}/`);
  });
}
