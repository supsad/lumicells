// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

// The <script src> bundle (global `LumiCells`) is all a script-tag user has. PRESETS holds config
// patches only since the UI metadata moved to meta.ts (so apps do not ship it), which leaves
// PRESET_TEXTS as the way to name presets there. scripts/size.mjs checks the built bundle too.
describe('IIFE entry', () => {
  it('names every preset next to PRESETS', async () => {
    const iife = await import('../src/element/iife');
    for (const id of iife.PRESET_IDS) {
      expect(iife.PRESETS[id], id).toHaveProperty('config');
      expect(iife.PRESETS[id], id).not.toHaveProperty('label');
      expect(iife.PRESET_TEXTS[id]?.label, id).toBeTruthy();
      expect(iife.PRESET_TEXTS[id]?.description, id).toBeTruthy();
    }
    expect(iife.PRESET_TEXTS.orb.label).toBe('Orb');
    expect(customElements.get('lumi-cells')).toBeDefined();
  });
});
