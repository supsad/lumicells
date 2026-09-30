'use client';

import { createContext } from 'react';
import type { LumiCells } from '../core/lumi-cells';

/**
 * The instance of the nearest <LumiCells>. It is null only on the server, before mount and after
 * unmount. Without WebGL2 (or after a shader failure) the instance is still provided; check
 * `instance.supported`, listen for 'fallback' or use the component's `fallback` prop.
 */
export const LumiCellsContext = createContext<LumiCells | null>(null);
