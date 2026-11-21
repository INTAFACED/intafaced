/** Every light object, by kind. Imported only by the lazy path in ../index.ts, so it shares the 3D chunk. */
import { sphere } from './sphere.js';
import { field } from './field.js';
import { logo } from './logo.js';
import { coin } from './coin.js';

export const factories = { sphere, field, logo, coin } as const;
