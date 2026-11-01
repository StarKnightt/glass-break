import { RENDER_MODE } from './cinematic/seed';
import { NoToneMapping, PCFShadowMap, SRGBColorSpace, Timer, WebGLRenderer, type Vector3 } from 'three';
import { buildBackyard } from './scene';
import { createCameraRig } from './scene/camera';
import { createPost } from './fx/post';
import { createDebugHud } from './core/debug';
import type { UpdateFn, World } from './core/world';
import { createBottles } from './bottles';
import { createShooting } from './shooting';
import { createHud } from './ui/hud';
import { createFracture } from './fracture';
import { createSlowmo } from './fx/slowmo';
import { createAudio } from './audio';
import { createLiquid } from './liquid';
import { wireFeel } from './fx/wire';
import { createTracer } from './shooting/tracer';
import { createCinematic } from './cinematic';

const MAX_PIXEL_RATIO = 1.5;
/** Offline render resolution (`?cinematic&render=1`). */
const RENDER_W = 1920;
const RENDER_H = 1080;

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
  const shooting = createShooting(world, bottles);
  const ui = createHud(shooting, bottles);
  const fracture = createFracture(world, bottles);
  shooting.autoRemove = false;
  shooting.onHit((bottle, point, normal, dir) => fracture.shatter(bottle, point, normal, dir));
  const slowmo = createSlowmo(world, post);
  shooting.viewOffset = () => slowmo.aimOffset;
  const audio = createAudio(world, () => slowmo.amount);
  const liquid = createLiquid(world);
  wireFeel({ world, shooting, fracture, slowmo, audio, liquid });
  const resetAll = bottles.resetAll;
  bottles.resetAll = () => {
    fracture.clearShards();
    slowmo.reset();
    liquid.clear();
    resetAll();
  };
  const tracer = createTracer(world);
  let shotDir: Vector3 | null = null;
  shooting.onFire((_o, dir) => (shotDir = dir));
  shooting.onHit((_b, point) => shotDir && tracer.fire(point, shotDir));
  shooting.onMiss((point) => shotDir && tracer.fire(point, shotDir));
  const cine = createCinematic({ world, post, bottles, fracture, liquid, slowmo, shooting, audio, hud: ui.root });
  Object.assign(window, { world, post, bottles, shooting, ui, fracture, slowmo, audio, liquid, cine });

  const resize = () => {
    if (RENDER_MODE) {
      renderer.setPixelRatio(1);
      renderer.setSize(RENDER_W, RENDER_H, false);
      post.composer.setSize(RENDER_W, RENDER_H, false);
      camera.aspect = RENDER_W / RENDER_H;
      camera.updateProjectionMatrix();
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(innerWidth, innerHeight);
    post.composer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  if (RENDER_MODE) resize();

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

  const step = (dtReal: number) => {
    hud?.begin();
    renderer.info.reset();
    cine.preStep(dtReal);

    const t = world.time;
    t.real += dtReal;
    const dt = dtReal * t.scale;
    t.game += dt;

    rig.update(t.real);
    yard.grass.update(t.game);
    yard.dust.update(t.game, renderer.domElement.height, fovRad());
    for (const fn of updates) fn(dt, t.game);
    for (const fn of realUpdates) fn(dtReal, t.real);
    cine.postStep(dtReal);

    post.composer.render(dtReal);
    hud?.end(dtReal * 1000);
  };

  if (RENDER_MODE) {
    // offline: the page is stepped frame by frame by scripts/render-intro.mjs
    const FRAME = 1 / 60;
    Object.assign(window, {
      __cine: {
        start: () => cine.play(),
        /** Advances exactly 1/60 s and returns the frame as a PNG data URL. */
        renderFrame: () => {
          step(FRAME);
          return renderer.domElement.toDataURL('image/png');
        },
        warm: (n: number) => {
          for (let i = 0; i < n; i++) step(FRAME);
        },
        get done() {
          return cine.done;
        },
        get time() {
          return cine.time;
        },
        get events() {
          return cine.events;
        },
        renderAudio: async (duration: number) => (await import('./cinematic/soundtrack')).renderSoundtrack(cine.events, duration),
      },
    });
    return;
  }

  renderer.setAnimationLoop((now) => {
    timer.update(now);
    step(Math.min(timer.getDelta(), 0.1));
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyC' && !e.repeat) cine.play();
    else if (e.code === 'Escape' && cine.active) cine.stop();
  });
  // Esc while pointer-locked only releases the lock (no keydown), so that skips too
  shooting.onLockChange((locked) => {
    if (!locked && cine.active) cine.stop();
  });
  if (new URLSearchParams(location.search).has('cinematic')) setTimeout(() => cine.play(), 900);
}

boot();
