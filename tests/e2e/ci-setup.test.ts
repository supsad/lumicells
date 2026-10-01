/**
 * Unit checks of the end-to-end setup itself, run by Vitest (`npx vitest run`, the CI `check`
 * job; Playwright only picks up *.spec.ts). Importing playwright.config.ts here also puts it under
 * the project type check (tsconfig.json includes tests/), so a mistake in the config fails
 * `npm run typecheck` instead of surfacing only inside the e2e job.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../playwright.config';
import { MULTI_SLOT_WAIVERS, multiSlotWaivers } from './support/known-issues';
import { MULTI_SLOT, multiSlotUrl } from './support/pages';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('playwright config', () => {
  it('runs only the *.spec.ts files, at most one retry', () => {
    expect(config.testMatch).toBe('**/*.spec.ts');
    expect(config.testDir).toBe('tests/e2e');
    expect(config.retries).toBeLessThanOrEqual(1);
  });
});

describe('parity verdicts are not retried', () => {
  const spec = read('tests/e2e/parity.spec.ts');

  it('configures retries 0 for the whole parity file', () => {
    expect(spec).toMatch(/^test\.describe\.configure\(\{ retries: 0 \}\);$/m);
  });

  it('never raises the retries again', () => {
    expect(spec).not.toMatch(/retries:\s*[1-9]/);
    expect(spec).not.toMatch(/test\.fail\(|\.fixme\(/);
  });
});

describe('multi-slot waivers (known library bugs)', () => {
  const d3d11 =
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)';

  it("waive only 'D2' in rgba8+debug, only on ANGLE/D3D11", () => {
    expect(multiSlotWaivers(d3d11)).toEqual(['rgba8+debug/D2']);
    for (const other of [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D9Ex vs_3_0 ps_3_0, D3D9Ex)',
      'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
      '',
    ]) {
      expect(multiSlotWaivers(other), other).toEqual([]);
    }
  });

  it('every waiver names one slot of one scenario and says why', () => {
    for (const w of MULTI_SLOT_WAIVERS) {
      expect(['base', 'changed', 'rgba8+debug']).toContain(w.scenario);
      expect(w.slot).toMatch(/^[A-Z]\d?$/);
      expect(w.note.length).toBeGreaterThan(20);
    }
  });

  it('page URL: no parameter without waivers, encoded keys with them', () => {
    expect(multiSlotUrl([])).toBe(MULTI_SLOT);
    const url = multiSlotUrl(['rgba8+debug/D2']);
    expect(url).toBe(`${MULTI_SLOT}?waive=rgba8%2Bdebug%2FD2`);
    expect(new URL(url, 'http://x/').searchParams.getAll('waive')).toEqual(['rgba8+debug/D2']);
  });

  it('the page knows every waived slot and scenario', () => {
    const page = read('examples/multi-slot/main.ts');
    expect(page).toContain("qs.getAll('waive')");
    for (const w of MULTI_SLOT_WAIVERS) {
      expect(page).toContain(`'${w.scenario}'`);
      expect(page).toMatch(new RegExp(`name: '${w.slot} `));
    }
  });
});

describe('CI workflow', () => {
  const ci = read('.github/workflows/ci.yml');
  const step = (name: string) => {
    const i = ci.indexOf(`- name: ${name}\n`);
    expect(i, `step '${name}'`).toBeGreaterThan(-1);
    return i;
  };

  it('builds the demo site before the bundle size budget can fail the job', () => {
    expect(step('Build demo site')).toBeLessThan(step('Bundle size'));
    expect(step('Bundle size')).toBeLessThan(step('Upload bundle size report'));
  });

  it('checks the bundle size whenever the library was built', () => {
    expect(ci).toMatch(/- name: Build library\n\s+id: build-lib\n/);
    expect(ci).toMatch(
      /- name: Bundle size\n\s+if: \$\{\{ !cancelled\(\) && steps\.build-lib\.outcome == 'success' \}\}\n/,
    );
  });

  it('runs the e2e suite on SwiftShader', () => {
    expect(ci).toMatch(/run: npm run test:e2e\n\s+env:\n\s+LC_E2E_GPU: swiftshader\n/);
  });
});

describe('e2e docs (the env.ts header is the reference the READMEs point to)', () => {
  const env = read('tests/e2e/support/env.ts');
  const header = env.slice(0, env.indexOf('*/'));
  const sources = [
    'playwright.config.ts',
    '.github/workflows/ci.yml',
    'tests/e2e/site/serve.mjs',
    ...['env', 'gl-probe', 'known-issues', 'pages', 'perf', 'perf-reporter', 'test'].map(
      (f) => `tests/e2e/support/${f}.ts`,
    ),
  ];

  it('documents every LC_E2E_* switch used by the setup', () => {
    const used = new Set(sources.flatMap((f) => read(f).match(/LC_E2E_[A-Z_]+/g) ?? []));
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(header, name).toContain(name);
  });

  it('says how to run it and where the outputs go', () => {
    expect(read('package.json')).toContain('"test:e2e": "playwright test"');
    expect(header).toContain('npx playwright install chromium');
    expect(header).toContain('npm run test:e2e');
    const config = read('playwright.config.ts');
    for (const out of [
      'playwright-report',
      'test-results/e2e-results.json',
      'test-results/e2e-perf.json',
    ]) {
      expect(config, out).toContain(out);
      expect(header, out).toContain(out);
    }
  });
});
