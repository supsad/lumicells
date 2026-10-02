import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type Sizes = { raw: number; gzip: number; brotli: number };

// The script is plain JS (run by node in `npm run size`); importing it builds nothing.
const scriptUrl = pathToFileURL(resolve(__dirname, '../scripts/size.mjs')).href;
const { sizes, sumSizes } = (await import(/* @vite-ignore */ scriptUrl)) as {
  sizes(buf: Buffer): Sizes;
  sumSizes(bufs: Buffer[]): Sizes;
};

/** A chunk of minified-looking code; `seed` changes the identifiers but not the shape. */
function chunk(seed: number): Buffer {
  const lines: string[] = [];
  for (let i = 0; i < 200; i++) {
    lines.push(`function f${seed}_${i}(a,b){return a*${i % 7}+b.uniform${i % 13}(gl,${i});}`);
  }
  return Buffer.from(lines.join(''), 'utf8');
}

describe('size.mjs totals', () => {
  it('sums each chunk compressed on its own, the way a browser transfers them', () => {
    const chunks = [chunk(1), chunk(2), chunk(3)];
    const each = chunks.map((c) => sizes(c));
    const total = sumSizes(chunks);
    expect(total.raw).toBe(each.reduce((n, s) => n + s.raw, 0));
    expect(total.gzip).toBe(each.reduce((n, s) => n + s.gzip, 0));
    expect(total.brotli).toBe(each.reduce((n, s) => n + s.brotli, 0));
  });

  it('is not the size of the chunks joined together, which hides what a split costs', () => {
    // Similar chunks share most of their text: compressed together, the later ones are nearly
    // free, which no browser gets when it fetches them as separate files.
    const chunks = [chunk(1), chunk(2), chunk(3)];
    const joined = sizes(Buffer.concat(chunks));
    const total = sumSizes(chunks);
    expect(total.raw).toBe(joined.raw);
    expect(total.gzip).toBeGreaterThan(joined.gzip);
    expect(total.brotli).toBeGreaterThan(joined.brotli);
  });

  it('is the plain sizes() of a single file and zero for none', () => {
    const one = chunk(4);
    expect(sumSizes([one])).toEqual(sizes(one));
    expect(sumSizes([])).toEqual({ raw: 0, gzip: 0, brotli: 0 });
  });
});
