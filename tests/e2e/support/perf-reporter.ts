/**
 * Reporter that merges the `perf` attachments of every test (see perf.ts), with each test's
 * project (browser), status and duration, into one JSON file: the timings artifact of a run (CI
 * uploads one per browser). The last attempt of a retried test wins.
 *
 * Options: { outputFile } (default test-results/e2e-perf.json, relative to the config).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { CI, GPU_MODE, PERF_SLACK, SERVER } from './env';

interface Entry {
  /** Playwright project: the browser engine (chromium, firefox, webkit). */
  project: string;
  title: string;
  file: string;
  status: TestResult['status'];
  retry: number;
  durationMs: number;
  annotations: { type: string; description?: string }[];
  perf: unknown;
}

export default class PerfReporter implements Reporter {
  readonly #outputFile: string;
  #out = '';
  #startedAt = new Date();
  readonly #entries = new Map<string, Entry>();

  constructor(options: { outputFile?: string } = {}) {
    this.#outputFile = options.outputFile ?? 'test-results/e2e-perf.json';
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    this.#out = resolve(dirname(config.configFile ?? config.rootDir), this.#outputFile);
    this.#startedAt = new Date();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const attachment = result.attachments.find((a) => a.name === 'perf' && a.body);
    let perf: unknown = null;
    if (attachment?.body) {
      try {
        perf = JSON.parse(attachment.body.toString('utf8'));
      } catch {
        perf = attachment.body.toString('utf8');
      }
    }
    const annotations = new Map<string, { type: string; description?: string }>();
    for (const a of [...test.annotations, ...result.annotations]) {
      annotations.set(`${a.type}\n${a.description ?? ''}`, {
        type: a.type,
        description: a.description,
      });
    }
    this.#entries.set(test.id, {
      project: test.parent.project()?.name ?? '',
      title: test.titlePath().filter(Boolean).slice(1).join(' > '),
      file: test.location.file.replace(/\\/g, '/').replace(/^.*\/tests\/e2e\//, ''),
      status: result.status,
      retry: result.retry,
      durationMs: result.duration,
      annotations: [...annotations.values()],
      perf,
    });
  }

  onEnd(result: FullResult): void {
    const report = {
      startedAt: this.#startedAt.toISOString(),
      durationMs: Math.round(result.duration),
      status: result.status,
      env: {
        ci: CI,
        // The mode asked for; each test's perf entry has the one in use (gpuMode) too.
        gpuMode: GPU_MODE,
        server: SERVER,
        perfSlack: PERF_SLACK,
        platform: process.platform,
        node: process.version,
      },
      tests: [...this.#entries.values()],
    };
    mkdirSync(dirname(this.#out), { recursive: true });
    writeFileSync(this.#out, `${JSON.stringify(report, null, 2)}\n`);
  }
}
