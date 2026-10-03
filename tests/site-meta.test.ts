/**
 * Search and link-preview metadata of the published demo site (GitHub Pages, base /lumicells/):
 * the pages carry a description, a canonical URL and an Open Graph image that exists, the sitemap
 * lists exactly the pages vite.config.ts builds, and the IndexNow key file holds its own name and
 * is the key the Pages workflow pings IndexNow with after a deployment.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const SITE = 'https://supsad.github.io/lumicells/';

/** Content of `<meta name|property="key" content="...">` (attributes in that order). */
function meta(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta\\s+(?:name|property)="${key}"\\s+content="([^"]*)"`);
  return re.exec(html.replace(/\s+/g, ' '))?.[1];
}

function canonical(html: string): string | undefined {
  return /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];
}

/** The HTML inputs of the Pages build, as paths relative to the project root. */
function pageInputs(): string[] {
  const input = viteConfig.build?.rollupOptions?.input;
  const paths =
    typeof input === 'string' ? [input] : Array.isArray(input) ? input : Object.values(input ?? {});
  return paths.map((p) => relative(root, p).replaceAll('\\', '/')).sort();
}

const urlOf = (page: string) => (page === 'index.html' ? SITE : `${SITE}${page}`);

describe('pages of the site', () => {
  const pages = pageInputs();

  it('are the playground and the two published examples', () => {
    expect(pages).toEqual([
      'examples/core-basic.html',
      'examples/web-component.html',
      'index.html',
    ]);
  });

  for (const page of pages) {
    describe(page, () => {
      const html = read(page);

      it('has a description of a search-snippet length', () => {
        const description = meta(html, 'description') ?? '';
        expect(description.length).toBeGreaterThanOrEqual(80);
        expect(description.length).toBeLessThanOrEqual(170);
      });

      it('has its own absolute canonical URL and og:url', () => {
        expect(canonical(html)).toBe(urlOf(page));
        expect(meta(html, 'og:url')).toBe(urlOf(page));
      });

      it('has an absolute og:image that exists under public/', () => {
        const image = meta(html, 'og:image') ?? '';
        expect(image.startsWith(SITE)).toBe(true);
        expect(existsSync(resolve(root, 'public', image.slice(SITE.length)))).toBe(true);
        expect(meta(html, 'og:image:width')).toBe('1200');
        expect(meta(html, 'og:image:height')).toBe('630');
        expect(meta(html, 'twitter:card')).toBe('summary_large_image');
      });
    });
  }
});

describe('the playground page (index.html)', () => {
  const html = read('index.html');

  it('has a title and an og:title without dashes', () => {
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
    expect(title).toContain('LumiCells');
    expect(title).not.toMatch(/[–—]/);
    expect(meta(html, 'og:title')).not.toMatch(/[–—]/);
  });

  it('has valid JSON-LD structured data pointing at the repository', () => {
    const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    const data = JSON.parse(json ?? 'null');
    expect(data).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'SoftwareSourceCode',
      name: 'LumiCells',
      url: SITE,
      codeRepository: 'https://github.com/supsad/lumicells',
      programmingLanguage: 'TypeScript',
      license: 'https://opensource.org/licenses/MIT',
    });
  });

  it('has visible static content inside #root for crawlers and visitors without JavaScript', () => {
    const body = /<div id="root">([\s\S]*)<\/div>\s*<script/.exec(html)?.[1] ?? '';
    expect(body).toContain('<h1>LumiCells</h1>');
    expect(body).toContain('href="https://github.com/supsad/lumicells"');
    expect(body).toContain('href="examples/web-component.html"');
    expect(body).toContain('href="examples/core-basic.html"');
    expect(body).not.toMatch(/display:\s*none|hidden/);
  });

  it('keeps an h1, a description and the docs link once the playground has mounted', () => {
    // React replaces the static block, so demo/main.tsx renders a footer next to the stand.
    const main = read('demo/main.tsx');
    expect(main).toMatch(/<App \/>\s*<About \/>/);
    expect(main).toContain('<h1 className="lc-about__name">LumiCells</h1>');
    expect(main).toContain("'https://github.com/supsad/lumicells/tree/main/docs'");
    expect(main).toMatch(/WebGL2 neon pixel-grid animated background/);
    expect(html).toContain('.lc-about {');
  });
});

describe('sitemap.xml', () => {
  it('lists exactly the pages of the build under the Pages URL', () => {
    const xml = read('public/sitemap.xml');
    const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]).sort();
    expect(locs).toEqual(pageInputs().map(urlOf).sort());
  });
});

describe('site verification files', () => {
  // Search Console and Yandex Webmaster check them again from time to time: removing one drops
  // the verified ownership of the site.
  it('keep the Google file in the form Google issued it', () => {
    const name = 'google7827d15eed9bcadc.html';
    expect(read(`public/${name}`)).toBe(`google-site-verification: ${name}`);
  });

  it('keep the Yandex file with its code', () => {
    expect(read('public/yandex_c82866d1df3af1ef.html')).toContain('Verification: c82866d1df3af1ef');
  });
});

describe('IndexNow key file', () => {
  it('is the only one and contains exactly its own name', () => {
    const keys = readdirSync(resolve(root, 'public')).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
    expect(keys).toHaveLength(1);
    const [file] = keys;
    expect(read(`public/${file}`)).toBe(file?.replace(/\.txt$/, ''));
  });

  it('is what the Pages workflow pings IndexNow with, for every page of the sitemap', () => {
    const [file] = readdirSync(resolve(root, 'public')).filter((f) =>
      /^[0-9a-f]{32}\.txt$/.test(f),
    );
    const yml = read('.github/workflows/pages.yml');
    const step = yml.slice(yml.indexOf('name: Notify search engines (IndexNow)'));
    expect(step).toContain('continue-on-error: true');
    expect(step).toContain(`KEY: ${file?.replace(/\.txt$/, '')}`);
    expect(step).toContain(`SITE: ${SITE}`);
    // The shell of the step expands these; in the workflow file they are literal text.
    const site = `\${SITE}`;
    const key = `\${KEY}`;
    expect(step).toContain(`\\"keyLocation\\":\\"${site}${key}.txt\\"`);
    const urls = [...step.matchAll(/\\"(\$\{SITE\}[^\\]*)\\"/g)]
      .map((m) => m[1]?.replace(site, SITE))
      .filter((u) => !u?.endsWith('.txt'))
      .sort();
    expect(urls).toEqual(pageInputs().map(urlOf).sort());
  });
});
