/**
 * Links of the Markdown documentation (README.md, README.ru.md and every page under docs/):
 * relative link and image targets exist, #anchors match a heading slug of the target page by
 * GitHub's rules, every English page under docs/ has a Russian counterpart under docs/ru/ (and the
 * other way round) and links to it, every page is reachable from the README of its language, and
 * absolute links into the GitHub repository point at paths that exist.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/supsad/lumicells';

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(resolve(root, dir))) {
    const path = `${dir}/${name}`;
    if (path === 'docs/media') continue;
    if (statSync(resolve(root, path)).isDirectory()) out.push(...listMarkdown(path));
    else if (name.endsWith('.md')) out.push(path);
  }
  return out;
}

const pages = ['README.md', 'README.ru.md', ...listMarkdown('docs')].sort();
const source = new Map(pages.map((p) => [p, readFileSync(resolve(root, p), 'utf8')]));

/** Text with fenced code blocks blanked (line count kept) so their content is not parsed. */
function stripFences(text: string): string[] {
  let fence: string | null = null;
  return text.split(/\r?\n/).map((line) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m?.[1] && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return '';
    }
    if (m?.[1]) {
      fence = m[1];
      return '';
    }
    return line;
  });
}

/** Heading text reduced the way GitHub renders it before slugging. */
function headingText(raw: string): string {
  // Code spans first: their content is literal text (`<lumi-cells>` keeps "lumi-cells"), so it
  // is set aside before HTML tags and emphasis are removed from the rest of the heading.
  const code: string[] = [];
  return raw
    .replace(/\s+#+\s*$/, '')
    .replace(/`([^`]*)`/g, (_, c: string) => `${code.push(c) - 1}`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|(?<![\p{L}\p{N}])__)(.+?)(?:\*\*|__(?![\p{L}\p{N}]))/gu, '$2')
    .replace(/(\*|(?<![\p{L}\p{N}])_)(.+?)(?:\*|_(?![\p{L}\p{N}]))/gu, '$2')
    .replace(/(\d+)/g, (_, i: string) => code[Number(i)] ?? '')
    .trim();
}

/** GitHub's slug: lowercase, drop everything but letters, digits, marks, spaces, `-` and `_`. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

const anchorCache = new Map<string, Set<string>>();

/** Every anchor a page offers: heading slugs (with -1, -2 for duplicates) and explicit ids. */
function anchorsOf(page: string): Set<string> {
  const cached = anchorCache.get(page);
  if (cached) return cached;
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  const text = readFileSync(resolve(root, page), 'utf8');
  for (const line of stripFences(text)) {
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      const base = slug(headingText(h[1] ?? ''));
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const m of line.matchAll(/<a\s+[^>]*(?:id|name)="([^"]+)"/g)) anchors.add(m[1] ?? '');
  }
  anchorCache.set(page, anchors);
  return anchors;
}

interface Link {
  page: string;
  line: number;
  target: string;
  image: boolean;
}

/** Links and images of a page: Markdown inline, reference definitions, HTML href/src/srcset. */
function linksOf(page: string): Link[] {
  const out: Link[] = [];
  stripFences(source.get(page) ?? '').forEach((raw, i) => {
    const line = raw.replace(/`[^`]*`/g, '');
    const add = (target: string | undefined, image: boolean) => {
      if (target) out.push({ page, line: i + 1, target: target.trim(), image });
    };
    for (const m of line.matchAll(
      /(!?)\[(?:[^\]]|\][^(])*?\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
    ))
      add(m[2], m[1] === '!');
    const def = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/.exec(line);
    if (def) add(def[1], false);
    for (const m of line.matchAll(/\bhref="([^"]+)"/g)) add(m[1], false);
    for (const m of line.matchAll(/\bsrc="([^"]+)"/g)) add(m[1], true);
    for (const m of line.matchAll(/\bsrcset="([^"]+)"/g))
      for (const part of (m[1] ?? '').split(',')) add(part.trim().split(/\s+/)[0], true);
  });
  return out;
}

const allLinks = pages.flatMap(linksOf);
const where = (l: Link) => `${l.page}:${l.line} -> ${l.target}`;
const isExternal = (t: string) => /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//');

