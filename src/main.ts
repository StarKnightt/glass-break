import { NoToneMapping, PCFShadowMap, SRGBColorSpace, Timer, WebGLRenderer } from 'three';
import { buildBackyard } from './scene';
import { createCameraRig } from './scene/camera';
import { createPost } from './fx/post';
import { createDebugHud } from './core/debug';
import type { UpdateFn, World } from './core/world';
import { createBottles } from './bottles';

const MAX_PIXEL_RATIO = 1.5;

async function boot() {
  const app = document.getElementById('app')!;
  const renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping; // tone mapping happens in post
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.info.autoReset = false;
  app.appendChild(renderer.domElement);

  const yard = await buildBackyard(renderer);
  const { scene } = yard;
  const rig = createCameraRig(innerWidth / innerHeight);
  const camera = rig.camera;
  const post = createPost(renderer, scene, camera);
  const hud = await createDebugHud(renderer);

  const updates: UpdateFn[] = [];
  const realUpdates: UpdateFn[] = [];
  const world: World = {
    renderer,
    scene,
    camera,
    cameraRig: rig,
    composer: post.composer,
    sun: yard.env.sun,
    sunDir: yard.env.sunDir,
    bottleSlots: yard.fence.slots,
    railTopY: yard.fence.railTopY,
    time: { scale: 1, game: 0, real: 0 },
    onUpdate: (fn) => updates.push(fn),
    onRealUpdate: (fn) => realUpdates.push(fn),
  };
  const bottles = createBottles(world);
  Object.assign(window, { world, post, bottles });

  const resize = () => {
    renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(innerWidth, innerHeight);
    post.composer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);

  if (import.meta.env.DEV) {
    /** Renders one frame at a fixed size and returns it as a JPEG data URL (for automated shots). */
    (window as unknown as { __capture: unknown }).__capture = (w = 1600, h = 900) => {
      renderer.setPixelRatio(1);
      renderer.setSize(w, h, false);
      post.composer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      post.composer.render(0);
      const url = renderer.domElement.toDataURL('image/jpeg', 0.92);
      resize();
      return url;
    };
  }

  // Compile everything up front so the first frames don't hitch.
  await renderer.compileAsync(scene, camera);

  const timer = new Timer();
  timer.connect(document);
  const fovRad = () => (camera.fov * Math.PI) / 180;

  renderer.setAnimationLoop((now) => {
    timer.update(now);
    const dtReal = Math.min(timer.getDelta(), 0.1);
    hud?.begin();
    renderer.info.reset();

    const t = world.time;
    t.real += dtReal;
    const dt = dtReal * t.scale;
    t.game += dt;

    rig.update(t.real);
    yard.grass.update(t.game);
    yard.dust.update(t.game, renderer.domElement.height, fovRad());
    for (const fn of updates) fn(dt, t.game);
    for (const fn of realUpdates) fn(dtReal, t.real);

    post.composer.render(dtReal);
    hud?.end(dtReal * 1000);
  });
}

boot();
