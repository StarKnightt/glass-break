import type { Object3D } from 'three';
import type { World } from '../core/world';
import type { Shooting } from '../shooting';
import type { Slowmo } from './slowmo';
import type { GameAudio } from '../audio';
import type { Liquid } from '../liquid';

interface FractureLike {
  onShatter?: (fn: (bottle: Parameters<Liquid['spawn']>[0], point: Parameters<Liquid['spawn']>[1], dir: Parameters<Liquid['spawn']>[2]) => void) => void;
  onShardImpact?: (fn: (position: Parameters<GameAudio['tinkle']>[0], speed: number, size: number) => void) => void;
}

const isFence = (o: Object3D | null) => {
  for (let n = o; n; n = n.parent) if (n.name === 'fence' || n.name.startsWith('bottle')) return true;
  return false;
};

/** Connects shooting / fracture events to slow-mo, audio and the liquid splash (fracture is optional). */
export function wireFeel(o: { world: World; shooting: Shooting; fracture: unknown; slowmo: Slowmo; audio: GameAudio; liquid: Liquid }) {
  const { world, shooting, slowmo, audio, liquid } = o;
  const fracture = (o.fracture ?? null) as FractureLike | null;
  shooting.onFire(() => audio.gunshot());
  shooting.onMiss((point, _n, object) => audio.miss(point, isFence(object)));
  if (fracture?.onShatter) {
    fracture.onShatter((bottle, point, dir) => {
      slowmo.trigger(bottle.group.position);
      audio.shatter(bottle.type, point);
      if (bottle.fill > 0.02) {
        audio.splash(bottle.fill, point);
        liquid.spawn(bottle, point, dir);
      }
    });
  } else {
    shooting.onHit((bottle, point) => {
      slowmo.trigger(bottle.group.position);
      audio.shatter(bottle.type, point);
    });
  }
  fracture?.onShardImpact?.((p, speed, size) => audio.tinkle(p, speed, size));
  void world;
}
