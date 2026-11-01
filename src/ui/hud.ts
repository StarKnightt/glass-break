import type { Shooting } from '../shooting';
import type { BottleSystem } from '../bottles';

const CSS = `
#hud { position: fixed; inset: 0; pointer-events: none; z-index: 20;
  font: 500 11px/1.2 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: rgba(244,238,226,0.88); letter-spacing: 0.14em; text-transform: uppercase;
  text-shadow: 0 1px 2px rgba(0,0,0,0.5); user-select: none; }
#hud .vig { position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 0, rgba(0,0,0,0) 40vmin, rgba(0,0,0,0.22) 62vmin, rgba(0,0,0,0.55) 90vmin); }
#hud .xh { position: absolute; left: 50%; top: 50%; width: 0; height: 0; transition: opacity .2s; }
#hud .xh i { position: absolute; background: rgba(255,255,255,0.82); box-shadow: 0 0 0 1px rgba(0,0,0,0.35); transition: background-color 60ms; }
#hud .xh .h { width: 5px; height: 1px; top: -0.5px; }
#hud .xh .v { width: 1px; height: 5px; left: -0.5px; }
#hud .xh .l { left: -8px; } #hud .xh .r { left: 3px; }
#hud .xh .t { top: -8px; } #hud .xh .b { top: 3px; }
#hud .xh.hit i { background: rgba(255,214,150,1); }
#hud .stats { position: absolute; right: 22px; top: 18px; display: flex; gap: 14px; align-items: center; }
#hud .score { font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: 0.06em; font-size: 13px; color: rgba(255,250,240,0.95); }
#hud button { pointer-events: auto; font: inherit; letter-spacing: inherit; text-transform: inherit; color: inherit;
  background: none; border: 1px solid rgba(244,238,226,0.35); border-radius: 2px; padding: 3px 8px; cursor: pointer; }
#hud button:hover { border-color: rgba(244,238,226,0.75); }
#hud .start { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 12px; align-items: center; justify-content: center;
  pointer-events: auto; cursor: pointer; background: radial-gradient(ellipse at center, rgba(0,0,0,0.0), rgba(0,0,0,0.3)); transition: opacity .35s; }
#hud .start span { padding: 9px 16px; border: 1px solid rgba(244,238,226,0.5); border-radius: 2px; background: rgba(10,8,6,0.3); letter-spacing: 0.24em; }
#hud .start small { font-size: 10px; letter-spacing: 0.2em; text-transform: lowercase; opacity: 0.8; }
body.gb-nocursor, body.gb-nocursor canvas { cursor: none; }
`;

/** Minimal typographic HUD: crosshair, "hits / shots", reset, start overlay with hint. */
export function createHud(shooting: Shooting, bottles: BottleSystem) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'hud';
  root.innerHTML = `
    <div class="vig"></div>
    <div class="xh"><i class="h l"></i><i class="h r"></i><i class="v t"></i><i class="v b"></i></div>
    <div class="stats"><span class="score">0 / 0</span><button class="reset">reset</button></div>
    <div class="start"><span>click to start</span><small>click to shoot · right-click zoom · R reset</small></div>`;
  document.body.appendChild(root);
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  const score = $('.score');
  const start = $('.start');
  const label = start.querySelector('span')!;
  const xh = $('.xh');
  const vig = $('.vig');

  const showStart = (on: boolean, text = 'click to start') => {
    start.style.opacity = on ? '1' : '0';
    start.style.pointerEvents = on ? 'auto' : 'none';
    label.textContent = text;
    xh.style.opacity = on ? '0' : '1';
    document.body.classList.toggle('gb-nocursor', !on && shooting.fallback);
  };
  start.addEventListener('click', () => {
    shooting.start();
    if (shooting.fallback) showStart(false);
  });
  shooting.onLockChange((locked, error) => {
    if (locked) showStart(false);
    else showStart(true, error ? 'click again to resume' : 'click to resume');
  });

  const refresh = () => (score.textContent = `${shooting.hits} / ${shooting.shots}`);
  const reset = () => {
    bottles.resetAll();
    shooting.reset();
    refresh();
  };
  $('.reset').addEventListener('click', (e) => {
    e.stopPropagation();
    reset();
  });
  $('.reset').addEventListener('mousedown', (e) => e.stopPropagation());
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && !e.repeat) reset();
  });
  let flashTimer = 0;
  shooting.onFire(() => queueMicrotask(refresh));
  shooting.onHit(() => {
    queueMicrotask(refresh);
    xh.classList.add('hit');
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => xh.classList.remove('hit'), 80);
  });

  let lastZ = -1;
  const tick = () => {
    const z = shooting.zoom;
    if (z !== lastZ) {
      vig.style.opacity = String(z);
      lastZ = z;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  showStart(true);
  return { root, reset, refresh, showStart };
}
