import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Raycaster,
  SRGBColorSpace,
  Vector3,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
} from 'three';

function tex(draw: (g: CanvasRenderingContext2D, s: number) => void, s = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = s;
  draw(c.getContext('2d')!, s);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

const glowTex = () =>
  tex((g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.15, 'rgba(255,255,255,0.45)');
    r.addColorStop(0.5, 'rgba(255,255,255,0.08)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });

const ghostTex = () =>
  tex((g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,0.18)');
    r.addColorStop(0.72, 'rgba(255,255,255,0.32)');
    r.addColorStop(0.86, 'rgba(255,255,255,0.55)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      g.lineTo(s / 2 + Math.cos(a) * s * 0.48, s / 2 + Math.sin(a) * s * 0.48);
    }
    g.fill();
  });

const streakTex = () =>
  tex((g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.3, 'rgba(255,255,255,0.25)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });

/**
 * Cheap cinematic sun flare: a glow, an anamorphic streak and a few hexagonal ghosts along the
 * sun-to-center line, placed in camera space each frame. Fades out when the sun leaves the frame
 * or the fence blocks it.
 */
export function createFlare(scene: Scene, camera: PerspectiveCamera, sunDir: Vector3, occluders: () => Object3D[]) {
  const group = new Group();
  group.name = 'cine-flare';
  group.visible = false;
  scene.add(group);
  const quad = new PlaneGeometry(1, 1);
  const mk = (map: CanvasTexture, color: Color) => {
    const m = new Mesh(
      quad,
      new MeshBasicMaterial({ map, color, transparent: true, blending: AdditiveBlending, depthTest: false, depthWrite: false, fog: false }),
    );
    m.renderOrder = 1000;
    m.frustumCulled = false;
    group.add(m);
    return m;
  };
  const gT = glowTex();
  const hT = ghostTex();
  const sT = streakTex();
  const glow = mk(gT, new Color(1.0, 0.78, 0.5));
  const streak = mk(sT, new Color(1.0, 0.7, 0.42));
  const ghosts = [
    { k: 0.55, size: 0.05, c: new Color(0.55, 0.42, 0.25) },
    { k: 0.2, size: 0.11, c: new Color(0.2, 0.3, 0.22) },
    { k: -0.25, size: 0.07, c: new Color(0.35, 0.22, 0.14) },
    { k: -0.6, size: 0.2, c: new Color(0.12, 0.16, 0.22) },
    { k: -1.0, size: 0.09, c: new Color(0.3, 0.2, 0.12) },
  ].map((g) => ({ ...g, m: mk(hT, g.c.clone()) }));

  const p = new Vector3();
  const fwd = new Vector3();
  const ray = new Raycaster();
  let vis = 0;
  let strength = 1;

  return {
    set strength(v: number) {
      strength = v;
    },
    update(dtReal: number, enabled: boolean) {
      camera.updateMatrixWorld();
      p.copy(camera.position).addScaledVector(sunDir, 1000).project(camera);
      camera.getWorldDirection(fwd);
      const front = fwd.dot(sunDir) > 0;
      const edge = Math.max(Math.abs(p.x), Math.abs(p.y));
      let target = enabled && front ? Math.max(0, Math.min(1, (1.35 - edge) / 0.45)) : 0;
      if (target > 0) {
        ray.set(camera.position, sunDir);
        ray.far = 200;
        if (ray.intersectObjects(occluders(), true).length) target = 0;
      }
      vis += (target - vis) * (1 - Math.exp(-dtReal * 14));
      group.visible = vis > 0.003;
      if (!group.visible) return;
      group.position.copy(camera.position);
      group.quaternion.copy(camera.quaternion);
      const ty = Math.tan((camera.fov * Math.PI) / 360);
      const tx = ty * camera.aspect;
      const place = (m: Mesh, k: number, size: number, sx = 1) => {
        m.position.set(p.x * k * tx, p.y * k * ty, -1);
        m.scale.set(size * ty * sx, size * ty, 1);
      };
      const a = vis * strength;
      place(glow, 1, 0.9);
      (glow.material as MeshBasicMaterial).opacity = 0.55 * a;
      place(streak, 1, 0.07, 26);
      (streak.material as MeshBasicMaterial).opacity = 0.32 * a;
      for (const g of ghosts) {
        place(g.m, g.k, g.size * 2);
        (g.m.material as MeshBasicMaterial).opacity = 0.38 * a * (0.6 + 0.4 * Math.min(1, 1.3 - edge));
      }
    },
    hide() {
      vis = 0;
      group.visible = false;
    },
  };
}
