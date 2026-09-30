'use client';

import { createContext } from 'react';
import type { PixelLife } from '../core/pixel-life';

/**
 * The instance of the nearest <PixelLife>. It is null only on the server, before mount and after
 * unmount. Without WebGL2 (or after a shader failure) the instance is still provided; check
 * `instance.supported`, listen for 'fallback' or use the component's `fallback` prop.
 */
export const PixelLifeContext = createContext<PixelLife | null>(null);
