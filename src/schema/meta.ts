/**
 * UI metadata of the config schema: English labels, descriptions and units, the stand's
 * presentation hints (order, advanced, widget, visibleWhen), enum value labels and preset names.
 *
 * It lives apart from the runtime schema (schema.ts keeps only what rendering needs: kinds,
 * ranges, defaults, live/gpu flags), and nothing in the runtime imports it, so an app that only
 * renders a background does not ship these texts. The stand, the JSON Schema generator and the
 * localized-text helpers (locale.ts) read it. Like the translation tables in locales/, it is
 * keyed by dotted path; tests/schema-meta.test.ts keeps it complete and free of stale keys.
 */

import type { LocalizedPreset } from './locale';
import type { PresetId } from './presets';

/** Show a control only when another field matches. Exactly one comparison is expected. */
export interface VisibleWhen {
  path: string;
  eq?: unknown;
  neq?: unknown;
  gt?: number;
}

/** UI metadata of a group. */
export interface GroupMeta {
  label: string;
  description?: string;
  /** Sort key among siblings in the stand (declaration order otherwise). */
  order?: number;
  /** Hidden in the stand unless "advanced" is on (inherited by children). */
  advanced?: boolean;
  visibleWhen?: VisibleWhen;
}

/** UI metadata of a leaf field. */
export interface FieldMeta extends GroupMeta {
  /** Display unit; angle fields always read in degrees ('°'). */
  unit?: string;
  /** Preferred control of a numeric field (a slider by default). */
  widget?: 'slider' | 'knob';
}

/**
 * English names and descriptions of the presets. Exported on its own (SCHEMA_META.presets is the
 * same object) so the <script src> bundle can name presets without pulling in the rest of the UI
 * metadata; localizedPreset() adds the translations.
 */
export const PRESET_TEXTS: Record<PresetId, LocalizedPreset> = {
  reference: {
    label: 'Reference',
    description: 'Hollow neon sphere: crimson top left, blue bottom right, fading into navy.',
  },
  orb: {
    label: 'Orb',
    description:
      'Solid rotating planet: a lit sky-blue rim, a deep indigo shadow and a thin atmosphere.',
  },
  pulse: {
    label: 'Pulse',
    description: 'Crisp rings spread from the center and gently breathe: crimson, pink, violet.',
  },
  life: {
    label: 'Life',
    description:
      "Conway's cellular automaton: cells flash quickly and fade out smoothly, in teal and mint.",
  },
  vortex: {
    label: 'Vortex',
    description: 'Three-armed galaxy: a golden core, fiery arms and violet outskirts.',
  },
  waves: {
    label: 'Waves',
    description: 'Interference plasma: bending crests from indigo through violet to sky blue.',
  },
  ripples: {
    label: 'Ripples',
    description: 'Dark water under the moon: silvery blue rings spread from random drops.',
  },
  rain: {
    label: 'Rain',
    description: 'Green "digital rain" on a near-black background, with a fine grid.',
  },
  minimal: {
    label: 'Minimal',
    description:
      'Monochrome white islands drift slowly over a charcoal background, with a restrained glow.',
  },
};

/** Every UI text and hint of the schema, keyed by dotted path. */
export interface SchemaMeta {
  groups: Record<string, GroupMeta>;
  fields: Record<string, FieldMeta>;
  /** Enum value labels: path -> value -> label. */
  enums: Record<string, Record<string, string>>;
  presets: Record<PresetId, LocalizedPreset>;
}

