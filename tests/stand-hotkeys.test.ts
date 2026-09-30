import { describe, expect, it } from 'vitest';
import { hotkeyOf } from '../demo/stand/hotkeys';

describe('hotkeyOf', () => {
  it('uses a Latin key as is (case-insensitive)', () => {
    expect(hotkeyOf({ key: 'z', code: 'KeyZ' })).toBe('z');
    expect(hotkeyOf({ key: 'Z', code: 'KeyZ' })).toBe('z');
  });

  it('keeps the labelled letter on AZERTY/Dvorak (key wins over the physical code)', () => {
    // AZERTY: the physical KeyQ prints "a".
    expect(hotkeyOf({ key: 'a', code: 'KeyQ' })).toBe('a');
  });

  it('maps a non-Latin layout through the physical key', () => {
    expect(hotkeyOf({ key: 'я', code: 'KeyZ' })).toBe('z');
    expect(hotkeyOf({ key: 'р', code: 'KeyH' })).toBe('h');
    expect(hotkeyOf({ key: 'З', code: 'KeyP' })).toBe('p');
    expect(hotkeyOf({ key: 'в', code: 'KeyD' })).toBe('d');
  });

  it('falls back to the lowercased key without a letter code', () => {
    expect(hotkeyOf({ key: 'Escape', code: 'Escape' })).toBe('escape');
    expect(hotkeyOf({ key: 'я' })).toBe('я');
    expect(hotkeyOf({ key: 'я', code: '' })).toBe('я');
  });
});
