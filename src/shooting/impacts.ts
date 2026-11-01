import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
  PlaneGeometry,
  Points,
  Quaternion,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  type Scene,
  type Texture,
} from 'three';

const MAX_P = 320;
const MAX_S = 96;
const MAX_DECALS = 40;
const WIND = new Vector3(0.32, 0, -0.08);
/** Fresh pale wood (#c9a46a) and the dry orange dirt of the yard, both linear. */
const WOOD = new Color('#c9a46a');
const DIRT = new Color().setRGB(0.36, 0.23, 0.135).multiplyScalar(1.2);

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
    float a = (1.0 - smoothstep(0.15, 1.0, d)) * clamp(vAlpha, 0.0, 1.0);
    if (a <= 0.003) discard;
    gl_FragColor = vec4(max(vColor, vec3(0.0)), a);
  }
`;

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Bullet hole in weathered wood: ~5 mm dark core inside an irregular pale torn-fiber ring ~14 mm. */
function woodHoleTex() {
  return canvasTex(128, (g, s) => {
    const h = s / 2;
    // plane spans 18 mm -> 1 mm = s/18 px
    const mm = s / 18;
    g.translate(h, h);
    g.save();
    g.scale(1.3, 1); // elongated along the grain (local x)
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2;
      const r0 = 2 * mm;
      const r1 = (4.5 + Math.random() * 3.2) * mm;
      g.strokeStyle = `rgba(${200 + Math.random() * 30},${165 + Math.random() * 25},${105 + Math.random() * 25},${0.55 + Math.random() * 0.4})`;
      g.lineWidth = 0.6 * mm + Math.random() * 0.8 * mm;
      g.beginPath();
      g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      const bend = (Math.random() - 0.5) * 0.25;
      g.lineTo(Math.cos(a + bend) * r1, Math.sin(a + bend) * r1);
      g.stroke();
    }
    const ring = g.createRadialGradient(0, 0, 2 * mm, 0, 0, 5.5 * mm);
    ring.addColorStop(0, 'rgba(215,182,120,0.9)');
    ring.addColorStop(1, 'rgba(215,182,120,0)');
    g.fillStyle = ring;
    g.beginPath();
    g.arc(0, 0, 5.5 * mm, 0, Math.PI * 2);
    g.fill();
    g.restore();
    const core = g.createRadialGradient(0, 0, 0.5 * mm, 0, 0, 2.7 * mm);
    core.addColorStop(0, 'rgba(4,3,2,1)');
    core.addColorStop(0.75, 'rgba(18,11,6,1)');
    core.addColorStop(1, 'rgba(50,32,16,0)');
    g.fillStyle = core;
    g.beginPath();
    g.arc(0, 0, 2.7 * mm, 0, Math.PI * 2);
    g.fill();
  });
}

/** Small dirt crater (~4 cm): dark disturbed center, lighter thrown-up rim. */
function craterTex() {
  return canvasTex(64, (g, s) => {
    const h = s / 2;
    const grd = g.createRadialGradient(h, h, 1, h, h, h);
    grd.addColorStop(0, 'rgba(26,16,9,0.9)');
    grd.addColorStop(0.38, 'rgba(60,38,22,0.75)');
    grd.addColorStop(0.62, 'rgba(205,160,112,0.55)');
    grd.addColorStop(1, 'rgba(205,160,112,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = h * (0.45 + Math.random() * 0.45);
      g.fillStyle = `rgba(${150 + Math.random() * 60},${110 + Math.random() * 40},${70 + Math.random() * 30},0.6)`;
      g.fillRect(h + Math.cos(a) * r, h + Math.sin(a) * r, 1.5, 1.5);
    }
  });
}

/**
 * Miss feedback. Soft sprites (spurt, clouds, fiber dust) on one Points draw; slivers and clods
 * as velocity-aligned instanced boxes; hole/crater decals as a small recycled pool.
 */
export function createImpacts(scene: Scene) {
  // --- sprites ---------------------------------------------------------------------------
  const pos = new Float32Array(MAX_P * 3);
  const vel = new Float32Array(MAX_P * 3);
  const alpha = new Float32Array(MAX_P);
  const size = new Float32Array(MAX_P);
  const color = new Float32Array(MAX_P * 3);
  const life = new Float32Array(MAX_P);
  const age = new Float32Array(MAX_P);
  const drag = new Float32Array(MAX_P);
  const grav = new Float32Array(MAX_P);
  const grow = new Float32Array(MAX_P);
  const wind = new Float32Array(MAX_P);
  const fadeIn = new Float32Array(MAX_P);
  const a0 = new Float32Array(MAX_P);
  let next = 0;
  let spritesLive = false;

  const geo = new BufferGeometry();
  const attr = (a: Float32Array, n: number) => new BufferAttribute(a, n).setUsage(DynamicDrawUsage);
  const posAttr = attr(pos, 3);
  const alphaAttr = attr(alpha, 1);
  const sizeAttr = attr(size, 1);
  const colorAttr = attr(color, 3);
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

  // --- slivers / clods ------------------------------------------------------------------
  const sMesh = new InstancedMesh(
    new BoxGeometry(1, 1, 1),
    new MeshStandardMaterial({ roughness: 0.85, metalness: 0 }),
    MAX_S,
  );
  sMesh.name = 'impactSlivers';
  sMesh.frustumCulled = false;
  sMesh.castShadow = false;
  sMesh.instanceMatrix.setUsage(DynamicDrawUsage);
  const sPos = new Float32Array(MAX_S * 3);
  const sVel = new Float32Array(MAX_S * 3);
  const sDim = new Float32Array(MAX_S * 3); // length, width, thickness
  const sSpin = new Float32Array(MAX_S * 2); // roll angle, roll speed
  const sAge = new Float32Array(MAX_S);
  const sLife = new Float32Array(MAX_S);
  const sDrag = new Float32Array(MAX_S);
  const sStretch = new Float32Array(MAX_S);
  const sAlive = new Uint8Array(MAX_S);
  const sDir = new Float32Array(MAX_S * 3); // last orientation dir (kept after landing)
  let sNext = 0;
  let sLive = false;
  const zero = new Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAX_S; i++) {
    sMesh.setMatrixAt(i, zero);
    sMesh.setColorAt(i, WOOD);
  }
  scene.add(sMesh);

  // --- decals ---------------------------------------------------------------------------
  const holeMat = new MeshBasicMaterial({ map: woodHoleTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
  const craterMat = new MeshBasicMaterial({ map: craterTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
  const plane = new PlaneGeometry(2, 2);
  const decals: Mesh[] = [];
  let decalNext = 0;

  const tmp = new Vector3();
  const tan = new Vector3();
  const bit = new Vector3();
  const col = new Color();
  const m4 = new Matrix4();
  const q = new Quaternion();
  const qr = new Quaternion();
  const X = new Vector3(1, 0, 0);
  const sc = new Vector3();
  const pv = new Vector3();

  function sprite(p: Vector3, v: Vector3, c: Color, s: number, a: number, l: number, dr: number, g: number, gr = 0, w = 0, fi = 60) {
    const i = next;
    next = (next + 1) % MAX_P;
    pos.set([p.x, p.y, p.z], i * 3);
    vel.set([v.x, v.y, v.z], i * 3);
    color.set([c.r, c.g, c.b], i * 3);
    size[i] = s;
    a0[i] = a;
    alpha[i] = a;
    life[i] = l;
    age[i] = 0;
    drag[i] = dr;
    grav[i] = g;
    grow[i] = gr;
    wind[i] = w;
    fadeIn[i] = fi;
    spritesLive = true;
  }

  function sliver(p: Vector3, v: Vector3, c: Color, len: number, wid: number, thk: number, l: number, dr: number, stretch: number) {
    const i = sNext;
    sNext = (sNext + 1) % MAX_S;
    sPos.set([p.x, p.y, p.z], i * 3);
    sVel.set([v.x, v.y, v.z], i * 3);
    sDim.set([len, wid, thk], i * 3);
    sSpin.set([Math.random() * 6.28, (Math.random() - 0.5) * 60], i * 2);
    tmp.copy(v).normalize();
    sDir.set([tmp.x, tmp.y, tmp.z], i * 3);
    sAge[i] = 0;
    sLife[i] = l;
    sDrag[i] = dr;
    sStretch[i] = stretch;
    sAlive[i] = 1;
    sMesh.setColorAt(i, c);
    sMesh.instanceColor!.needsUpdate = true;
    sLive = true;
  }

  function basis(n: Vector3) {
    tan.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).cross(n).normalize();
    bit.crossVectors(n, tan);
  }
  /** Random direction in the hemisphere around n, with `spread` lateral jitter. */
  function hemi(n: Vector3, spread: number, out: Vector3) {
    return out
      .copy(n)
      .addScaledVector(tan, (Math.random() - 0.5) * 2 * spread)
      .addScaledVector(bit, (Math.random() - 0.5) * 2 * spread)
      .normalize();
  }

  function decal(m: MeshBasicMaterial, p: Vector3, n: Vector3, half: number, grain: Vector3 | null, aspect = 1) {
    let d = decals[decalNext];
    if (!d) {
      d = new Mesh(plane, m);
      d.name = 'impactDecal';
      d.renderOrder = 4;
      decals[decalNext] = d;
      scene.add(d);
    }
    decalNext = (decalNext + 1) % MAX_DECALS;
    d.material = m;
    d.visible = true;
    // local z = normal, local x = grain direction projected onto the surface
    const zx = n;
    const gx = (grain ? tmp.copy(grain) : tmp.set(Math.random() - 0.5, 0, Math.random() - 0.5)).addScaledVector(zx, -tmp.dot(zx));
    if (gx.lengthSq() < 1e-6) gx.set(0, 1, 0).addScaledVector(zx, -zx.y);
    gx.normalize();
    const gy = pv.crossVectors(zx, gx);
    m4.makeBasis(gx, gy, zx);
    d.quaternion.setFromRotationMatrix(m4);
    d.rotateZ((Math.random() - 0.5) * 0.25);
    d.position.copy(p).addScaledVector(n, 0.001);
    d.scale.set(half * aspect, half, 1);
  }

  const api = {
    /** Wood: pale fresh-wood slivers (fast, then dropping), faint fiber dust, torn hole decal. */
    splinter(p: Vector3, n: Vector3, dir: Vector3) {
      basis(n);
      const refl = pv.copy(dir).addScaledVector(n, -2 * dir.dot(n)).normalize();
      const k = 7 + ((Math.random() * 5) | 0);
      for (let i = 0; i < k; i++) {
        hemi(n, 0.9, tmp).addScaledVector(refl, 0.4).normalize();
        const speed = 4 + Math.random() * 5;
        col.copy(WOOD).multiplyScalar(0.75 + Math.random() * 0.4);
        sliver(p, tmp.multiplyScalar(speed), col, 0.005 + Math.random() * 0.01, 0.0009 + Math.random() * 0.0008, 0.0006, 0.7 + Math.random() * 0.5, 9, 0.006);
      }
      for (let i = 0; i < 8; i++) {
        hemi(n, 0.7, tmp).multiplyScalar(0.3 + Math.random() * 0.5);
        col.copy(WOOD).multiplyScalar(0.8);
        sprite(p, tmp, col, 0.02 + Math.random() * 0.025, 0.2, 0.5, 4, 0.1, 1.6, 0.6);
      }
      decal(holeMat, p, n, 0.009, X, 1);
    },
    /** Ground: sharp vertical spurt + clods in the first ~30 ms, then a drifting dirt cloud and a crater. */
    dust(p: Vector3, n: Vector3) {
      basis(n);
      for (let i = 0; i < 18; i++) {
        hemi(n, 0.16, tmp).multiplyScalar(3 + Math.random() * 2);
        col.copy(DIRT).multiplyScalar(0.85 + Math.random() * 0.3);
        sprite(p, tmp, col, 0.025 + Math.random() * 0.03, 0.7, 0.3 + Math.random() * 0.2, 12, 0.5, 1.2, 0);
      }
      for (let i = 0; i < 8; i++) {
        hemi(n, 0.45, tmp).multiplyScalar(1.8 + Math.random() * 1.8);
        col.copy(DIRT).multiplyScalar(0.55 + Math.random() * 0.25);
        const s = 0.004 + Math.random() * 0.006;
        sliver(p, tmp, col, s, s * 0.8, s * 0.7, 1.4, 0.6, 0.002);
      }
      for (let i = 0; i < 5; i++) {
        hemi(n, 0.6, tmp).multiplyScalar(0.25 + Math.random() * 0.35);
        col.copy(DIRT).multiplyScalar(0.95 + Math.random() * 0.15);
        tmp.y += 0.15;
        sprite(pv.copy(p).addScaledVector(n, 0.05), tmp, col, 0.06 + Math.random() * 0.05, 0.14, 1.4 + Math.random() * 0.7, 1.5, 0, 2.4, 1, 5);
      }
      decal(craterMat, p, n, 0.02, null, 1);
    },
    clear() {
      for (const d of decals) d.visible = false;
      alpha.fill(0);
      sAlive.fill(0);
      for (let i = 0; i < MAX_S; i++) sMesh.setMatrixAt(i, zero);
      posAttr.needsUpdate = alphaAttr.needsUpdate = true;
      sMesh.instanceMatrix.needsUpdate = true;
      spritesLive = sLive = false;
    },
    update(dt: number, viewportH: number, fovRad: number) {
      mat.uniforms.uScale.value = viewportH / (2 * Math.tan(fovRad / 2));
      if (dt <= 0) return;
      if (spritesLive) {
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
          const w = wind[i] * (1 - k);
          vel[j] = vel[j] * k + WIND.x * w;
          vel[j + 1] = vel[j + 1] * k - grav[i] * dt;
          vel[j + 2] = vel[j + 2] * k + WIND.z * w;
          pos[j] += vel[j] * dt;
          pos[j + 1] = Math.max(0.005, pos[j + 1] + vel[j + 1] * dt);
          pos[j + 2] += vel[j + 2] * dt;
          size[i] *= 1 + dt * grow[i] * (1 - t);
          alpha[i] = a0[i] * (1 - t) * (1 - t * 0.5) * Math.min(1, age[i] * fadeIn[i]);
        }
        spritesLive = any;
        posAttr.needsUpdate = alphaAttr.needsUpdate = sizeAttr.needsUpdate = colorAttr.needsUpdate = true;
      }
      if (sLive) {
        let any = false;
        for (let i = 0; i < MAX_S; i++) {
          if (!sAlive[i]) continue;
          sAge[i] += dt;
          const t = sAge[i] / sLife[i];
          if (t >= 1) {
            sAlive[i] = 0;
            sMesh.setMatrixAt(i, zero);
            continue;
          }
          any = true;
          const j = i * 3;
          const k = Math.exp(-sDrag[i] * dt);
          sVel[j] *= k;
          sVel[j + 1] = sVel[j + 1] * k - 9.8 * dt;
          sVel[j + 2] *= k;
          pv.set(sVel[j], sVel[j + 1], sVel[j + 2]);
          let speed = pv.length();
          const y = sPos[j + 1] + sVel[j + 1] * dt;
          if (y <= 0.003) {
            sVel[j] = sVel[j + 1] = sVel[j + 2] = 0;
            sPos[j + 1] = 0.003;
            speed = 0;
            sSpin[i * 2 + 1] = 0;
          } else {
            sPos[j] += sVel[j] * dt;
            sPos[j + 1] = y;
            sPos[j + 2] += sVel[j + 2] * dt;
            if (speed > 0.3) sDir.set([pv.x / speed, pv.y / speed, pv.z / speed], j);
          }
          sSpin[i * 2] += sSpin[i * 2 + 1] * dt;
          tmp.set(sDir[j], sDir[j + 1], sDir[j + 2]);
          q.setFromUnitVectors(X, tmp);
          qr.setFromAxisAngle(X, sSpin[i * 2]);
          q.multiply(qr);
          const fade = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;
          sc.set((sDim[j] + speed * sStretch[i]) * fade, sDim[j + 1] * fade, sDim[j + 2] * fade);
          m4.compose(pv.set(sPos[j], sPos[j + 1], sPos[j + 2]), q, sc);
          sMesh.setMatrixAt(i, m4);
        }
        sLive = any;
        sMesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
  return api;
}
