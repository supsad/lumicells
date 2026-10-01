/**
 * Minimal PNG decoder for Playwright screenshots (8-bit RGB or RGBA, not interlaced), so pixel
 * checks run in Node, independent of the page under test.
 */
import { inflateSync } from 'node:zlib';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, rows top to bottom. */
  data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePng(buf: Buffer): RgbaImage {
  if (!SIGNATURE.every((b, i) => buf[i] === b)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      const interlace = body[12];
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) {
        throw new Error(`unsupported PNG (depth ${depth}, color ${color}, interlace ${interlace})`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x] as number;
      const a = x >= channels ? (rows[out + x - channels] as number) : 0;
      const b = y > 0 ? (rows[out - stride + x] as number) : 0;
      const c = y > 0 && x >= channels ? (rows[out - stride + x - channels] as number) : 0;
      let p = 0;
      switch (filter) {
        case 0:
          p = 0;
          break;
        case 1:
          p = a;
          break;
        case 2:
          p = b;
          break;
        case 3:
          p = (a + b) >> 1;
          break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      rows[out + x] = (v + p) & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: rows };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rows.length; i += 3, j += 4) {
    data[j] = rows[i] as number;
    data[j + 1] = rows[i + 1] as number;
    data[j + 2] = rows[i + 2] as number;
    data[j + 3] = 255;
  }
  return { width, height, data };
}
