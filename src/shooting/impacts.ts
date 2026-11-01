import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type Scene,
} from 'three';

const MAX_P = 384;
const MAX_DECALS = 48;

const vert = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uScale / -mv.z;
    vAlpha = aAlpha;
    vColor = aColor;
  }
`;
const frag = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot(c, c) * 4.0;
    float a = (1.0 - d) * vAlpha;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

function holeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grd.addColorStop(0, 'rgba(8,5,3,1)');
  grd.addColorStop(0.35, 'rgba(20,12,6,0.95)');
  grd.addColorStop(0.6, 'rgba(60,40,22,0.45)');
  grd.addColorStop(1, 'rgba(60,40,22,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

/** Cheap miss feedback: CPU-integrated dust/splinter particles plus small bullet-hole decals. */
export function createImpacts(scene: Scene) {
  const pos = new Float32Array(MAX_P * 3);
  const vel = new Float32Array(MAX_P * 3);
  const alpha = new Float32Array(MAX_P);
  const size = new Float32Array(MAX_P);
  const color = new Float32Array(MAX_P * 3);
  const life = new Float32Array(MAX_P);
  const age = new Float32Array(MAX_P);
  const drag = new Float32Array(MAX_P);
  const grav = new Float32Array(MAX_P);
  const baseAlpha = new Float32Array(MAX_P);
  let next = 0;
  let live = 0;

  const geo = new BufferGeometry();
  const posAttr = new BufferAttribute(pos, 3);
  const alphaAttr = new BufferAttribute(alpha, 1);
  const sizeAttr = new BufferAttribute(size, 1);
  const colorAttr = new BufferAttribute(color, 3);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('aAlpha', alphaAttr);
  geo.setAttribute('aSize', sizeAttr);
  geo.setAttribute('aColor', colorAttr);
  const mat = new ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: { uScale: { value: 600 } },
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
  });
  const points = new Points(geo, mat);
  points.frustumCulled = false;
  points.name = 'impactParticles';
  points.renderOrder = 5;
  scene.add(points);

  const holeMat = new MeshBasicMaterial({
    map: holeTexture(),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
  const holeGeo = new CircleGeometry(1, 12);
  const decals: Mesh[] = [];
  let decalNext = 0;

  const tmp = new Vector3();
  const tan = new Vector3();
  const bit = new Vector3();
  const col = new Color();
  const up = new Vector3(0, 0, 1);
  const q = new Quaternion();

  function spawn(p: Vector3, v: Vector3, c: Color, s: number, a: number, l: number, dr: number, g: number) {
    const i = next;
    next = (next + 1) % MAX_P;
    pos.set([p.x, p.y, p.z], i * 3);
    vel.set([v.x, v.y, v.z], i * 3);
    color.set([c.r, c.g, c.b], i * 3);
    size[i] = s;
    baseAlpha[i] = a;
    alpha[i] = a;
    life[i] = l;
    age[i] = 0;
    drag[i] = dr;
    grav[i] = g;
    live = MAX_P;
  }

  function basis(n: Vector3) {
    tan.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).cross(n).normalize();
    bit.crossVectors(n, tan);
  }

  return {
    /** Ground: soft tan dust puff kicked up along the surface normal. */
    dust(p: Vector3, n: Vector3) {
      basis(n);
      for (let k = 0; k < 22; k++) {
        const r = Math.random();
        tmp
          .copy(n)
          .multiplyScalar(0.6 + Math.random() * 1.4)
          .addScaledVector(tan, (Math.random() - 0.5) * 1.6)
          .addScaledVector(bit, (Math.random() - 0.5) * 1.6);
        col.setRGB(0.3 + r * 0.08, 0.24 + r * 0.06, 0.17 + r * 0.05);
        spawn(p, tmp, col, 0.04 + Math.random() * 0.06, 0.3, 0.9 + Math.random() * 0.9, 3.2, 0.4);
      }
      for (let k = 0; k < 8; k++) {
        tmp.copy(n).multiplyScalar(1.5 + Math.random() * 2).addScaledVector(tan, (Math.random() - 0.5) * 2).addScaledVector(bit, (Math.random() - 0.5) * 2);
        col.setRGB(0.18, 0.14, 0.1);
        spawn(p, tmp, col, 0.012, 0.9, 0.5, 0.5, 9.8);
      }
    },
    /** Wood: splinter flecks + a little sawdust, plus a small hole decal. */
    splinter(p: Vector3, n: Vector3, dir: Vector3) {
      basis(n);
      for (let k = 0; k < 14; k++) {
        tmp
          .copy(n)
          .multiplyScalar(1 + Math.random() * 2.5)
          .addScaledVector(tan, (Math.random() - 0.5) * 2.4)
          .addScaledVector(bit, (Math.random() - 0.5) * 2.4);
        const r = Math.random();
        col.setRGB(0.36 + r * 0.15, 0.26 + r * 0.1, 0.16 + r * 0.06);
        spawn(p, tmp, col, 0.01 + Math.random() * 0.012, 1, 0.6 + Math.random() * 0.5, 0.6, 9.8);
      }
      for (let k = 0; k < 10; k++) {
        tmp.copy(n).multiplyScalar(0.3 + Math.random() * 0.6).addScaledVector(tan, (Math.random() - 0.5) * 0.6).addScaledVector(bit, (Math.random() - 0.5) * 0.6);
        col.setRGB(0.26, 0.21, 0.15);
        spawn(p, tmp, col, 0.03 + Math.random() * 0.035, 0.2, 0.8 + Math.random() * 0.6, 3, 0.3);
      }
      let d = decals[decalNext];
      if (!d) {
        d = new Mesh(holeGeo, holeMat);
        d.name = 'bulletHole';
        d.renderOrder = 4;
        decals[decalNext] = d;
        scene.add(d);
      }
      decalNext = (decalNext + 1) % MAX_DECALS;
      d.visible = true;
      q.setFromUnitVectors(up, n);
      d.quaternion.copy(q);
      d.rotateZ(Math.random() * Math.PI * 2);
      d.position.copy(p).addScaledVector(n, 0.0015);
      const s = 0.0055 + Math.random() * 0.002;
      d.scale.set(s * (1 + Math.min(0.6, 1 - Math.abs(dir.dot(n)))), s, s);
    },
    clearDecals() {
      for (const d of decals) d.visible = false;
    },
    update(dt: number, viewportH: number, fovRad: number) {
      mat.uniforms.uScale.value = viewportH / (2 * Math.tan(fovRad / 2));
      if (!live) return;
      let any = false;
      for (let i = 0; i < MAX_P; i++) {
        if (alpha[i] <= 0) continue;
        age[i] += dt;
        const t = age[i] / life[i];
        if (t >= 1) {
          alpha[i] = 0;
          continue;
        }
        any = true;
        const k = Math.exp(-drag[i] * dt);
        const j = i * 3;
        vel[j] *= k;
        vel[j + 1] = vel[j + 1] * k - grav[i] * dt;
        vel[j + 2] *= k;
        pos[j] += vel[j] * dt;
        pos[j + 1] = Math.max(0.005, pos[j + 1] + vel[j + 1] * dt);
        pos[j + 2] += vel[j + 2] * dt;
        size[i] *= 1 + dt * (grav[i] < 1 ? 0.9 : 0);
        alpha[i] = baseAlpha[i] * (1 - t) * (1 - t);
      }
      if (!any) live = 0;
      posAttr.needsUpdate = alphaAttr.needsUpdate = sizeAttr.needsUpdate = colorAttr.needsUpdate = true;
    },
  };
}
