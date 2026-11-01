import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector2,
  type Material,
} from 'three';

function radial(stops: [number, string][], s = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [k, col] of stops) r.addColorStop(k, col);
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

const quad = new PlaneGeometry(1, 1);
function billboard(mat: Material, order = 20) {
  const m = new Mesh(quad, mat);
  m.frustumCulled = false;
  m.renderOrder = order;
  m.visible = false;
  return m;
}

/** 5.5 mm round-nose lead/brass bullet, axis +Y, base at the origin (meters). */
export function createBullet() {
  const pts = [
    [0, 0],
    [0.0026, 0],
    [0.0028, 0.0006],
    [0.0028, 0.0068],
    [0.00265, 0.0092],
    [0.0022, 0.0114],
    [0.0014, 0.013],
    [0.0006, 0.0137],
    [0, 0.0139],
  ].map(([r, y]) => new Vector2(r, y));
  const geo = new LatheGeometry(pts, 28);
  geo.translate(0, -0.007, 0);
  const mat = new MeshStandardMaterial({ color: new Color(0.86, 0.6, 0.32), metalness: 1, roughness: 0.2, envMapIntensity: 1.4 });
  const mesh = new Mesh(geo, mat);
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  mesh.visible = false;
  const glint = billboard(
    new MeshBasicMaterial({
      map: radial([[0, 'rgba(255,255,255,1)'], [0.12, 'rgba(255,240,215,0.5)'], [0.4, 'rgba(255,210,160,0.08)'], [1, 'rgba(255,200,150,0)']]),
      color: new Color(9, 6.5, 4),
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  return { mesh, glint };
}

/** Dark blued rifle barrel with a muzzle crown; axis +Y, muzzle at the origin. */
export function createBarrel() {
  const g = new Group();
  const metal = new MeshStandardMaterial({ color: new Color(0.035, 0.036, 0.04), metalness: 0.85, roughness: 0.32 });
  const tube = new Mesh(new CylinderGeometry(0.0105, 0.0125, 0.62, 28, 1, false).translate(0, -0.31, 0), metal);
  const crown = new Mesh(new CylinderGeometry(0.0135, 0.0135, 0.035, 28).translate(0, -0.0175, 0), metal);
  const bore = new Mesh(new CylinderGeometry(0.0034, 0.0034, 0.002, 16).translate(0, 0.0003, 0), new MeshBasicMaterial({ color: 0x000000 }));
  for (const m of [tube, crown]) m.castShadow = true;
  g.add(tube, crown, bore);
  g.visible = false;
  return g;
}

export function createMuzzleFx() {
  const flash = billboard(
    new MeshBasicMaterial({
      map: radial([[0, 'rgba(255,255,255,1)'], [0.2, 'rgba(255,214,150,0.55)'], [0.55, 'rgba(255,150,60,0.1)'], [1, 'rgba(255,120,40,0)']]),
      color: new Color(6, 3.6, 1.6),
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  const smokeTex = radial([[0, 'rgba(255,255,255,0.55)'], [0.5, 'rgba(255,255,255,0.22)'], [1, 'rgba(255,255,255,0)']]);
  const smoke = [0, 1, 2, 3].map(() =>
    billboard(new MeshBasicMaterial({ map: smokeTex, color: new Color(0.62, 0.58, 0.52), transparent: true, depthWrite: false, opacity: 0 }), 19),
  );
  return { flash, smoke };
}
