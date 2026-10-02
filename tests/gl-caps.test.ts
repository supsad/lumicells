import { describe, expect, it } from 'vitest';
import { isSoftwareRenderer, type RendererGL, readRenderer } from '../src/core/gl/caps';

const RENDERER = 0x1f01;
const UNMASKED_RENDERER_WEBGL = 0x9246;

/** A context reporting `plain` as RENDERER and `unmasked` through the debug extension (null: none). */
function fakeGl(plain: string | null, unmasked: string | null) {
  const asked: string[] = [];
  const gl: RendererGL = {
    RENDERER,
    getParameter(pname) {
      if (pname === RENDERER) return plain;
      if (pname === UNMASKED_RENDERER_WEBGL) return unmasked;
      return null;
    },
    getExtension(name) {
      asked.push(name);
      return unmasked === null
        ? null
        : ({ UNMASKED_RENDERER_WEBGL, UNMASKED_VENDOR_WEBGL: 0x9245 } as WEBGL_debug_renderer_info);
    },
  };
  return { gl, asked };
}

describe('renderer string', () => {
  it('Firefox: RENDERER is already unmasked, the deprecated debug extension is never enabled', () => {
    const ff = 'ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar';
    const { gl, asked } = fakeGl(ff, ff);
    expect(readRenderer(gl)).toBe(ff);
    expect(asked).toEqual([]);
  });

  it('Chrome and Safari: the generic mask is replaced by the debug extension', () => {
    const angle = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    const chrome = fakeGl('WebKit WebGL', angle);
    expect(readRenderer(chrome.gl)).toBe(angle);
    expect(chrome.asked).toEqual(['WEBGL_debug_renderer_info']);
    expect(readRenderer(fakeGl('WebKit WebGL', 'Apple GPU').gl)).toBe('Apple GPU');
  });

  it('falls back to RENDERER when the extension is unavailable', () => {
    expect(readRenderer(fakeGl('WebKit WebGL', null).gl)).toBe('WebKit WebGL');
    expect(readRenderer(fakeGl(null, null).gl)).toBe('');
    expect(readRenderer(fakeGl('', 'llvmpipe (LLVM 17.0.6, 256 bits)').gl)).toBe(
      'llvmpipe (LLVM 17.0.6, 256 bits)',
    );
  });

  it('software rasterizers in every browser', () => {
    for (const r of [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0), or similar',
      'llvmpipe, or similar',
      'Mesa, llvmpipe (LLVM 17.0.6, 256 bits)',
    ]) {
      expect(isSoftwareRenderer(r), r).toBe(true);
    }
    for (const r of [
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar',
      'Apple GPU',
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    ]) {
      expect(isSoftwareRenderer(r), r).toBe(false);
    }
  });
});
