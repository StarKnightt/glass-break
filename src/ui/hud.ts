import type { Shooting } from '../shooting';
import type { BottleSystem } from '../bottles';

const CSS = `
#hud { position: fixed; inset: 0; pointer-events: none; z-index: 20;
  font: 500 11px/1.2 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: rgba(244,238,226,0.86); letter-spacing: 0.14em; text-transform: uppercase;
  text-shadow: 0 1px 2px rgba(0,0,0,0.45); user-select: none; }
#hud .xh { position: absolute; left: 50%; top: 50%; width: 0; height: 0; transition: opacity .2s; }
#hud .xh i { position: absolute; background: rgba(255,255,255,0.78); box-shadow: 0 0 1px rgba(0,0,0,0.6); }
#hud .xh .h { width: 5px; height: 1px; top: -0.5px; }
#hud .xh .v { width: 1px; height: 5px; left: -0.5px; }
#hud .xh .l { left: -9px; } #hud .xh .r { left: 4px; }
#hud .xh .t { top: -9px; } #hud .xh .b { top: 4px; }
#hud .xh .d { width: 1.5px; height: 1.5px; left: -0.75px; top: -0.75px; border-radius: 1px; background: rgba(255,255,255,0.6); }
#hud .stats { position: absolute; right: 22px; top: 18px; display: flex; gap: 18px; align-items: baseline; }
#hud .stats b { font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: 0.04em; font-size: 13px; margin-left: 6px; color: rgba(255,250,240,0.95); }
#hud button { pointer-events: auto; font: inherit; letter-spacing: inherit; text-transform: inherit; color: inherit;
  background: none; border: 1px solid rgba(244,238,226,0.35); border-radius: 2px; padding: 3px 8px; cursor: pointer; }
#hud button:hover { border-color: rgba(244,238,226,0.75); }
#hud .hint { position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%); opacity: 0.7;
  transition: opacity 1.6s ease; white-space: nowrap; letter-spacing: 0.2em; font-size: 10px; text-transform: lowercase; }
#hud .start { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  pointer-events: auto; cursor: pointer; background: radial-gradient(ellipse at center, rgba(0,0,0,0.0), rgba(0,0,0,0.28)); transition: opacity .35s; }
#hud .start span { padding: 9px 16px; border: 1px solid rgba(244,238,226,0.45); border-radius: 2px; background: rgba(10,8,6,0.25); letter-spacing: 0.24em; }
`;

/** Minimal typographic HUD: crosshair, hits/shots, reset, start overlay, fading hint. */
export function createHud(shooting: Shooting, bottles: BottleSystem) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'hud';
  root.innerHTML = `
    <div class="xh"><i class="h l"></i><i class="h r"></i><i class="v t"></i><i class="v b"></i><i class="d"></i></div>
    <div class="stats"><span>hits<b class="hits">0</b></span><span>shots<b class="shots">0</b></span><button class="reset">reset</button></div>
    <div class="hint">click to shoot · right-click zoom · R reset</div>
    <div class="start"><span>click to start</span></div>`;
  document.body.appendChild(root);
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  const hitsEl = $('.hits');
  const shotsEl = $('.shots');
  const hint = $('.hint');
  const start = $('.start');
  const xh = $('.xh');

  let hintTimer = 0;
  const showStart = (on: boolean, label = 'click to start') => {
    start.style.opacity = on ? '1' : '0';
    start.style.pointerEvents = on ? 'auto' : 'none';
    start.querySelector('span')!.textContent = label;
    xh.style.opacity = on ? '0' : '1';
  };
  start.addEventListener('click', () => {
    shooting.start();
    showStart(false);
    clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => (hint.style.opacity = '0'), 4500);
  });
  document.addEventListener('pointerlockchange', () =>
    setTimeout(() => {
      if (!shooting.active) showStart(true, 'click to resume');
    }, 0),
  );

  const refresh = () => {
    hitsEl.textContent = String(shooting.hits);
    shotsEl.textContent = String(shooting.shots);
  };
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
  shooting.onFire(() => queueMicrotask(refresh));
  shooting.onHit(() => queueMicrotask(refresh));

  showStart(true);
  return { root, reset, refresh, showStart };
}
