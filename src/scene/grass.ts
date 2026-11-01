import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { mulberry32 } from './rand';
import { SUN_COLOR, SUN_INTENSITY } from './environment';

const SEGS = 4;

/** One tapered, pre-curved blade of unit height. */
function bladeGeometry() {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= SEGS; i++) {
    const t = i / SEGS;
    const w = 0.5 * (1 - t) ** 0.9 + 0.02;
    const bend = 0.35 * t * t;
    pos.push(-w, t, bend, w, t, bend);
    const shade = 0.45 + 0.55 * t;
    col.push(shade, shade, shade, shade, shade, shade);
  }
  for (let i = 0; i < SEGS; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Sparse straw-colored grass tufts. Sways with wind and glows when backlit by the sun
 * (fake translucency that respects the shadow map).
 */
export function createGrass(sunDir: Vector3, count = 30000) {
  const rnd = mulberry32(42);
  const mat = new MeshStandardMaterial({
    vertexColors: true,
    side: DoubleSide,
    roughness: 0.85,
    metalness: 0,
  });
  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: sunDir },
    uSunCol: { value: new Color().copy(SUN_COLOR).multiplyScalar(SUN_INTENSITY) },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           vec3 ip = instanceMatrix[3].xyz;
           float h = position.y * position.y;
           float w = sin(uTime * 1.3 + ip.x * 0.7 + ip.z * 0.4) * 0.6 + sin(uTime * 2.7 + ip.x * 2.1) * 0.25;
           transformed.x += w * h * 0.08;
           transformed.z += w * h * 0.04;
         }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunDir; uniform vec3 uSunCol;')
      .replace(
        '#include <lights_fragment_begin>',
        `#include <lights_fragment_begin>
         #if NUM_DIR_LIGHTS > 0
         {
           // directLight still holds the (shadowed) sun from the loop above.
           float shadowed = clamp(length(directLight.color) / max(length(uSunCol), 1e-3), 0.0, 1.0);
           vec3 V = normalize(vViewPosition);
           vec3 L = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
           float back = pow(clamp(dot(-V, L), 0.0, 1.0), 3.0);
           reflectedLight.directDiffuse += diffuseColor.rgb * uSunCol * back * shadowed * 0.55;
         }
         #endif`,
      );
  };

  const geo = bladeGeometry();
  const mesh = new InstancedMesh(geo, mat, count);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  mesh.name = 'grass';

  const m = new Matrix4();
  const q = new Quaternion();
  const s = new Vector3();
  const p = new Vector3();
  const axisY = new Vector3(0, 1, 0);
  const tilt = new Quaternion();
  const tiltAxis = new Vector3();
  const c = new Color();
  const base = [new Color('#cdb07a'), new Color('#b89a62'), new Color('#d9c493'), new Color('#9c8a5a'), new Color('#a7a067')];

  let i = 0;
  // Tufts: clusters of blades. Denser along the fence line (unmowed) and patchy elsewhere.
  while (i < count) {
    let cx: number, cz: number;
    const r = rnd();
    if (r < 0.3) {
      cx = (rnd() - 0.5) * 22;
      cz = -0.25 + (rnd() - 0.5) * 0.9;
    } else if (r < 0.55) {
      // behind the fence, thinning out with distance
      cx = (rnd() - 0.5) * 34;
      cz = -1 - 14 * rnd() ** 1.5;
    } else {
      cx = (rnd() - 0.5) * 26;
      cz = -7 + rnd() * 15;
      if (cz > 3 && Math.abs(cx) < 1.5) continue; // keep the shooter's spot clear
    }
    let tuft = 6 + Math.floor(rnd() * 18);
    let tall = r < 0.3 ? 0.28 + rnd() * 0.4 : r < 0.55 ? 0.18 + rnd() * 0.3 : 0.1 + rnd() * 0.25;
    // Trampled strip under the bottle span: mostly bare, sparse short dry stubble.
    const ex = Math.max(0, Math.abs(cx) - 2.3), ez = Math.max(0, -1.5 - cz, cz - 1.8);
    const worn = Math.max(0, 1 - Math.hypot(ex, ez) / 0.5);
    if (worn > 0) {
      if (rnd() < 0.85 * worn) continue;
      tall *= 1 - 0.8 * worn;
      tuft = Math.max(2, Math.round(tuft * (1 - 0.7 * worn)));
    }
    const pick = base[Math.floor(rnd() * base.length)];
    for (let k = 0; k < tuft && i < count; k++, i++) {
      p.set(cx + (rnd() - 0.5) * 0.18, 0, cz + (rnd() - 0.5) * 0.18);
      q.setFromAxisAngle(axisY, rnd() * Math.PI * 2);
      tiltAxis.set(rnd() - 0.5, 0, rnd() - 0.5).normalize();
      tilt.setFromAxisAngle(tiltAxis, rnd() * 0.5);
      q.premultiply(tilt);
      const h = tall * (0.6 + rnd() * 0.6);
      s.set(0.006 + rnd() * 0.005, h, 0.006 + rnd() * 0.006);
      s.z = h; // bend amount scales with height
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      c.copy(pick).offsetHSL((rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.1, (rnd() - 0.5) * 0.12);
      mesh.setColorAt(i, c);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  return {
    mesh,
    update(time: number) {
      uniforms.uTime.value = time;
    },
  };
}
