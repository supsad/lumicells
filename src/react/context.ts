'use client';

import { createContext } from 'react';
import type { PixelLife } from '../core/pixel-life';

/** The live instance of the nearest <PixelLife>, or null before mount / when unsupported. */
export const PixelLifeContext = createContext<PixelLife | null>(null);
