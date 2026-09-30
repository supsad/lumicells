import { describe, expect, it } from 'vitest';
import {
  FRAME_FLOATS,
  frameUploadRanges,
  MAX_INFLUENCES,
  MAX_LIFTS,
  MAX_PULSES,
  OFF_COUNTS,
  OFF_INF,
  OFF_PULSE,
  OFF_SOCKET,
  UPLOAD_MERGE_GAP,
} from '../src/core/engine/frame-block';
import { glowMix } from '../src/core/engine/passes/bloom';
import { isTiledRenderer } from '../src/core/gl/caps';

function ranges(nInf: number, nPulse: number, nSock: number): [number, number][] {
  const frame = new Float32Array(FRAME_FLOATS);
  frame[OFF_COUNTS] = nInf;
  frame[OFF_COUNTS + 1] = nPulse;
  frame[OFF_COUNTS + 2] = nSock;
  const out = new Int32Array(6);
  const n = frameUploadRanges(frame, out);
  const r: [number, number][] = [];
  for (let i = 0; i < n; i++) r.push([out[i * 2] as number, out[i * 2 + 1] as number]);
  return r;
}

const total = (r: [number, number][]) => r.reduce((a, [s, e]) => a + e - s, 0);

describe('frameUploadRanges', () => {
  it('uploads only the header when nothing is live', () => {
    expect(ranges(0, 0, 0)).toEqual([[0, OFF_INF]]);
  });

  it('a single lift socket no longer drags the influence and pulse arrays along', () => {
    const r = ranges(0, 0, 1);
    expect(r).toEqual([
      [0, OFF_INF],
      [OFF_SOCKET, OFF_SOCKET + 4],
    ]);
    // Header + one socket, instead of the ~4 KB prefix up to the first socket.
    expect(total(r) * 4).toBeLessThan(256);
  });

  it('typical frame: header + influences, pulses, sockets in three ranges', () => {
    const r = ranges(3, 1, 40);
    expect(r).toEqual([
      [0, OFF_INF + 36],
      [OFF_PULSE, OFF_PULSE + 12],
      [OFF_SOCKET, OFF_SOCKET + 160],
    ]);
    expect(total(r)).toBe(OFF_INF + 36 + 12 + 160);
  });

  it('merges ranges separated by a small gap', () => {
    // All pulses used: the pulse range ends where the sockets start.
    const r = ranges(0, MAX_PULSES, 2);
    expect(r).toEqual([
      [0, OFF_INF],
      [OFF_PULSE, OFF_SOCKET + 8],
    ]);
    // Influences filling up to within UPLOAD_MERGE_GAP of the pulses merge with them.
    const nInf = MAX_INFLUENCES - Math.floor(UPLOAD_MERGE_GAP / 12);
    expect(ranges(nInf, 1, 0)).toEqual([[0, OFF_PULSE + 12]]);
  });

  it('clamps and rounds counts like the shaders', () => {
    expect(ranges(1e6, 1e6, 1e6)).toEqual([[0, FRAME_FLOATS]]);
    expect(ranges(-3, 0.4, 1.6)).toEqual([
      [0, OFF_INF],
      [OFF_SOCKET, OFF_SOCKET + 8],
    ]);
    expect(OFF_SOCKET + MAX_LIFTS * 4).toBe(FRAME_FLOATS);
  });
});

describe('glow layers per debug view', () => {
  it('final view combines bloom and vignetted haze; debug views isolate one layer', () => {
    expect(glowMix(0)).toEqual([1, 1, 1]);
    expect(glowMix(3)).toEqual([1, 0, 0]);
    expect(glowMix(4)).toEqual([0, 1, 0]);
  });
});

describe('isTiledRenderer', () => {
  it('treats mobile / Apple GPUs and unknown strings as tilers', () => {
    expect(isTiledRenderer('ANGLE (ARM, Mali-G57 MC2, OpenGL ES 3.2)')).toBe(true);
    expect(isTiledRenderer('Adreno (TM) 650')).toBe(true);
    expect(
      isTiledRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'),
    ).toBe(true);
    expect(isTiledRenderer('PowerVR Rogue GE8320')).toBe(true);
    expect(isTiledRenderer('')).toBe(true);
  });

  it('treats desktop GPUs and CPU rasterizers as immediate-mode', () => {
    expect(
      isTiledRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    ).toBe(false);
    expect(isTiledRenderer('ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0)')).toBe(
      false,
    );
    expect(isTiledRenderer('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)')).toBe(false);
    expect(isTiledRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))')).toBe(
      false,
    );
  });
});
