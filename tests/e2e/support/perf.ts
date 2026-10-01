/**
 * Timings of a test: recorded for the report (the `perf` attachment, merged into
 * test-results/e2e-perf.json by perf-reporter.ts) and checked against generous limits.
 *
 * Machines differ too much (a GitHub runner renders with SwiftShader on 4 vCPUs) for tight
 * budgets in CI: the invariants are hard assertions in the specs, timings only fail on a gross
 * regression. Each metric has, per GPU mode, a `target` (exceeding it adds a `perf-warning`
 * annotation, the test still passes) and a `gross` limit (exceeding it fails the test, soft, so
 * every metric is still recorded). LC_E2E_PERF_SLACK multiplies the gross limits. The GPU mode
 * is the one Chromium actually renders with (the `gpu` fixture), not the one asked for.
 */
import { expect, type TestInfo } from '@playwright/test';
import { GPU_MODE, type GpuMode, PERF_SLACK } from './env';

export interface Limit {
  /** Expected upper bound: above it the test passes with a perf warning. */
  target: number;
  /** Gross regression: above it the test fails. */
  gross: number;
}

export type Limits = Record<GpuMode, Limit>;

export interface PerfCheck {
  metric: string;
  value: number;
  unit: string;
  target: number;
  gross: number;
  status: 'ok' | 'over-target' | 'gross';
}

export class PerfRecord {
  readonly data: Record<string, unknown> = {};
  readonly checks: PerfCheck[] = [];

  constructor(
    private readonly testInfo: TestInfo,
    /** The renderer Chromium uses (the `gpu` fixture): picks the limits. */
    readonly mode: GpuMode,
  ) {}

  get empty(): boolean {
    return this.checks.length === 0 && Object.keys(this.data).length === 0;
  }

  /** Records a value (any JSON) for the report. */
  set(key: string, value: unknown): void {
    this.data[key] = value;
  }

  /** Records `value` and checks it against the limits of the effective GPU mode. */
  check(metric: string, value: number, limits: Limits, unit = 'ms'): void {
    const { target } = limits[this.mode];
    const gross = limits[this.mode].gross * PERF_SLACK;
    const status = value > gross ? 'gross' : value > target ? 'over-target' : 'ok';
    this.checks.push({ metric, value, unit, target, gross, status });
    if (status === 'over-target') {
      this.testInfo.annotations.push({
        type: 'perf-warning',
        description: `${metric} = ${value} ${unit} (target ${target}, gross limit ${gross})`,
      });
    }
    expect
      .soft(value, `${metric}: gross regression (target ${target} ${unit}, limit ${gross} ${unit})`)
      .toBeLessThanOrEqual(gross);
  }

  async attach(): Promise<void> {
    await this.testInfo.attach('perf', {
      body: JSON.stringify(
        { gpuMode: this.mode, gpuModeRequested: GPU_MODE, ...this.data, checks: this.checks },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  }
}
