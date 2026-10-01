/**
 * Build-time GLSL minification for the library and IIFE builds (vite.lib.config.ts,
 * vite.element.config.ts).
 *
 * The shaders are template literals in src/core; a consumer's minifier never touches the inside
 * of a string, so their comments and indentation would ship to every app. This plugin rewrites
 * the static parts of every template literal that looks like GLSL:
 *
 * - comments are removed (a block comment becomes a space, as in GLSL);
 * - indentation, trailing and repeated whitespace go away;
 * - spaces between tokens are dropped unless they separate two word characters or would glue
 *   two operator characters into another token (`- -`, `/ /`, `< =` ...).
 *
 * What it never changes:
 * - newlines: every line stays a line, so preprocessor directives still end where they did,
 *   driver error line numbers still match the readable source, and the sourcemaps of the code
 *   around the shaders stay valid (lines do not move, hence `map: null`);
 * - preprocessor lines beyond trimming and collapsing whitespace runs (a space between a macro
 *   name and `(` is meaningful);
 * - the whitespace next to an interpolation (`#ifndef ${name}` must keep its space), and any
 *   template whose interpolation sits inside a comment, contains a backslash (escapes, line
 *   continuations) or is a tagged template: those are left alone.
 *
 * Every rewritten line is re-tokenized and compared with the original; a mismatch fails the
 * build instead of shipping a broken shader.
 */

import { parseAst } from 'vite';

/** Stands for an interpolation while a template is processed as one string. */
const HOLE = '\u0000';

const PREPROCESSOR =
  /(?:^|\n)[ \t]*#[ \t]*(?:version|define|undef|if|ifdef|ifndef|elif|else|endif|extension|pragma|line)\b/;
const DECLARATION =
  /\b(?:void|float|u?int|bool|[iub]?vec[234]|mat[234]|uniform|precision|sampler2D|struct)\b/;

/**
 * True for the parts (raw strings between interpolations) of a multi-line template literal that
 * reads as GLSL: a preprocessor directive, or a GLSL type keyword plus a statement end.
 */
export function looksLikeGlsl(parts) {
  const text = parts.join(' ');
  if (!text.includes('\n')) return false;
  return PREPROCESSOR.test(text) || (DECLARATION.test(text) && text.includes(';'));
}

const isWord = (c) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c) => c >= '0' && c <= '9';

/** Two characters that must not touch: they would read as one token or start a comment. */
const GLUES = new Set([
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '^^',
  '<<',
  '>>',
  '&=',
  '|=',
  '^=',
  '//',
  '/*',
  '*/',
]);

function needsSpace(left, right) {
  if (left === HOLE || right === HOLE) return true;
  if (isWord(left) && isWord(right)) return true;
  // `1 .5` or `a. 5` would turn into one number.
  if ((isDigit(left) && right === '.') || (left === '.' && isDigit(right))) return true;
  return GLUES.has(left + right);
}

/**
 * Removes comments, keeping the line structure: a block comment becomes one space plus the
 * newlines it spanned. Returns null when that would be unsafe (an interpolation inside a comment,
 * a multi-line block comment on a preprocessor line, an unterminated comment).
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = src.length;
      if (src.slice(i, end).includes(HOLE)) return null;
      i = end;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) return null;
      const body = src.slice(i, close + 2);
      if (body.includes(HOLE)) return null;
      const newlines = body.split('\n').length - 1;
      const line = out.slice(out.lastIndexOf('\n') + 1);
      if (newlines > 0 && /^[ \t]*#/.test(line)) return null;
      out += ` ${'\n'.repeat(newlines)}`;
      i = close + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Minifies one comment-free line. */
function minifyLine(line) {
  const text = line.replace(/[ \t\r\f\v]+/g, ' ').trim();
  if (text.startsWith('#')) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === ' ' && !needsSpace(text[i - 1] ?? '', text[i + 1] ?? '')) continue;
    out += c;
  }
  return out;
}

const NUMBER =
  /^(?:0[xX][0-9a-fA-F]+[uU]?|(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?[fF]?|\d+[eE][+-]?\d+[fF]?|\d+[uU]?)/;
const IDENT = /^[A-Za-z_]\w*/;
const OPERATOR = /^(?:<<=|>>=|\+\+|--|[+\-*/%<>=!&|^]=|&&|\|\||\^\^|<<|>>|[^\s\w])/;

/** GLSL tokens of a line (interpolations are tokens; directive lines compare as normalized text). */
function tokenize(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('#')) return [trimmed.replace(/[ \t\r\f\v]+/g, ' ')];
  const tokens = [];
  let rest = trimmed;
  while (rest.length > 0) {
    const ws = /^[ \t\r\f\v]+/.exec(rest);
    if (ws) {
      rest = rest.slice(ws[0].length);
      continue;
    }
    if (rest[0] === HOLE) {
      tokens.push(HOLE);
      rest = rest.slice(1);
      continue;
    }
    const m = NUMBER.exec(rest) ?? IDENT.exec(rest) ?? OPERATOR.exec(rest);
    const token = m ? m[0] : (rest[0] ?? '');
    tokens.push(token);
    rest = rest.slice(token.length);
  }
  return tokens;
}

