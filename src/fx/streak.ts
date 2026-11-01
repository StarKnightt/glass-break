import { AdditiveBlending, Color, DoubleSide, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';

/**
 * Soft additive streak between `a` (tail) and `b` (head), billboarded around its own axis.
 * Width never drops below ~`minPx` screen pixels (energy-conserving), so thin streaks don't alias.
 */
export function createStreak(color: Color, width: number, minPx = 1.6) {
  const geo = new PlaneGeometry(1, 1, 12, 1).translate(0.5, 0, 0);
  const mat = new ShaderMaterial({
    uniforms: {
      uA: { value: new Vector3() },
      uB: { value: new Vector3() },
      uWidth: { value: width },
      uTaper: { value: 0.35 },
      uPx: { value: 0.001 },
      uMinPx: { value: minPx },
      uColor: { value: color.clone() },
      uAlpha: { value: 0 },
      uHead: { value: 1.5 },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uA, uB; uniform float uWidth, uTaper, uPx, uMinPx;
      varying vec2 vUv; varying float vK;
      void main() {
        vec3 p = mix(uA, uB, position.x);
        vec3 t = uB - uA;
        vec3 v = normalize(cameraPosition - p);
        vec3 s = cross(t, v);
        float sl = length(s);
        s = sl > 1e-9 ? s / sl : vec3(0.0, 1.0, 0.0);
        float w = uWidth * mix(uTaper, 1.0, position.x);
        float minW = distance(cameraPosition, p) * uPx * uMinPx;
        float ww = max(w, minW);
        vK = sqrt(w / ww);
        p += s * position.y * ww;
        vUv = vec2(position.x, position.y * 2.0);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uAlpha, uHead;
      varying vec2 vUv; varying float vK;
      void main() {
        float across = exp(-vUv.y * vUv.y * 4.5);
        float along = pow(vUv.x, uHead) * smoothstep(1.0, 0.94, vUv.x);
        gl_FragColor = vec4(uColor * across * along * uAlpha * vK, 1.0);
      }`,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    fog: false,
  });
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.visible = false;
  const u = mat.uniforms;
  return {
    mesh,
    set(a: Vector3, b: Vector3, alpha: number, camFovDeg: number, screenH: number) {
      u.uA.value.copy(a);
      u.uB.value.copy(b);
      u.uAlpha.value = alpha;
      u.uPx.value = (2 * Math.tan((camFovDeg * Math.PI) / 360)) / Math.max(1, screenH);
      mesh.visible = alpha > 1e-4 && a.distanceToSquared(b) > 1e-10;
    },
    uniforms: u,
  };
}

export type Streak = ReturnType<typeof createStreak>;
