import { Scene, type WebGLRenderer } from 'three';
import { setupEnvironment } from './environment';
import { createFence } from './fence';
import { createGround } from './ground';
import { createGrass } from './grass';
import { createDust } from './dust';

/** Builds the static golden-hour backyard: HDRI sky/env, sun + shadows, fence, ground, grass, dust. */
export async function buildBackyard(renderer: WebGLRenderer) {
  const scene = new Scene();
  const env = await setupEnvironment(scene);

  const fence = createFence(renderer);
  scene.add(fence.group);

  scene.add(createGround(renderer, env.hdr, env.bgSampleRot, fence.postBases));

  const grass = createGrass(env.sunDir);
  scene.add(grass.mesh);

  const dust = createDust(env.sunDir, fence.railTopY, 10.5);
  scene.add(dust.points);

  return { scene, env, fence, grass, dust };
}
