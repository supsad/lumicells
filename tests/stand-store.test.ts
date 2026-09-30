import { getPath, getPresetConfig, type LumiCellsConfig } from 'lumicells';
import { describe, expect, it } from 'vitest';
import { StandStore } from '../demo/stand/store';

/** A config as an older session would have stored it: one group lacks a field. */
function stale(): LumiCellsConfig {
  const cfg = structuredClone(getPresetConfig('reference')) as unknown as Record<string, unknown>;
  const modes = cfg.modes as Record<string, Record<string, unknown>>;
  delete modes.sphere?.radius;
  delete cfg.grid;
  return cfg as unknown as LumiCellsConfig;
}

describe('StandStore normalization', () => {
  const def = getPresetConfig('reference');

  it('fills fields missing from the initial config with defaults', () => {
    const store = new StandStore(stale(), 'reference');
    expect(getPath(store.cfg, 'modes.sphere.radius')).toBe(getPath(def, 'modes.sphere.radius'));
    expect(getPath(store.cfg, 'grid.count')).toBe(getPath(def, 'grid.count'));
  });

  it('fills missing fields on replace()', () => {
    const store = new StandStore(def, 'reference');
    store.replace(stale());
    expect(getPath(store.cfg, 'modes.sphere.radius')).toBe(getPath(def, 'modes.sphere.radius'));
  });

  it('fills missing fields when undo restores an old entry', () => {
    const store = new StandStore(stale(), 'reference');
    // Simulate a stale history entry (recorded before the schema gained the field).
    (store as unknown as { past: { cfg: LumiCellsConfig; presetId: string }[] }).past.push({
      cfg: stale(),
      presetId: 'reference',
    });
    store.undo();
    expect(getPath(store.cfg, 'modes.sphere.radius')).toBe(getPath(def, 'modes.sphere.radius'));
  });

  it('keeps a complete config equal in value', () => {
    const store = new StandStore(def, 'reference');
    expect(store.cfg).toEqual(def);
  });
});
