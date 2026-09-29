/**
 * Static CSS approximation of a config, used for SSR, the no-WebGL fallback and the moment before
 * the first frame. Pure string building (no DOM) so it runs on the server.
 *
 * Mode space is approximated on a square host: 1 mode unit = 50% of the box, y points down.
 */

import { hexToRgb, samplePalette } from '../core/color';
import type { PixelLifeConfig } from './schema';

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${r2(n)}%`;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function rgba(rgb: readonly number[], a: number): string {
  const c = (v: number | undefined) => Math.round(clamp01(v ?? 0) * 255);
  return `rgba(${c(rgb[0])},${c(rgb[1])},${c(rgb[2])},${r2(clamp01(a))})`;
}

function hexA(hex: string, a: number): string {
  return rgba(hexToRgb(hex), a);
}

/** Mode-space point -> CSS position. */
function pos(x: number, y: number): string {
  return `${pct(50 + x * 50)} ${pct(50 + y * 50)}`;
}

/** Elliptical radial blob (size in mode units). */
function blob(x: number, y: number, size: number, color: string): string {
  const s = pct(Math.max(1, size * 50));
  return `radial-gradient(${s} ${s} at ${pos(x, y)}, ${color} 0%, transparent 100%)`;
}

/**
 * CSS `background` value approximating the look of `cfg` (layers top to bottom, base color last).
 */
export function posterCss(cfg: PixelLifeConfig): string {
  const layers: string[] = [];
  const bg = cfg.background.color;
  const pal = cfg.color.palette;
  const interp = cfg.color.interpolation;
  const sample = (t: number) => samplePalette(pal, t, interp);
  const [cx, cy] = cfg.scene.center;
  const zoom = cfg.scene.zoom;
  const gain = clamp01(cfg.animation.brightness * cfg.glow.exposure * 0.85) * cfg.animation.energy;
  const sat = cfg.color.saturation;

  // Desaturate toward luma so a grey/white preset stays grey in the poster too.
  const tint = (rgb: readonly number[]) => {
    const l = 0.2126 * (rgb[0] ?? 0) + 0.7152 * (rgb[1] ?? 0) + 0.0722 * (rgb[2] ?? 0);
    return rgb.map((v) => l + (v - l) * Math.min(1.5, sat));
  };

  if (cfg.background.vignette > 0) {
    layers.push(
      `radial-gradient(75% 75% at 50% 50%, transparent 55%, ${rgba([0, 0, 0], cfg.background.vignette * 0.55)} 100%)`,
    );
  }

  const sphere = cfg.modes.sphere;
  if (sphere.weight > 0.02) {
    const w = clamp01(sphere.weight) * gain;
    const radius = sphere.radius * zoom;
    // Asymmetric fade toward fadeAngle (0 = right, 90 = down; CSS 0deg points up).
    if (sphere.fadeAmount > 0) {
      layers.push(
        `linear-gradient(${r2(sphere.fadeAngle + 90)}deg, transparent 45%, ${hexA(bg, sphere.fadeAmount * 0.85)} 100%)`,
      );
    }
    if (sphere.hole > 0) {
      const h = (sphere.hole + sphere.holeSoftness * 0.5) * zoom;
      layers.push(blob(cx, cy, h, hexA(bg, 0.9)));
    }
    if (cfg.color.mapping === 'radial') {
      const stops = [0, 0.25, 0.5, 0.75, 1]
        .map((t) => `${rgba(tint(sample(t)), w * 0.8)} ${pct(t * 100)}`)
        .join(', ');
      const s = pct(radius * 50 * 1.4);
      layers.push(`radial-gradient(${s} ${s} at ${pos(cx, cy)}, ${stops}, transparent 100%)`);
    } else {
      // Palette spread along the color axis: start of the palette at -dir, end at +dir.
      const a = (cfg.color.angle * Math.PI) / 180;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      for (const t of [0.15, 0.5, 0.85]) {
        const k = (t - 0.5) * 1.3 * radius;
        layers.push(blob(cx + dx * k, cy + dy * k, radius * 1.05, rgba(tint(sample(t)), w * 0.7)));
      }
    }
  }

  // Other modes are space-filling textures: approximate them with a soft palette wash.
  const m = cfg.modes;
  const fill = Math.max(
    m.flow.weight * 0.6,
    m.pulse.weight,
    m.wave.weight,
    m.ripple.weight,
    m.vortex.weight,
    m.life.weight,
    m.rain.weight,
  );
  if (fill > 0.02) {
    const a = fill * gain * (sphere.weight > 0.02 ? 0.35 : 0.55);
    const stops = [0, 0.33, 0.66, 1]
      .map((t) => `${rgba(tint(sample(t)), a)} ${pct(t * 100)}`)
      .join(', ');
    if (cfg.color.mapping === 'radial' || m.pulse.weight > 0.5 || m.vortex.weight > 0.5) {
      layers.push(`radial-gradient(70% 70% at ${pos(cx, cy)}, ${stops})`);
    } else {
      layers.push(`linear-gradient(${r2(cfg.color.angle + 90)}deg, ${stops})`);
    }
  }

  for (const spot of [cfg.background.spotA, cfg.background.spotB]) {
    if (spot.strength <= 0) continue;
    layers.push(
      blob(spot.position[0], spot.position[1], spot.radius, hexA(spot.color, spot.strength)),
    );
  }

  layers.push(bg);
  return layers.join(', ');
}