/**
 * Minifies the parts (raw strings between interpolations) of a GLSL template literal. Returns the
 * new parts, or null when the template is left as it is. Throws when the result would not
 * tokenize like the source (a bug here, never shipped).
 */
export function minifyGlsl(parts) {
  if (parts.some((p) => p.includes(HOLE) || p.includes('\\'))) return null;
  const stripped = stripComments(parts.join(HOLE));
  if (stripped === null) return null;
  const lines = stripped.split('\n');
  const out = lines.map(minifyLine);
  for (let i = 0; i < lines.length; i++) {
    const a = tokenize(lines[i] ?? '');
    const b = tokenize(out[i] ?? '');
    if (a.length !== b.length || a.some((t, k) => t !== b[k])) {
      const show = (s) => (s ?? '').trim().replaceAll(HOLE, '<interpolation>');
      throw new Error(`glsl-minify: line changed meaning:\n  ${show(lines[i])}\n  ${show(out[i])}`);
    }
  }
  const result = out.join('\n').split(HOLE);
  if (result.length !== parts.length) throw new Error('glsl-minify: interpolation count changed');
  return result;
}

/** Template literals of an ESTree program, except tagged templates. */
function templateLiterals(program) {
  const found = [];
  const skip = new Set();
  const stack = [program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const n of node) if (n && typeof n === 'object') stack.push(n);
      continue;
    }
    if (node.type === 'TaggedTemplateExpression') skip.add(node.quasi);
    if (node.type === 'TemplateLiteral' && !skip.has(node)) found.push(node);
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      const v = node[key];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return found;
}

/** Offset of a template element's raw text (spans may or may not include the delimiters). */
function rawStart(code, quasi) {
  const raw = quasi.value.raw;
  for (const at of [quasi.start, quasi.start + 1]) if (code.startsWith(raw, at)) return at;
  throw new Error(`glsl-minify: cannot locate a template part at offset ${quasi.start}`);
}

/**
 * Minifies the GLSL template literals of one module. `parse` returns an ESTree program with
 * UTF-16 `start`/`end` offsets. Returns null when nothing changed.
 *
 * Line endings are normalized to LF first: a template's raw value never holds a CR (the spec
 * turns CRLF and a lone CR into LF), so in a CRLF file it would not match the source text. Every
 * line terminator stays one line terminator, so lines do not move and the plugin's `map: null`
 * stays valid. The returned code is LF; `saved` counts the removed CRs too.
 */
export function minifyGlslSource(source, parse) {
  const code = source.includes('\r') ? source.replace(/\r\n?/g, '\n') : source;
  const edits = [];
  let templates = 0;
  for (const tpl of templateLiterals(parse(code))) {
    const parts = tpl.quasis.map((q) => q.value.raw);
    if (!looksLikeGlsl(parts)) continue;
    const next = minifyGlsl(parts);
    if (!next) continue;
    let changed = false;
    tpl.quasis.forEach((q, i) => {
      const raw = q.value.raw;
      const value = next[i] ?? raw;
      if (value === raw) return;
      const at = rawStart(code, q);
      edits.push({ at, end: at + raw.length, value });
      changed = true;
    });
    if (changed) templates++;
  }
  if (edits.length === 0) return null;
  edits.sort((a, b) => b.at - a.at);
  let out = code;
  for (const e of edits) out = out.slice(0, e.at) + e.value + out.slice(e.end);
  return { code: out, templates, saved: source.length - out.length };
}

/** Vite plugin: minifies GLSL template literals in the modules matching `include`. */
export function glslMinify(options = {}) {
  const include = options.include ?? /[\\/]src[\\/]core[\\/].+\.ts$/;
  let templates = 0;
  let saved = 0;
  return {
    name: 'lumicells:glsl-minify',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      templates = 0;
      saved = 0;
    },
    transform(code, id) {
      const file = id.split('?')[0] ?? id;
      if (!include.test(file)) return null;
      const lang = file.endsWith('.tsx') ? 'tsx' : file.endsWith('.ts') ? 'ts' : 'js';
      const result = minifyGlslSource(code, (c) => parseAst(c, { lang }, file));
      if (!result) return null;
      templates += result.templates;
      saved += result.saved;
      // Lines never move, so the existing mappings stay valid.
      return { code: result.code, map: null };
    },
    buildEnd() {
      if (templates > 0) {
        this.info(`minified ${templates} GLSL template(s), ${saved} characters removed`);
      }
    },
  };
}
