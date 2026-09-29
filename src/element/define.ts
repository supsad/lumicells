/**
 * Side-effect entry: importing this module registers <pixel-life>. Guarded, so it is a no-op on
 * the server and when the tag is already defined (e.g. loaded twice through two bundles).
 */

import { definePixelLifeElement } from './pixel-life-element';

definePixelLifeElement();
