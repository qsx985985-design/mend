// main.ts is mend, the CLI SPEC.md specifies (MIT, from the kit's starter, extended).
// It does all of SPEC.md: the command line, output and exit codes, safe paths, format
// detection, the three matching tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9)
// and the all-or-nothing write (section 10). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, whether it ends with a line break. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 5: matching lines at three tiers ----

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

function occursAt(o: string[], lines: string[], i: number, tier: number): boolean {
  for (let k = 0; k < o.length; k++) {
    if (!lineEq(o[k]!, lines[i + k]!, tier)) return false;
  }
  return true;
}

function occurrences(o: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    if (occursAt(o, lines, i, tier)) out.push(i);
  }
  return out;
}

/** One line of an old/new pair: a context line carries its index into O. */
interface OE {
  text: string;
  ctx: boolean;
  oi: number;
}

/**
 * The replacement lines for a match at `pos` (tier already chosen). A context line is
 * written as the file's own matched line, never the patch's. At tier 2 every other line
 * of N is re-indented: P, the leading spaces and tabs of O's first line, is replaced by
 * F, those of the file's first matched line, where the line starts with P.
 */
function renderNew(n: OE[], o: OE[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const p = tier === 2 && o.length > 0 ? leadST(o[0]!.text) : '';
  const f = tier === 2 && o.length > 0 ? leadST(fileLines[pos]!) : '';
  for (const e of n) {
    if (e.ctx) {
      out.push(fileLines[pos + e.oi]!);
      continue;
    }
    const t = e.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

function tiersFor(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;
const isGitLine = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');

/** The path after the four characters of a `--- `/`+++ ` line, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function gitParts(l: string): [string, string] | null {
  if (!l.startsWith('diff --git a/')) return null;
  const rest = l.slice('diff --git a/'.length);
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  return [rest.slice(0, sep), rest.slice(sep + 3)];
}

/** Header lines before the first hunk: `--- `/`+++ ` pair, renames, file modes; the rest ignored. */
function uniHeader(lines: string[], i: number, sec: UniSection): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) return i;
    if (isGitLine(l)) return i;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        sec.pairOld = stripAB(headerPath(l));
        sec.pairNew = stripAB(headerPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('rename from ')) {
      sec.renameOld = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      sec.renameNew = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.creation = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.deletion = true;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

/** Hunks of a section, with the prose between them ignored, until the next section or the end. */
function uniHunks(lines: string[], i: number, sec: UniSection): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      i++;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          hunk.body.push(b);
          i++;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      sec.hunks.push(hunk);
    } else if (isGitLine(l)) {
      return i;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      return i;
    } else {
      i++;
    }
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const sections: UniSection[] = [];
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (isGitLine(l)) {
      const parts = gitParts(l);
      if (!parts) throw new Exit2(`error: parse ${i + 1}`);
      const sec: UniSection = {
        pairOld: null, pairNew: null, renameOld: null, renameNew: null,
        gitOld: parts[0], gitNew: parts[1], creation: false, deletion: false, hunks: [],
      };
      sections.push(sec);
      i++;
      i = uniHeader(lines, i, sec);
      i = uniHunks(lines, i, sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: UniSection = {
        pairOld: null, pairNew: null, renameOld: null, renameNew: null,
        gitOld: null, gitNew: null, creation: false, deletion: false, hunks: [],
      };
      sections.push(sec);
      i = uniHeader(lines, i, sec);
      i = uniHunks(lines, i, sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return sections.map((sec) => uniEdit(sec, strict));
}

/** A hunk's O (context and `-` lines) and N (context and `+` lines), plus whether a `\` line follows its last context or `+` line. */
function hunkON(h: Hunk): { o: OE[]; n: OE[]; noEol: boolean } {
  const o: OE[] = [];
  const n: OE[] = [];
  let oi = 0;
  let noEol = false;
  for (let j = 0; j < h.body.length; j++) {
    const b = h.body[j]!;
    const nextIsBackslash = j + 1 < h.body.length && h.body[j + 1]![0] === '\\';
    if (b === '') {
      o.push({ text: '', ctx: true, oi });
      n.push({ text: '', ctx: true, oi });
      oi++;
      noEol = nextIsBackslash;
    } else if (b[0] === ' ') {
      o.push({ text: b.slice(1), ctx: true, oi });
      n.push({ text: b.slice(1), ctx: true, oi });
      oi++;
      noEol = nextIsBackslash;
    } else if (b[0] === '-') {
      o.push({ text: b.slice(1), ctx: false, oi: -1 });
      oi++;
    } else if (b[0] === '+') {
      n.push({ text: b.slice(1), ctx: false, oi: -1 });
      noEol = nextIsBackslash;
    }
  }
  return { o, n, noEol };
}

/** Apply one hunk to a file's lines. `d` is the drift of this section's earlier hunks. */
function applyUniHunk(fs: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  const { o, n, noEol } = hunkON(h);
  const oTexts = o.map((e) => e.text);
  if (oTexts.length === 0) {
    const pos = Math.max(0, Math.min(h.a + d, fs.lines.length));
    const atEnd = pos === fs.lines.length;
    const out = [...fs.lines.slice(0, pos), ...n.map((e) => e.text), ...fs.lines.slice(pos)];
    return { br: fs.br, lines: out, final: atEnd ? !noEol : fs.final };
  }
  let tier = -1;
  let positions: number[] = [];
  for (const t of tiersFor(strict)) {
    positions = occurrences(oTexts, fs.lines, t, 0);
    if (positions.length > 0) {
      tier = t;
      break;
    }
  }
  if (tier < 0) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = positions[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of positions) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const atEnd = best + oTexts.length === fs.lines.length;
  const repl = renderNew(n, o, fs.lines, best, tier);
  const out = [...fs.lines.slice(0, best), ...repl, ...fs.lines.slice(best + oTexts.length)];
  return { br: fs.br, lines: out, final: atEnd ? !noEol : fs.final };
}

/** A created file's text: the `+` lines of all hunks, ending with a line break unless a `\` line follows its last `+` line. */
function creationText(hunks: Hunk[]): string {
  const plus: string[] = [];
  let noEol = false;
  for (const h of hunks) {
    for (let j = 0; j < h.body.length; j++) {
      const b = h.body[j]!;
      if (b[0] === '+') {
        plus.push(b.slice(1));
        noEol = j + 1 < h.body.length && h.body[j + 1]![0] === '\\';
      }
    }
  }
  if (plus.length === 0) return '';
  return plus.join('\n') + (noEol ? '' : '\n');
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld !== null ? sec.pairOld : sec.renameOld !== null ? sec.renameOld : sec.gitOld;
    const newP = sec.pairNew !== null ? sec.pairNew : sec.renameNew !== null ? sec.renameNew : sec.gitNew;
    const oldIsNull = oldP === null || oldP === '/dev/null';
    const newIsNull = newP === null || newP === '/dev/null';
    if (oldIsNull || sec.creation) {
      const p = newP;
      if (p === null || p === '/dev/null') throw new Fail('unsafe', '/dev/null');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, creationText(sec.hunks));
      return;
    }
    if (newIsNull || sec.deletion) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldPath = oldP!;
    const newPath = newP!;
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const text = tree.get(oldPath);
      if (text === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      let fs = parseFile(text);
      let d = 0;
      for (const h of sec.hunks) {
        const before = hunkON(h);
        fs = applyUniHunk(fs, h, d, strict, oldPath);
        d += before.n.length - before.o.length;
      }
      tree.now.set(oldPath, null);
      tree.now.set(newPath, renderFile(fs));
      tree.recordMove(oldPath, newPath);
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const text = tree.get(oldPath);
    if (text === null) throw new Fail('missing', oldPath);
    let fs = parseFile(text);
    let d = 0;
    for (const h of sec.hunks) {
      const before = hunkON(h);
      fs = applyUniHunk(fs, h, d, strict, oldPath);
      d += before.n.length - before.o.length;
    }
    tree.now.set(oldPath, renderFile(fs));
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j]!;
        if (blank(t)) continue;
        if (t.trim().startsWith('```')) continue;
        path = t.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
      const oldLines = lines.slice(i + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      edits.push(srEdit(path, oldLines, newLines, strict));
      prevPath = path;
      prevEnd = rep + 1;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const fs = parseFile(text);
    let tier = -1;
    let positions: number[] = [];
    for (const t of tiersFor(strict)) {
      positions = occurrences(oldLines, fs.lines, t, 0);
      if (positions.length > 0) {
        tier = t;
        break;
      }
    }
    if (tier < 0) throw new Fail('no-match', path);
    if (positions.length > 1) throw new Fail('ambiguous', path);
    const pos = positions[0]!;
    const o: OE[] = oldLines.map((text) => ({ text, ctx: false, oi: -1 }));
    const nn: OE[] = newLines.map((text) => ({ text, ctx: false, oi: -1 }));
    const repl = renderNew(nn, o, fs.lines, pos, tier);
    const out = [...fs.lines.slice(0, pos), ...repl, ...fs.lines.slice(pos + oldLines.length)];
    tree.now.set(path, renderFile({ br: fs.br, lines: out, final: fs.final }));
  };
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  moveTo: string | null;
  content: string[];
  chunks: VChunk[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const isHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let j = first + 1;
  while (j < last) {
    const l = lines[j]!;
    if (blank(l)) {
      j++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const sec: VSection = {
        kind: 'add', path: l.slice('*** Add File: '.length).trim(), headerLine: j + 1,
        moveTo: null, content: [], chunks: [],
      };
      j++;
      while (j < last) {
        const c = lines[j]!;
        if (isHeader(c)) break;
        if (c === '' || c[0] === '+') {
          sec.content.push(c);
          j++;
        } else throw new Exit2(`error: parse ${j + 1}`);
      }
      while (sec.content.length > 0 && sec.content[sec.content.length - 1] === '') sec.content.pop();
      edits.push(vEdit(sec, strict));
    } else if (l.startsWith('*** Delete File: ')) {
      const sec: VSection = {
        kind: 'delete', path: l.slice('*** Delete File: '.length).trim(), headerLine: j + 1,
        moveTo: null, content: [], chunks: [],
      };
      j++;
      while (j < last) {
        const c = lines[j]!;
        if (isHeader(c)) break;
        if (blank(c)) {
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(vEdit(sec, strict));
    } else if (l.startsWith('*** Update File: ')) {
      const sec: VSection = {
        kind: 'update', path: l.slice('*** Update File: '.length).trim(), headerLine: j + 1,
        moveTo: null, content: [], chunks: [],
      };
      j++;
      while (j < last) {
        const c = lines[j]!;
        if (isHeader(c)) break;
        sec.content.push(c);
        j++;
      }
      while (sec.content.length > 0 && blank(sec.content[sec.content.length - 1]!)) sec.content.pop();
      let k = 0;
      if (sec.content.length > 0 && sec.content[0]!.startsWith('*** Move to: ')) {
        sec.moveTo = sec.content[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      let cur: VChunk | null = null;
      while (k < sec.content.length) {
        const c = sec.content[k]!;
        const lineNo = sec.headerLine + 1 + k;
        if (c.startsWith('@@')) {
          const anchor = c.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          sec.chunks.push(cur);
          k++;
        } else if (c === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
          cur.eof = true;
          cur = null;
          k++;
        } else if (c === '' || c[0] === ' ' || c[0] === '-' || c[0] === '+') {
          if (cur === null) {
            if (sec.chunks.length === 0) {
              cur = { anchor: null, body: [], eof: false };
              sec.chunks.push(cur);
            } else throw new Exit2(`error: parse ${lineNo}`);
          }
          cur.body.push(c);
          k++;
        } else {
          throw new Exit2(`error: parse ${lineNo}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.headerLine}`);
      edits.push(vEdit(sec, strict));
    } else {
      throw new Exit2(`error: parse ${j + 1}`);
    }
  }
  return edits;
}

function chunkON(chunk: VChunk): { o: OE[]; n: OE[] } {
  const o: OE[] = [];
  const n: OE[] = [];
  let oi = 0;
  for (const b of chunk.body) {
    if (b === '') {
      o.push({ text: '', ctx: true, oi });
      n.push({ text: '', ctx: true, oi });
      oi++;
    } else if (b[0] === ' ') {
      o.push({ text: b.slice(1), ctx: true, oi });
      n.push({ text: b.slice(1), ctx: true, oi });
      oi++;
    } else if (b[0] === '-') {
      o.push({ text: b.slice(1), ctx: false, oi: -1 });
      oi++;
    } else if (b[0] === '+') {
      n.push({ text: b.slice(1), ctx: false, oi: -1 });
    }
  }
  return { o, n };
}

/** Apply one V4A chunk: the anchor first, then O at or after the cursor. Returns the file and the new cursor. */
function applyVChunk(fs: FileState, chunk: VChunk, cursor: number, strict: boolean, path: string): { fs: FileState; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null) {
    let found = -1;
    for (const t of tiersFor(strict)) {
      for (let idx = cur; idx < fs.lines.length; idx++) {
        if (lineEq(fs.lines[idx]!, chunk.anchor, t)) {
          found = idx;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found < 0) throw new Fail('no-match', path);
    cur = found + 1;
  }
  const { o, n } = chunkON(chunk);
  const oTexts = o.map((e) => e.text);
  if (oTexts.length === 0) {
    const pos = chunk.eof ? fs.lines.length : cur;
    const out = [...fs.lines.slice(0, pos), ...n.map((e) => e.text), ...fs.lines.slice(pos)];
    return { fs: { br: fs.br, lines: out, final: fs.final }, cursor: pos + n.length };
  }
  let tier = -1;
  let pos = -1;
  for (const t of tiersFor(strict)) {
    for (let idx = cur; idx + oTexts.length <= fs.lines.length; idx++) {
      if (chunk.eof && idx + oTexts.length !== fs.lines.length) continue;
      if (occursAt(oTexts, fs.lines, idx, t)) {
        pos = idx;
        tier = t;
        break;
      }
    }
    if (pos >= 0) break;
  }
  if (pos < 0) throw new Fail('no-match', path);
  const repl = renderNew(n, o, fs.lines, pos, tier);
  const out = [...fs.lines.slice(0, pos), ...repl, ...fs.lines.slice(pos + oTexts.length)];
  return { fs: { br: fs.br, lines: out, final: fs.final }, cursor: pos + repl.length };
}

function vEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines = sec.content.map((c) => (c === '' ? '' : c.slice(1)));
      tree.now.set(p, lines.length === 0 ? '' : lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let fs = parseFile(text);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      const r = applyVChunk(fs, chunk, cursor, strict, p);
      fs = r.fs;
      cursor = r.cursor;
    }
    const result = renderFile(fs);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, result);
      tree.recordMove(p, sec.moveTo);
    } else {
      tree.now.set(p, result);
    }
  };
}

// ---- Sections 1, 2 and 10: the command line, the output and the all-or-nothing write ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move that succeeded is one `R <old> -> <new>` line, sorting by <new>, in place of its `D` and `A` lines.
  const composed = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    let chained = false;
    for (const [k, v] of composed) {
      if (v === o) {
        composed.set(k, n);
        chained = true;
        break;
      }
    }
    if (!chained) composed.set(o, n);
  }
  const rPairs: [string, string][] = [];
  for (const [o, q] of composed) {
    const qNow = tree.now.get(q);
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(q) === null && qNow !== null && qNow !== undefined) {
      rPairs.push([o, q]);
    }
  }
  const rOlds = new Set(rPairs.map(([o]) => o));
  const rNews = new Set(rPairs.map(([, q]) => q));
  const rows: { key: string; text: string }[] = [];
  for (const [o, q] of rPairs) rows.push({ key: q, text: `R ${o} -> ${q}` });
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (rOlds.has(p) || rNews.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