export const SCHEMA_META: SchemaMeta = {
  groups: {
    // The root of the tree (path ''): only its name, which the JSON Schema does not use.
    '': { label: 'LumiCells' },
    grid: { label: 'Grid', description: 'Size and shape of the pixel-grid cells.', order: 10 },
    scene: {
      label: 'Composition',
      description: 'Position and scale of the whole picture inside the container.',
      order: 20,
    },
    animation: {
      label: 'Animation',
      description: 'Global speed, mode blending and cell liveliness.',
      order: 30,
    },
    'animation.flicker': {
      label: 'Flicker',
      description: 'Slow random brightness breathing of each cell.',
    },
    'animation.sparkle': {
      label: 'Sparkle',
      description: 'Rare short flashes of individual cells.',
    },
    'animation.sparsity': {
      label: 'Sparsity',
      description: 'On the outskirts cells switch off entirely instead of dimming.',
    },
    modes: {
      label: 'Animation modes',
      description: 'Layers of the brightness field; several modes can be mixed at once.',
      order: 40,
    },
    'modes.flow': { label: 'Flow', description: 'A smoothly flowing noise pattern.' },
    'modes.sphere': {
      label: 'Sphere',
      description: 'A glowing hollow orb with a rim and a soft fade.',
    },
    'modes.pulse': { label: 'Pulse', description: 'Concentric rings spreading from the center.' },
    'modes.wave': { label: 'Waves', description: 'Traveling plane waves with interference.' },
    'modes.ripple': { label: 'Ripples', description: 'Random rings, like drops falling on water.' },
    'modes.vortex': { label: 'Vortex', description: 'Twisted spiral arms.' },
    'modes.life': {
      label: 'Life',
      description: "A cellular automaton in the spirit of Conway's Game of Life.",
    },
    'modes.rain': { label: 'Rain', description: 'Falling glowing drops with a trail.' },
    color: {
      label: 'Color',
      description: 'The palette and how it is laid over the grid.',
      order: 50,
    },
    'color.hot': {
      label: 'Hot core',
      description: 'The brightest cells turn lighter in a tint of their own color.',
    },
    'color.accent': {
      label: 'Accent',
      description:
        'Organic patches of a second color on the inner edge of the sphere, only in the cool half of the palette (teal within blue).',
    },
    background: {
      label: 'Background',
      description: 'The backdrop under the grid: color, vignette and color spots.',
      order: 60,
    },
    'background.spotA': { label: 'Spot A', description: 'A soft color spot on the background.' },
    'background.spotB': { label: 'Spot B', description: 'A soft color spot on the background.' },
    glow: {
      label: 'Glow',
      description: 'Halo around the cells, bloom and atmospheric haze.',
      order: 70,
    },
    'glow.halo': { label: 'Halo', description: 'Dense glow in the gaps around the cells.' },
    'glow.bloom': { label: 'Bloom', description: 'Soft glow of the bright areas.' },
    'glow.haze': { label: 'Haze', description: 'Wide atmospheric glow.' },
    lift: {
      label: 'Lifted pixels',
      description: 'Individual cells rise above the grid and settle back.',
      order: 80,
    },
    interaction: {
      label: 'Interaction',
      description: 'Response to the pointer and clicks, and defaults for bound elements.',
      order: 90,
    },
    render: {
      label: 'Performance',
      description: 'Quality, resolution and frame rate.',
      order: 100,
      advanced: true,
    },
  },
  fields: {
    'grid.sizing': {
      label: 'Cell sizing',
      description:
        'Size the grid by a fixed pitch in pixels or by the number of cells along the shorter side of the container.',
    },
    'grid.pitch': {
      label: 'Pitch',
      description: 'Distance between the centers of neighboring cells, in CSS pixels.',
      unit: 'px',
      visibleWhen: { path: 'grid.sizing', eq: 'pitch' },
    },
    'grid.count': {
      label: 'Cells',
      description:
        'How many cells fit along the shorter side of the container, so the composition looks the same in a square, a banner or full screen.',
      visibleWhen: { path: 'grid.sizing', eq: 'count' },
    },
    'grid.gap': {
      label: 'Gap',
      description: 'Fraction of the pitch taken by the dark gap between cells.',
    },
    'grid.roundness': {
      label: 'Roundness',
      description: 'Corner radius as a fraction of half a cell: 0 is a square, 1 is a circle.',
    },
    'grid.softness': {
      label: 'Edge softness',
      description: 'Feathering of the cell edge, in device pixels.',
      unit: 'px',
    },
    'grid.emitter': {
      label: 'Emitter',
      description: 'How much brighter the center of a cell is than its edges.',
    },
    'grid.bevel': {
      label: 'Bevel',
      description: 'Subtle depth: a light top edge and a dark bottom edge on each cell.',
      advanced: true,
    },
    'scene.center': {
      label: 'Center',
      description: 'Composition center in mode units (1 = half of the shorter side).',
    },
    'scene.zoom': { label: 'Zoom', description: 'Magnifies all modes around the center.' },
    'animation.speed': { label: 'Speed', description: 'Global time multiplier for all modes.' },
    'animation.blend': {
      label: 'Mode blending',
      description: 'How several active modes are combined.',
    },
    'animation.brightness': { label: 'Brightness', description: 'Cell intensity multiplier.' },
    'animation.gamma': {
      label: 'Contrast (gamma)',
      description: 'Values above 1 darken the midtones and increase contrast.',
    },
    'animation.floor': {
      label: 'Unlit visibility',
      description: 'How visible the unlit cells are.',
    },
    'animation.energy': {
      label: 'Energy',
      description: 'External drive: handy for modulating with audio or events.',
    },
    'animation.flicker.amount': { label: 'Amount', description: 'Flicker amplitude.' },
    'animation.flicker.rate': {
      label: 'Rate',
      description: 'How fast the brightness changes.',
      unit: 'Hz',
    },
    'animation.sparkle.amount': {
      label: 'Amount',
      description: 'Brightness added during a flash.',
    },
    'animation.sparkle.rate': {
      label: 'Rate',
      description: 'Flash probability per cell per second.',
    },
    'animation.sparkle.duration': {
      label: 'Duration',
      description: 'Length of a single flash.',
      unit: 's',
    },
    'animation.sparsity.amount': {
      label: 'Amount',
      description: 'Share of switched-off cells in weak areas.',
    },
    'animation.sparsity.period': {
      label: 'Period',
      description: 'How often the switched-off cells are reshuffled.',
      unit: 's',
    },
    'modes.flow.weight': {
      label: 'Weight',
      description: 'Contribution of the mode to the final image; 0 turns the mode off.',
    },
    'modes.flow.scale': {
      label: 'Scale',
      description: 'Noise frequency: higher values give smaller blobs.',
    },
    'modes.flow.speed': { label: 'Speed', description: 'How fast the pattern flows.' },
    'modes.flow.direction': {
      label: 'Direction',
      description: 'Where the pattern flows.',
      unit: '°',
    },
    'modes.flow.threshold': {
      label: 'Threshold',
      description: 'Higher values leave fewer glowing blobs.',
    },
    'modes.flow.softness': {
      label: 'Softness',
      description: 'Width of the transition from dark to light.',
    },
    'modes.sphere.weight': {
      label: 'Weight',
      description: 'Contribution of the mode to the final image; 0 turns the mode off.',
    },
    'modes.sphere.radius': { label: 'Radius', description: 'Sphere radius in mode units.' },
    'modes.sphere.shift': {
      label: 'Shell offset',
      description:
        'Offset of the glowing shell relative to the hole: the ring is thicker and denser on that side while the hole stays centered.',
    },
    'modes.sphere.hole': {
      label: 'Hole',
      description: 'Radius of the dark middle; 0 gives a solid orb.',
    },
    'modes.sphere.holeSoftness': {
      label: 'Hole softness',
      description: 'Width of the transition from the hole to the bright ring.',
    },
    'modes.sphere.rimPower': {
      label: 'Rim',
      description: 'Higher values push the light toward the edge of the sphere.',
    },
    'modes.sphere.outerFalloff': {
      label: 'Outer falloff',
      description: 'How far the light reaches beyond the sphere radius.',
    },
    'modes.sphere.lightAngle': {
      label: 'Light direction',
      description: 'Which side of the sphere is lit more strongly.',
      unit: '°',
    },
    'modes.sphere.lightStrength': {
      label: 'Light strength',
      description: 'Contrast between the lit side and the shadow side.',
    },
    'modes.sphere.rotationSpeed': {
      label: 'Rotation',
      description: 'Rotation speed of the sphere surface (the sign sets the direction).',
    },
    'modes.sphere.tilt': {
      label: 'Axis tilt',
      description: 'Tilt of the rotation axis.',
      unit: '°',
    },
    'modes.sphere.surface': {
      label: 'Surface',
      description: 'Strength of the pattern on the sphere surface.',
    },
    'modes.sphere.surfaceScale': {
      label: 'Surface scale',
      description: 'Frequency of the surface pattern.',
    },
    'modes.sphere.wobble': {
      label: 'Wobble',
      description: 'Noise distortion of the sphere outline.',
    },
    'modes.sphere.breathe': {
      label: 'Breathing',
      description: 'Amplitude of the radius pulsation.',
    },
    'modes.sphere.breatheSpeed': {
      label: 'Breathing rate',
      description: 'Frequency of the radius pulsation.',
    },
    'modes.sphere.fadeAngle': {
      label: 'Fade side',
      description: 'Direction in which the sphere dissolves into the background.',
      unit: '°',
    },
    'modes.sphere.fadeAmount': {
      label: 'Fade amount',
      description: 'How strongly the fade side dims.',
    },
    'modes.pulse.weight': {
      label: 'Weight',
      description: 'Contribution of the mode to the final image; 0 turns the mode off.',
    },
    'modes.pulse.speed': { label: 'Speed', description: 'How fast the rings expand.' },
    'modes.pulse.frequency': { label: 'Frequency', description: 'Rings per mode unit.' },
    'modes.pulse.width': { label: 'Width', description: 'Ring thickness.' },
    'modes.pulse.breathe': { label: 'Breathing', description: 'Overall brightness pulsation.' },
    'modes.pulse.falloff': {
      label: 'Falloff',
      description: 'How fast the rings fade with distance.',
    },
    'modes.pulse.origin': {
      label: 'Origin',
      description: 'Ring center relative to the composition center.',
    },
    'modes.wave.weight': {
      label: 'Weight',
      description: 'Contribution of the mode to the final image; 0 turns the mode off.',
    },
    'modes.wave.angle': {
      label: 'Direction',
      description: 'Direction in which the waves travel.',
      unit: '°',
    },
    'modes.wave.frequency': { label: 'Frequency', description: 'Crests per mode unit.' },
    'modes.wave.speed': { label: 'Speed', description: 'How fast the waves travel.' },
    'modes.wave.sharpness': {
      label: 'Sharpness',
      description: 'Higher values give narrow bright crests.',
    },
    'modes.wave.interference': {
      label: 'Interference',
      description: 'Mix of a second wave at a different angle.',
    },
    'modes.ripple.weight': {
      label: 'Weight',
      description: 'Contribution of the mode to the final image; 0 turns the mode off.',
    },
    'modes.ripple.rate': {
      label: 'Rate',
      description: 'How many drops appear per second.',
      unit: '/s',
    },
    'modes.ripple.speed': { label: 'Speed', description: 'How fast a ring expands.' },
    'modes.ripple.width': { label: 'Width', description: 'Ring thickness.' },
    'modes.ripple.life': {
      label: 'Lifetime',
      description: 'How long a single ring lives.',
      unit: 's',
    },
    'modes.vortex.weight': {
      label: 'Weight',
      description: 'Contribution of the mode to the final image; 0 turns the mode off.',
    },
    'modes.vortex.arms': { label: 'Arms', description: 'Number of spiral arms.' },
    'modes.vortex.twist': {
      label: 'Twist',
      description: 'How tightly the arms are wound (the sign sets the direction).',
    },
    'modes.vortex.speed': { label: 'Speed', description: 'Rotation speed of the vortex.' },
    'modes.vortex.falloff': {
      label: 'Falloff',
      description: 'How fast the vortex fades away from the center.',
    },
    'modes.vortex.sharpness': { label: 'Sharpness', description: 'Crispness of the arm edges.' },
    'modes.life.weight': {
      label: 'Weight',
      description: 'Contribution of the mode to the final image; 0 turns the mode off.',
    },
    'modes.life.stepRate': {
      label: 'Steps per second',
      description: 'Evolution speed of the automaton.',
      unit: 'Hz',
    },
    'modes.life.birthRate': {
      label: 'Spontaneous births',
      description: 'Chance of a random cell birth per step; keeps the field from dying out.',
    },
    'modes.life.fadeSteps': {
      label: 'Fade',
      description: 'How many steps a dead cell takes to fade out.',
    },
    'modes.life.seedDensity': {
      label: 'Seed density',
      description: 'Share of live cells after a reset.',
    },
    'modes.life.rule': {
      label: 'Rule',
      description: 'Birth and survival rule; changing it restarts the field.',
    },
    'modes.rain.weight': {
      label: 'Weight',
      description: 'Contribution of the mode to the final image; 0 turns the mode off.',
    },
    'modes.rain.speed': { label: 'Speed', description: 'How fast the drops fall.' },
    'modes.rain.density': { label: 'Density', description: 'Share of columns with rain.' },
    'modes.rain.tail': {
      label: 'Trail',
      description: 'Length of the glowing trail behind a drop.',
    },
    'modes.rain.angle': {
      label: 'Slant',
      description: 'Deviation of the rain from vertical.',
      unit: '°',
    },
    'color.palette': { label: 'Palette', description: 'Gradient color stops, from start to end.' },
    'color.interpolation': {
      label: 'Interpolation',
      description: 'How neighboring palette colors are blended.',
    },
    'color.mapping': {
      label: 'Mapping',
      description: 'What sets the position of a cell on the palette.',
    },
    'color.angle': {
      label: 'Axis angle',
      description: 'Direction from the start of the palette to its end (axis mapping).',
      unit: '°',
    },
    'color.bend': {
      label: 'Axis bend',
      description:
        'Bends the color boundaries into arcs around the center (axis mapping): the start color gathers into a crescent on one side.',
    },
    'color.scale': {
      label: 'Stretch',
      description: 'Higher values repeat the palette more often.',
    },
    'color.offset': { label: 'Offset', description: 'Shifts the palette along the mapping.' },
    'color.warp': { label: 'Warp', description: 'Noise distortion of the color boundaries.' },
    'color.warpScale': { label: 'Warp scale', description: 'Frequency of the warp noise.' },
    'color.jitter': { label: 'Jitter', description: 'Random color offset of each cell.' },
    'color.intensityShift': {
      label: 'Brightness shift',
      description: 'Bright cells move along the palette.',
    },
    'color.drift': { label: 'Drift', description: 'Palette scrolling, in cycles per second.' },
    'color.saturation': { label: 'Saturation', description: 'Saturation of the cell colors.' },
    'color.hot.amount': { label: 'Amount', description: 'How much the bright cells lighten.' },
    'color.hot.threshold': {
      label: 'Threshold',
      description: 'Brightness at which the hot core starts.',
    },
    'color.hot.core': { label: 'Core', description: 'Size of the hot middle of a cell.' },
    'color.accent.color': { label: 'Color', description: 'Color of the accent patches.' },
    'color.accent.amount': {
      label: 'Amount',
      description: 'How strongly the patches take the accent color; 0 turns it off.',
    },
    'background.color': { label: 'Color', description: 'Main background color.' },
    'background.vignette': {
      label: 'Vignette',
      description: 'Darkens the background corners (the cells are not affected).',
    },
    'background.spotA.color': { label: 'Color', description: 'Spot color.' },
    'background.spotA.position': { label: 'Position', description: 'Spot center in mode units.' },
    'background.spotA.radius': { label: 'Radius', description: 'Spot size.' },
    'background.spotA.strength': { label: 'Strength', description: 'Spot brightness.' },
    'background.spotB.color': { label: 'Color', description: 'Spot color.' },
    'background.spotB.position': { label: 'Position', description: 'Spot center in mode units.' },
    'background.spotB.radius': { label: 'Radius', description: 'Spot size.' },
    'background.spotB.strength': { label: 'Strength', description: 'Spot brightness.' },
    'glow.halo.strength': { label: 'Strength', description: 'Halo brightness.' },
    'glow.halo.radius': {
      label: 'Radius',
      description: 'How far the halo reaches into the gap.',
      unit: 'cells',
    },
    'glow.bloom.strength': { label: 'Strength', description: 'Bloom brightness.' },
    'glow.bloom.radius': {
      label: 'Radius',
      description: 'Bloom blur width, in cells.',
      unit: 'cells',
    },
    'glow.bloom.threshold': {
      label: 'Threshold',
      description: 'Brightness at which a cell starts to glow.',
    },
    'glow.bloom.knee': {
      label: 'Threshold knee',
      description: 'Softness of the transition through the threshold.',
    },
    'glow.haze.strength': { label: 'Strength', description: 'Haze brightness.' },
    'glow.haze.radius': {
      label: 'Radius',
      description: 'Haze blur width, in cells.',
      unit: 'cells',
    },
    'glow.saturation': {
      label: 'Glow saturation',
      description: 'Saturation of the halo, bloom and haze.',
    },
    'glow.exposure': { label: 'Exposure', description: 'Overall brightness before tone mapping.' },
    'glow.whitePoint': {
      label: 'White point',
      description: 'Brightness that maps to white; higher values give softer highlights.',
    },
    'lift.enabled': { label: 'Enabled', description: 'Show lifted pixels.' },
    'lift.style': { label: 'Style', description: 'Pop up in place or float upward like bubbles.' },
    'lift.amount': { label: 'Amount', description: 'Share of cells lifted at the same time.' },
    'lift.max': { label: 'Maximum', description: 'Limit on simultaneously lifted cells.' },
    'lift.scale': { label: 'Scale', description: 'How many times larger a lifted cell is.' },
    'lift.height': { label: 'Height', description: 'Upward offset while lifted.', unit: 'cells' },
    'lift.parallax': {
      label: 'Parallax',
      description: 'Offset away from the center that adds a sense of depth.',
    },
    'lift.tilt': { label: 'Tilt', description: 'Random tilt of a lifted cell.', unit: '°' },
    'lift.holdMin': { label: 'Hold min', description: 'Minimum time spent lifted.', unit: 's' },
    'lift.holdMax': { label: 'Hold max', description: 'Maximum time spent lifted.', unit: 's' },
    'lift.rise': {
      label: 'Rise',
      description: 'Rise duration (with a springy overshoot).',
      unit: 's',
    },
    'lift.fall': { label: 'Fall', description: 'Duration of the return to place.', unit: 's' },
    'lift.brightness': { label: 'Brightness', description: 'Extra brightness of a lifted cell.' },
    'lift.whiten': { label: 'Whiten', description: 'Shifts the color toward a lighter tint.' },
    'lift.bokeh': {
      label: 'Bokeh',
      description: 'Share of lifted cells blurred as if out of focus.',
    },
    'lift.shadow': { label: 'Shadow', description: 'Density of the shadow under a lifted cell.' },
    'lift.halo': { label: 'Halo', description: 'Glow around a lifted cell.' },
    'lift.socket': { label: 'Socket', description: 'How much the spot a cell rose from darkens.' },
    'lift.threshold': {
      label: 'Threshold',
      description: 'Minimum cell brightness required to lift.',
    },
    'lift.outerBias': { label: 'Edge bias', description: 'Prefer outer and dim areas.' },
    'lift.cluster': {
      label: 'Clusters',
      description: 'Chance to lift neighboring cells together with a cell.',
    },
    'lift.landing': {
      label: 'Landing',
      description: 'Strength of the ripple ring when a cell lands.',
    },
    'lift.floatSpeed': {
      label: 'Float speed',
      description: 'Rise speed in the Float style.',
      unit: 'cells/s',
      visibleWhen: { path: 'lift.style', eq: 'float' },
    },
    'lift.floatDrift': {
      label: 'Drift',
      description: 'Sideways sway while floating.',
      visibleWhen: { path: 'lift.style', eq: 'float' },
    },
    'interaction.pointer': {
      label: 'Pointer',
      description: 'Light up the cells under the pointer.',
    },
    'interaction.pointerRadius': {
      label: 'Pointer radius',
      description: 'Size of the light spot around the pointer.',
      unit: 'cells',
      visibleWhen: { path: 'interaction.pointer', eq: true },
    },
    'interaction.pointerStrength': {
      label: 'Pointer strength',
      description: 'Brightness of the highlight under the pointer.',
      visibleWhen: { path: 'interaction.pointer', eq: true },
    },
    'interaction.pointerLift': {
      label: 'Lift on hover',
      description: 'Lift cells under the pointer.',
      visibleWhen: { path: 'interaction.pointer', eq: true },
    },
    'interaction.click': { label: 'Click', description: 'Start a ripple on click.' },
    'interaction.rippleStrength': {
      label: 'Ripple strength',
      description: 'Brightness of the click ripple.',
      visibleWhen: { path: 'interaction.click', eq: true },
    },
    'interaction.rippleSpeed': {
      label: 'Ripple speed',
      description: 'How fast the ripple expands.',
      unit: 'cells/s',
      visibleWhen: { path: 'interaction.click', eq: true },
    },
    'interaction.rippleWidth': {
      label: 'Ripple width',
      description: 'Thickness of the ripple ring.',
      unit: 'cells',
      visibleWhen: { path: 'interaction.click', eq: true },
    },
    'interaction.influenceStrength': {
      label: 'Influence strength',
      description: 'Default strength for bound elements (bindElement / addInfluence).',
    },
    'interaction.influenceFalloff': {
      label: 'Influence falloff',
      description: 'Default width of the soft edge of an influence.',
      unit: 'cells',
    },
    'render.quality': {
      label: 'Quality',
      description: '"Auto" lowers the quality when the device cannot keep up.',
    },
    'render.maxDpr': { label: 'Max DPR', description: 'Upper limit of the canvas pixel density.' },
    'render.maxPixels': {
      label: 'Max pixels',
      description: 'Upper limit of the canvas size; phones are capped at 2.4 MP.',
      unit: 'MP',
    },
    'render.overflow': {
      label: 'Overflow',
      description: 'The canvas extends past the container so the glow is not clipped.',
      unit: 'px',
    },
    'render.maxFps': {
      label: 'Max FPS',
      description: '0 follows the display rate; otherwise an integer divisor of the refresh rate.',
    },
    'render.pauseOffscreen': {
      label: 'Pause offscreen',
      description: 'Stop rendering while the background is not visible.',
    },
    'render.reducedMotion': {
      label: 'Reduced motion',
      description: 'Whether to honor the system prefers-reduced-motion setting.',
    },
    transition: {
      label: 'Transition',
      description: 'Duration of the smooth transition when settings change.',
      unit: 'ms',
    },
  },
  enums: {
    'grid.sizing': { pitch: 'Pitch in px', count: 'Cell count' },
    'animation.blend': { screen: 'Screen', add: 'Add', max: 'Max' },
    'modes.life.rule': {
      conway: 'Conway B3/S23',
      highlife: 'HighLife B36/S23',
      daynight: 'Day & Night',
      seeds: 'Seeds B2/S',
    },
    'color.interpolation': { oklab: 'OKLab (smooth)', linear: 'Linear (RGB)', steps: 'Steps' },
    'color.mapping': {
      spatial: 'Along axis',
      radial: 'Radial',
      angular: 'Angular',
      intensity: 'By brightness',
      noise: 'Noise',
    },
    'lift.style': { pop: 'Pop', float: 'Float' },
    'render.quality': { auto: 'Auto', high: 'High', medium: 'Medium', low: 'Low' },
    'render.reducedMotion': { respect: 'Respect', ignore: 'Ignore' },
  },
  presets: PRESET_TEXTS,
};

/**
 * UI metadata of the group or field at a dotted path (undefined for unknown paths; '' is the
 * root). Groups never set the field-only keys (`unit`, `widget`).
 */
export function getMeta(path: string): FieldMeta | undefined {
  if (Object.hasOwn(SCHEMA_META.fields, path)) return SCHEMA_META.fields[path];
  if (Object.hasOwn(SCHEMA_META.groups, path)) return SCHEMA_META.groups[path];
  return undefined;
}
