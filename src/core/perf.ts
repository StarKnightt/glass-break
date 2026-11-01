import { Matrix4, Sphere, Vector3, type Mesh, type Object3D, type PerspectiveCamera, type Scene, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import type { EffectComposer } from 'postprocessing';

/** Physical pixels rendered at base quality (native 1440p). Larger canvases get a lower pixel ratio. */
const PIXEL_BUDGET = 2560 * 1440;
const MAX_PIXEL_RATIO = 1.5;
/** GPU ms per frame: shrink resolution above HIGH (sustained), grow back below LOW. */
const GPU_HIGH_MS = 11.5;
const GPU_LOW_MS = 7.5;
const DYN_MIN = 0.7;
/** World-space margin around transmissive objects: refraction samples up to ~0.13 m off the surface. */
const REFRACT_PAD = 0.16;

interface ShardBounds { p: Float32Array; rad: Float32Array; i: number }

/**
 * Frame-cost guards that live outside the game loop:
 * - The transmission pre-pass (full opaque scene, 4x MSAA, half float) is scissored to the
 *   screen rect actually covered by glass + its refraction reach.
 * - Pixel ratio is capped to a physical-pixel budget and scaled down when GPU time stays over budget.
 */
export function installPerf(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, composer: EffectComposer) {
  /** Live readout; `scissor` / `budget` can be flipped from the console for A/B measurements. */
  const stats = { gpuMs: 0, dynScale: 1, pixelRatio: 1, scissor: true, budget: true, applySize: () => {} };

  // ---- transmission scissor ----
  const rect = { x0: 0, y0: 0, x1: 1, y1: 1, full: true };
  const v = new Vector3();
  const sph = new Sphere();
  const viewInv = new Matrix4();
  let cam: PerspectiveCamera = camera;
  let any = false;

  const addSphere = (c: Vector3, r: number) => {
    if (rect.full) return;
    v.copy(c).applyMatrix4(viewInv);
    const z = -v.z;
    const near = cam.near;
    if (z - r <= near) { rect.full = true; return; }
    const P = cam.projectionMatrix.elements;
    const za = z - r, zb = z + r;
    const xmin = Math.min((v.x - r) / za, (v.x - r) / zb) * P[0] - P[8];
    const xmax = Math.max((v.x + r) / za, (v.x + r) / zb) * P[0] - P[8];
    const ymin = Math.min((v.y - r) / za, (v.y - r) / zb) * P[5] - P[9];
    const ymax = Math.max((v.y + r) / za, (v.y + r) / zb) * P[5] - P[9];
    if (!any) { rect.x0 = xmin; rect.x1 = xmax; rect.y0 = ymin; rect.y1 = ymax; any = true; return; }
    rect.x0 = Math.min(rect.x0, xmin); rect.x1 = Math.max(rect.x1, xmax);
    rect.y0 = Math.min(rect.y0, ymin); rect.y1 = Math.max(rect.y1, ymax);
  };
  const visit = (o: Object3D) => {
    const m = o as Mesh;
    if (rect.full || !m.isMesh) return;
    const mat = m.material as { transmission?: number };
    if (Array.isArray(mat) || !mat || !(mat.transmission! > 0)) return;
    const sb = m.userData.tBounds as ShardBounds | undefined;
    if (sb) {
      v.set(sb.p[sb.i * 3], sb.p[sb.i * 3 + 1], sb.p[sb.i * 3 + 2]);
      sph.center.copy(v);
      addSphere(sph.center, sb.rad[sb.i] * 1.5 + 0.02 + REFRACT_PAD);
      return;
    }
    if (m.frustumCulled === false) { rect.full = true; return; }
    const g = m.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    sph.copy(g.boundingSphere!).applyMatrix4(m.matrixWorld);
    addSphere(sph.center, sph.radius + REFRACT_PAD);
  };
  const prevBefore = scene.onBeforeRender;
  scene.onBeforeRender = function (...args) {
    prevBefore.apply(this, args);
    const c = args[2];
    cam = c as PerspectiveCamera;
    viewInv.copy(c.matrixWorldInverse);
    rect.full = !cam.isPerspectiveCamera || stats.scissor === false;
    any = false;
    scene.traverseVisible(visit);
    if (!any) rect.full = true;
  };

  const setRT = renderer.setRenderTarget.bind(renderer);
  renderer.setRenderTarget = (rt, face, mip) => {
    const t = rt as WebGLRenderTarget | null;
    // three's private transmission target: the only MSAA + mipmapped target without resolved depth
    if (t && t.samples >= 4 && t.texture.generateMipmaps && t.resolveDepthBuffer === false) {
      if (rect.full) {
        t.scissorTest = false;
      } else {
        const W = t.width, H = t.height;
        const x0 = Math.max(0, Math.floor((Math.max(-1, rect.x0) * 0.5 + 0.5) * W) - 4);
        const y0 = Math.max(0, Math.floor((Math.max(-1, rect.y0) * 0.5 + 0.5) * H) - 4);
        const x1 = Math.min(W, Math.ceil((Math.min(1, rect.x1) * 0.5 + 0.5) * W) + 4);
        const y1 = Math.min(H, Math.ceil((Math.min(1, rect.y1) * 0.5 + 0.5) * H) + 4);
        t.scissor.set(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
        t.scissorTest = true;
      }
    }
    setRT(rt, face, mip);
  };

  // ---- pixel ratio budget + dynamic resolution ----
  let dyn = 1;
  const baseRatio = () => {
    const css = innerWidth * innerHeight;
    if (stats.budget === false) return Math.min(devicePixelRatio, MAX_PIXEL_RATIO);
    return Math.max(Math.min(1, devicePixelRatio), Math.min(devicePixelRatio, MAX_PIXEL_RATIO, Math.sqrt(PIXEL_BUDGET / css)));
  };
  const setPR = renderer.setPixelRatio.bind(renderer);
  renderer.setPixelRatio = (value: number) => setPR(Math.min(value, baseRatio()) * dyn);
  const applySize = () => {
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
  };
  applySize();
  stats.applySize = applySize;

  const gl = renderer.getContext() as WebGL2RenderingContext;
  // `?debug` (stats-gl) owns the timer query; `?perf=fixed` disables dynamic resolution (benchmarks).
  const fixed = location.search.includes('perf=fixed');
  const ext = (location.search.includes('debug') ? null : gl.getExtension('EXT_disjoint_timer_query_webgl2')) as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const RING = 4;
  const queries: (WebGLQuery | null)[] = ext ? Array.from({ length: RING }, () => gl.createQuery()) : [];
  const busy = new Uint8Array(RING);
  let head = 0;
  let tail = 0;
  let sum = 0;
  let n = 0;
  let over = 0;
  let under = 0;
  let lastFrame = 0;
  stats.pixelRatio = renderer.getPixelRatio();
  (window as unknown as { __perf: unknown }).__perf = stats;

  const sample = (ms: number) => {
    sum += ms;
    if (++n < 30) return;
    const avg = sum / n;
    sum = 0; n = 0;
    stats.gpuMs = avg;
    if (avg > GPU_HIGH_MS) { over++; under = 0; } else if (avg < GPU_LOW_MS) { under++; over = 0; } else { over = 0; under = 0; }
    let next = dyn;
    if (over >= 2 && dyn > DYN_MIN) next = Math.max(DYN_MIN, dyn - 0.1);
    else if (under >= 6 && dyn < 1) next = Math.min(1, dyn + 0.05);
    if (next !== dyn) {
      dyn = next; over = 0; under = 0;
      applySize();
      stats.dynScale = dyn;
      stats.pixelRatio = renderer.getPixelRatio();
    }
  };

  const render = composer.render.bind(composer);
  composer.render = (dt?: number) => {
    if (fixed) {
      render(dt);
      return;
    }
    if (!ext) {
      // No timer queries: fall back to the frame interval (only reacts to missed vsyncs).
      const now = performance.now();
      if (lastFrame) sample(Math.min(now - lastFrame, 50) * 0.6);
      lastFrame = now;
      render(dt);
      return;
    }
    while (busy[tail]) {
      const q = queries[tail]!;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) sample(ms);
      busy[tail] = 0;
      tail = (tail + 1) % RING;
    }
    const q = busy[head] ? null : queries[head];
    if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    render(dt);
    if (q) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      busy[head] = 1;
      head = (head + 1) % RING;
    }
  };

  return stats;
}
