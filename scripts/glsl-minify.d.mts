import type { Plugin } from 'vite';

export interface GlslMinifyOptions {
  /** Modules to process (default: TypeScript under src/core). */
  include?: RegExp;
}

/** Vite plugin: minifies GLSL template literals in the modules matching `include`. */
export function glslMinify(options?: GlslMinifyOptions): Plugin;

/** True for the parts of a multi-line template literal that reads as GLSL. */
export function looksLikeGlsl(parts: readonly string[]): boolean;

/**
 * Minifies the parts (raw strings between interpolations) of a GLSL template literal; null when
 * the template is left as it is.
 */
export function minifyGlsl(parts: readonly string[]): string[] | null;

/** Minifies the GLSL template literals of one module; null when nothing changed. */
export function minifyGlslSource(
  code: string,
  parse: (code: string) => unknown,
): { code: string; templates: number; saved: number } | null;
