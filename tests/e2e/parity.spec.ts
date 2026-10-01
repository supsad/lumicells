/**
 * The dev parity pages print a PASS / FAIL verdict:
 * - examples/multi-slot: RenderSlots in regions of one GpuDevice canvas vs Engines with contexts
 *   of their own, frame by frame (1 LSB);
 * - examples/shared-parity: LumiCells pairs, renderer 'own' vs 'shared', same seed and time.
 * The full status text is attached to the report.
 */
import type { Page, TestInfo } from '@playwright/test';
import { multiSlotWaivers, waiverNote } from './support/known-issues';
import { multiSlotUrl, SHARED_PARITY } from './support/pages';
import { expect, rendererNotes, test } from './support/test';

/**
 * Chrome's performance notes about the pages' own readbacks (readPixels of the reference
 * canvases, getImageData of the shared instances' 2D canvases, which the library deliberately
 * creates without willReadFrequently).
 */
const READBACK_NOTES = [/GPU stall due to ReadPixels/, /willReadFrequently/];

async function attachStatus(page: Page, testInfo: TestInfo): Promise<string> {
  const text = (await page.locator('#status').textContent()) ?? '';
  await testInfo.attach('status', { body: text, contentType: 'text/plain' });
  return text;
}

// A parity verdict is never retried: a mismatch that shows in 1 run of 2 is a bug, not noise,
// and a pass on retry would hide it as 'flaky'. Known bugs are waived narrowly instead (one
// renderer, one scenario, one slot; see support/known-issues.ts) and recorded as annotations.
test.describe.configure({ retries: 0 });

test.describe('multi-slot device', () => {
  test('regions match own-context engines', async ({ page, problems, perf, gl }, testInfo) => {
    const waive = multiSlotWaivers(gl.renderer);
    for (const w of waive) {
      testInfo.annotations.push({ type: 'known-issue', description: `${w}: ${waiverNote(w)}` });
    }
    const start = Date.now();
    await page.goto(multiSlotUrl(waive));
    // Done, or the page printed why it stopped.
    await page.waitForFunction(
      () =>
        window.multi?.done === true ||
        /^failed/.test(document.getElementById('status')?.textContent ?? ''),
      null,
      { timeout: testInfo.timeout - 10_000 },
    );
    const status = await attachStatus(page, testInfo);
    const last = await page.evaluate(() => window.multi?.last ?? null);
    perf.check('durationMs', Date.now() - start, {
      hardware: { target: 45_000, gross: 90_000 },
      swiftshader: { target: 60_000, gross: 150_000 },
    });
    // The waived mismatches stay visible in the report (how often the known bug shows); every
    // line is in the attached status too.
    const waived = last?.waived ?? [];
    if (waived.length > 0) {
      testInfo.annotations.push({
        type: 'known-issue-hit',
        description: `${waived.length} waived mismatch(es), first: ${waived[0]}`,
      });
    }
    expect(last?.summary?.waivers ?? [], 'waivers the page applied').toEqual(waive);
    expect(last?.failures ?? [status], 'failures').toEqual([]);
    expect(last?.verdict).toBe('PASS');
    expect(problems.unexpected(READBACK_NOTES)).toEqual([]);
  });
});

test('shared renderer: own and shared pairs match', async ({
  page,
  problems,
  perf,
  gl,
}, testInfo) => {
  const start = Date.now();
  await page.goto(SHARED_PARITY);
  await page.waitForFunction(() => window.parity?.last != null, null, {
    timeout: testInfo.timeout - 10_000,
  });
  const status = await attachStatus(page, testInfo);
  const last = await page.evaluate(
    () => window.parity.last as { verdict: string; failures: string[] } | null,
  );
  perf.check('durationMs', Date.now() - start, {
    hardware: { target: 20_000, gross: 60_000 },
    swiftshader: { target: 40_000, gross: 150_000 },
  });
  expect(last?.failures ?? [status], 'failures').toEqual([]);
  expect(last?.verdict).toBe('PASS');
  expect(problems.unexpected([...READBACK_NOTES, ...rendererNotes(gl)])).toEqual([]);
});