/** Project-relative target path of a relative link (no anchor), or null for a pure #anchor. */
function resolveTarget(l: Link): {
  path: string | null;
  anchor: string | null;
} {
  const hash = l.target.indexOf('#');
  const file = hash < 0 ? l.target : l.target.slice(0, hash);
  const anchor = hash < 0 ? null : decodeURIComponent(l.target.slice(hash + 1));
  if (!file) return { path: null, anchor };
  const path = posix.normalize(
    posix.join(posix.dirname(l.page), decodeURI(file.split('?')[0] ?? '')),
  );
  return { path: path.replace(/\/$/, ''), anchor };
}

describe('docs links', () => {
  it('finds the documentation pages', () => {
    expect(pages).toContain('docs/README.md');
    expect(pages).toContain('docs/ru/README.md');
    expect(allLinks.length).toBeGreaterThan(50);
  });

  it('relative link and image targets exist', () => {
    const missing = allLinks
      .filter((l) => !isExternal(l.target))
      .filter((l) => {
        const { path } = resolveTarget(l);
        return path !== null && !existsSync(resolve(root, path));
      })
      .map(where);
    expect(missing).toEqual([]);
  });

  it('images are local files under docs/media or external URLs', () => {
    const bad = allLinks
      .filter((l) => l.image && !isExternal(l.target))
      .filter((l) => !resolveTarget(l).path?.startsWith('docs/media/'))
      .map(where);
    expect(bad).toEqual([]);
  });

  it('#anchors match a heading of the target page', () => {
    const broken: string[] = [];
    for (const l of allLinks) {
      let page: string | null;
      let anchor: string | null;
      const blob = l.target.match(new RegExp(`^${REPO}/blob/[^/]+/([^#?]+\\.md)#(.+)$`));
      if (blob?.[1] && blob[2]) {
        page = blob[1];
        anchor = decodeURIComponent(blob[2]);
      } else if (isExternal(l.target)) continue;
      else {
        const t = resolveTarget(l);
        page = t.path ?? l.page;
        anchor = t.anchor;
      }
      if (
        anchor === null ||
        page === null ||
        !page.endsWith('.md') ||
        !existsSync(resolve(root, page))
      )
        continue;
      if (!anchorsOf(page).has(anchor)) broken.push(where(l));
    }
    expect(broken).toEqual([]);
  });

  it('absolute links into the GitHub repository point at existing paths', () => {
    const missing = allLinks
      .filter((l) => l.target.startsWith(`${REPO}/`))
      .flatMap((l) => {
        const m = l.target.match(new RegExp(`^${REPO}/(?:blob|tree|raw)/[^/]+/([^#?]*)`));
        if (m?.[1] === undefined) return [];
        const path = decodeURI(m[1]).replace(/\/$/, '');
        return existsSync(resolve(root, path || '.')) ? [] : [where(l)];
      });
    expect(missing).toEqual([]);
  });

  const english = pages.filter((p) => p.startsWith('docs/') && !p.startsWith('docs/ru/'));
  const russian = pages.filter((p) => p.startsWith('docs/ru/'));
  const counterpart = (p: string) =>
    p.startsWith('docs/ru/') ? p.replace('docs/ru/', 'docs/') : p.replace('docs/', 'docs/ru/');

  it('every docs page has a counterpart in the other language', () => {
    const missing = [...english, ...russian]
      .filter((p) => !existsSync(resolve(root, counterpart(p))))
      .map((p) => `${p} has no ${counterpart(p)}`);
    expect(missing).toEqual([]);
  });

  it('every docs page links to its counterpart', () => {
    const missing = [...english, ...russian, 'README.md', 'README.ru.md']
      .filter((p) => {
        const other =
          p === 'README.md' ? 'README.ru.md' : p === 'README.ru.md' ? 'README.md' : counterpart(p);
        return !linksOf(p).some((l) => !isExternal(l.target) && resolveTarget(l).path === other);
      })
      .map((p) => `${p} does not link to its counterpart`);
    expect(missing).toEqual([]);
  });

  /** Pages reachable from a start page by relative links, staying inside the given set. */
  function reachable(start: string, within: Set<string>): Set<string> {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const page = queue.shift() as string;
      for (const l of linksOf(page)) {
        if (isExternal(l.target)) continue;
        let path = resolveTarget(l).path;
        if (path && !path.endsWith('.md') && existsSync(resolve(root, path, 'README.md')))
          path = `${path}/README.md`;
        if (path && within.has(path) && !seen.has(path)) {
          seen.add(path);
          queue.push(path);
        }
      }
    }
    return seen;
  }

  it('every English docs page is reachable from README.md', () => {
    const got = reachable('README.md', new Set(['README.md', ...english]));
    expect(english.filter((p) => !got.has(p))).toEqual([]);
  });

  it('every Russian docs page is reachable from README.ru.md', () => {
    const got = reachable('README.ru.md', new Set(['README.ru.md', ...russian]));
    expect(russian.filter((p) => !got.has(p))).toEqual([]);
  });

  /** Project-relative paths of the Markdown pages a page links to (relative links only). */
  const linkedPages = (p: string) =>
    linksOf(p)
      .filter((l) => !isExternal(l.target))
      .map((l) => resolveTarget(l).path)
      .flatMap((t) => (t?.endsWith('.md') ? [t] : []));
  const isRussian = (p: string) => p === 'README.ru.md' || p.startsWith('docs/ru/');
  const otherLanguage = (p: string) =>
    p === 'README.md' ? 'README.ru.md' : p === 'README.ru.md' ? 'README.md' : counterpart(p);

  it('README.md and README.ru.md link every docs page of their language directly', () => {
    const missing = [
      ['README.md', english],
      ['README.ru.md', russian],
    ].flatMap(([readme, list]) => {
      const got = new Set(linkedPages(readme as string));
      return (list as string[]).filter((p) => !got.has(p)).map((p) => `${readme} -> ${p}`);
    });
    expect(missing).toEqual([]);
  });

  it('pages link into the other language only through the language switch', () => {
    const cross = pages.flatMap((p) =>
      linkedPages(p)
        .filter((t) => isRussian(t) !== isRussian(p) && t !== otherLanguage(p))
        .map((t) => `${p} -> ${t}`),
    );
    expect(cross).toEqual([]);
  });

  it('every docs page opens with the language switch and a link back to the index', () => {
    const bad = [...english, ...russian].flatMap((p) => {
      const head = linksOf(p).filter((l) => l.line <= 5 && !isExternal(l.target));
      const targets = head.map((l) => resolveTarget(l).path);
      const readme = isRussian(p) ? 'README.ru.md' : 'README.md';
      const index = isRussian(p) ? 'docs/ru/README.md' : 'docs/README.md';
      const problems: string[] = [];
      if (!targets.includes(counterpart(p))) problems.push(`${p}: no language switch at the top`);
      if (!targets.includes(readme) && !targets.includes(index))
        problems.push(`${p}: no link back to ${readme} or ${index} at the top`);
      return problems;
    });
    expect(bad).toEqual([]);
  });

  it('English and Russian docs pages have the same heading structure', () => {
    const levels = (p: string) =>
      stripFences(source.get(p) ?? '')
        .map((line) => /^\s{0,3}(#{1,6})\s/.exec(line)?.[1]?.length)
        .filter((n) => n !== undefined)
        .join('');
    const differ = english
      .filter((p) => source.has(counterpart(p)) && levels(p) !== levels(counterpart(p)))
      .map((p) => `${p} ${levels(p)} vs ${counterpart(p)} ${levels(counterpart(p))}`);
    expect(differ).toEqual([]);
  });

  it('the slug rules match GitHub on known headings', () => {
    expect(slug(headingText('Presets & modes'))).toBe('presets--modes');
    expect(slug(headingText('`createLumiCells(options)`'))).toBe('createlumicellsoptions');
    expect(slug(headingText('Быстрый старт: React'))).toBe('быстрый-старт-react');
    expect(slug(headingText('[Link](x.md) text'))).toBe('link-text');
    expect(slug(headingText('Web Component `<lumi-cells>`'))).toBe('web-component-lumi-cells');
    expect(slug(headingText('The `max_dpr` and snake_case names'))).toBe(
      'the-max_dpr-and-snake_case-names',
    );
    expect(slug(headingText('**Bold** and _emphasis_'))).toBe('bold-and-emphasis');
    expect(slug(headingText('Почему кадр дешёвый'))).toBe('почему-кадр-дешёвый');
  });
});
