import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

// The script is plain JS (loaded by the build configs); load it without type-checking it here.
const scriptUrl = pathToFileURL(resolve(__dirname, '../scripts/glsl-minify.mjs')).href;
const { looksLikeGlsl, minifyGlsl, minifyGlslSource } = (await import(
  /* @vite-ignore */ scriptUrl
)) as {
  looksLikeGlsl(parts: readonly string[]): boolean;
  minifyGlsl(parts: readonly string[]): string[] | null;
  minifyGlslSource(
    code: string,
    parse: (code: string) => unknown,
  ): { code: string; templates: number; saved: number } | null;
};

const one = (src: string) => minifyGlsl([src])?.[0];
const lines = (s: string) => s.split('\n').length;

describe('minifyGlsl', () => {
  it('drops comments, indentation and spaces around operators, keeping every line', () => {
    const src = [
      '',
      '// A helper.',
      'float sat(float x) {',
      '  return clamp(x, 0.0, 1.0); // clamp',
      '}',
      '/* block',
      '   comment */ vec2 a = vec2(1.0) * 2.0;',
      '',
    ].join('\n');
    const out = one(src) as string;
    expect(out).toBe(
      [
        '',
        '',
        'float sat(float x){',
        'return clamp(x,0.0,1.0);',
        '}',
        '',
        'vec2 a=vec2(1.0)*2.0;',
        '',
      ].join('\n'),
    );
    expect(lines(out)).toBe(lines(src));
  });

  it('never glues operators, numbers or comment markers into other tokens', () => {
    expect(one('a = b - -c;\nx = y + +z;\nq = r / /* c */ s;\n')).toBe(
      'a=b- -c;\nx=y+ +z;\nq=r/s;\n',
    );
    expect(one('float v = 1 .5;\nbool k = a < = b;\n')).toBe('float v=1 .5;\nbool k=a< =b;\n');
    expect(one('i ++ ;\nj -= 1;\nfloat f = 1.0e-3 * x;\n')).toBe(
      'i++;\nj-=1;\nfloat f=1.0e-3*x;\n',
    );
  });

  it('leaves preprocessor lines alone apart from whitespace runs and comments', () => {
    const src = '\n  #define  F(x)  ((x) * 2.0)  // twice\n#define G (y)\n#if A && B\n#endif\n';
    expect(one(src)).toBe('\n#define F(x) ((x) * 2.0)\n#define G (y)\n#if A && B\n#endif\n');
  });

  it('keeps the space next to an interpolation', () => {
    // Regression: a naive version turned `#ifndef ${name}` into `#ifndef${name}`. The value is
    // unknown at build time, so the space stays even after an operator (`x= ${v}`).
    const parts = ['\n#ifndef ', '\n#define ', ' ', '\n#endif\nfloat x = ', ';\nreturn ', ';\n'];
    expect(minifyGlsl(parts)).toEqual([
      '\n#ifndef ',
      '\n#define ',
      ' ',
      '\n#endif\nfloat x= ',
      ';\nreturn ',
      ';\n',
    ]);
    expect(minifyGlsl(['\nfor (int i = 0; i < ', '; i++) {}\n'])).toEqual([
      '\nfor(int i=0;i< ',
      ';i++){}\n',
    ]);
  });

  it('skips templates it cannot rewrite safely', () => {
    // An interpolation inside a comment, escapes / line continuations, a multi-line block
    // comment on a directive line.
    expect(minifyGlsl(['\n// size ', '\nfloat x;\n'])).toBeNull();
    expect(minifyGlsl(['\n/* ', ' */ float x;\n'])).toBeNull();
    expect(minifyGlsl(['\n#define A \\\n  1\nfloat x;\n'])).toBeNull();
    expect(minifyGlsl(['\n#define A 1 /* two\n lines */\nfloat x;\n'])).toBeNull();
    expect(minifyGlsl(['\nfloat x; /* never closed\n'])).toBeNull();
  });

  it('detects GLSL by directives or declarations in multi-line templates only', () => {
    expect(looksLikeGlsl(['\n#version 300 es\nprecision highp float;\n'])).toBe(true);
    expect(looksLikeGlsl(['\nvec3 f(vec3 c) { return c; }\n'])).toBe(true);
    expect(looksLikeGlsl(['#define A ', ''])).toBe(false);
    expect(looksLikeGlsl(['[lumicells] shader "', '" failed: ', ''])).toBe(false);
    expect(looksLikeGlsl(['\nplain multi-line\nmessage\n'])).toBe(false);
  });
});

describe('minifyGlslSource on the engine sources', () => {
  const core = resolve(__dirname, '../src/core');

  function* files(dir: string): Generator<string> {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) yield* files(full);
      else if (e.name.endsWith('.ts')) yield full;
    }
  }

  const results = [...files(core)].map((file) => {
    const code = readFileSync(file, 'utf8');
    const name = relative(core, file).replaceAll('\\', '/');
    return { name, code, out: minifyGlslSource(code, (c) => parseAst(c, { lang: 'ts' }, file)) };
  });

  it('rewrites only shader modules and keeps every line in place', () => {
    const touched = results.filter((r) => r.out);
    expect(touched.length).toBeGreaterThan(10);
    for (const r of touched) {
      expect(r.name, r.name).toMatch(/^engine\/(glsl|passes)\/|^engine\/frame-block\.ts$/);
      const out = r.out?.code ?? '';
      expect(lines(out), r.name).toBe(lines(r.code));
      // Code outside the templates is untouched: every line that is not shader text is equal.
      const before = r.code.split('\n');
      const after = out.split('\n');
      const changed = before.filter((l, i) => l !== after[i]);
      for (const l of changed)
        expect(l, r.name).not.toMatch(/^\s*(import|export|function|class)\b/);
    }
  });

  it('removes a meaningful share of the shader text', () => {
    const saved = results.reduce((n, r) => n + (r.out?.saved ?? 0), 0);
    expect(saved).toBeGreaterThan(15_000);
  });

  it('is idempotent', () => {
    for (const r of results) {
      if (!r.out) continue;
      const again = minifyGlslSource(r.out.code, (c) => parseAst(c, { lang: 'ts' }));
      expect(again, r.name).toBeNull();
    }
  });
});

describe('minifyGlslSource line endings', () => {
  const parse = (c: string) => parseAst(c, { lang: 'ts' });
  const shader = [
    'export const s = `#version 300 es',
    'precision highp float;',
    '  // comment',
    '  float a = 1.0 + 2.0;',
    '`;',
    'export const n = 1;',
    '',
  ];

  it('minifies a CRLF (or lone CR) module like the same module with LF', () => {
    const lf = minifyGlslSource(shader.join('\n'), parse);
    expect(lf?.code).toContain('float a=1.0+2.0;');
    for (const eol of ['\r\n', '\r']) {
      const src = shader.join(eol);
      const out = minifyGlslSource(src, parse);
      expect(out?.code, JSON.stringify(eol)).toBe(lf?.code);
      expect(out?.templates).toBe(1);
      // Lines stay in place: the source maps of the original file still apply.
      expect(out?.code.split('\n').length).toBe(src.split(eol).length);
      expect(out?.saved).toBe(src.length - (out?.code.length ?? 0));
    }
  });

  it('handles non-ASCII text before a template in a CRLF module', () => {
    const src = ['// Привет 🎨', ...shader].join('\r\n');
    expect(minifyGlslSource(src, parse)?.code).toContain('float a=1.0+2.0;');
  });
});
