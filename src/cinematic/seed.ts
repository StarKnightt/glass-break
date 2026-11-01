import { mulberry32 } from '../scene/rand';

/** Offline render mode (`?render=1`): everything that uses Math.random becomes reproducible. */
export const RENDER_MODE = new URLSearchParams(location.search).has('render');

export function seedRandom(seed: number) {
  const r = mulberry32(seed);
  Math.random = r;
}

if (RENDER_MODE) seedRandom(0x51a55);
