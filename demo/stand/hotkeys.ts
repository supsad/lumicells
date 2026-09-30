/**
 * Layout-independent hotkey letter. A Latin letter in `key` wins (AZERTY, Dvorak and friends keep
 * their labelled keys); on non-Latin layouts (Russian: Ctrl+Z reports key "я") the physical key
 * from `code` ("KeyZ") is used instead. Anything else falls back to the lowercased `key`.
 */
export function hotkeyOf(e: { key: string; code?: string }): string {
  const k = e.key.toLowerCase();
  if (/^[a-z]$/.test(k)) return k;
  const m = /^Key([A-Z])$/.exec(e.code ?? '');
  return m?.[1] ? m[1].toLowerCase() : k;
}
