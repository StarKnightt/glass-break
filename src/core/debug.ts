import type { WebGLRenderer } from 'three';

/**
 * Dev-only FPS / frame-time / draw-call readout. Toggle with the backquote key.
 * `?debug` additionally mounts stats-gl (GPU timing).
 */
export async function createDebugHud(renderer: WebGLRenderer) {
  if (!import.meta.env.DEV && !location.search.includes('debug')) return null;

  const el = document.createElement('div');
  el.id = 'fps';
  document.body.appendChild(el);
  let visible = location.search.includes('debug');
  if (!visible) el.style.display = 'none';
  addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'Backquote') {
      visible = !visible;
      el.style.display = visible ? '' : 'none';
    }
  });

  let stats: { begin(): void; end(): void; update(): void } | null = null;
  if (location.search.includes('debug')) {
    const Stats = (await import('stats-gl')).default;
    const s = new Stats({ trackGPU: true, horizontal: true });
    s.init(renderer);
    s.dom.style.left = 'auto';
    s.dom.style.right = '0px';
    document.body.appendChild(s.dom);
    stats = s;
  }

  let frames = 0;
  let acc = 0;
  let worst = 0;
  const sample = { fps: 0, ms: 0, worstMs: 0, calls: 0, tris: 0 };
  (window as unknown as { __gb: unknown }).__gb = sample;

  return {
    begin() {
      stats?.begin();
    },
    end(dtMs: number) {
      stats?.end();
      stats?.update();
      frames++;
      acc += dtMs;
      worst = Math.max(worst, dtMs);
      if (acc >= 500) {
        sample.fps = (frames * 1000) / acc;
        sample.ms = acc / frames;
        sample.worstMs = worst;
        sample.calls = renderer.info.render.calls;
        sample.tris = renderer.info.render.triangles;
        if (visible) {
          el.textContent = `${sample.fps.toFixed(0)} fps  ${sample.ms.toFixed(1)} ms (max ${worst.toFixed(1)})\n${sample.calls} calls  ${(sample.tris / 1000).toFixed(0)}k tris`;
        }
        frames = 0;
        acc = 0;
        worst = 0;
      }
    },
  };
}
