import { AdditiveBlending, Color, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';

const geo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5); // z: 0 → 1 along the shadow

/**
 * Fake transmitted light on the rail: a tinted sheet filling the bottle's shadow, with a bright
 * focused caustic band (the bottle acts as a cylindrical lens) and wavy filaments, clipped to the
 * rail top. Additive, so it reads as colored light inside the (lightened) glass shadow.
 */
export function createCaustic(tint: Color, radius: number, height: number, sunDir: Vector3, railZ: [number, number]) {
  const flat = new Vector3(-sunDir.x, 0, -sunDir.z).normalize();
  const elev = Math.asin(Math.min(0.99, Math.max(0.05, sunDir.y)));
  const len = Math.min(1.4, height / Math.tan(elev));
  const mat = new ShaderMaterial({
    uniforms: {
      uTint: { value: tint.clone() },
      uStrength: { value: 1 },
      uTime: { value: 0 },
      uRailZ: { value: railZ },
      uFill: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vW;
      void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTint; uniform float uStrength, uTime, uFill; uniform vec2 uRailZ;
      varying vec2 vUv; varying vec3 vW;
      void main(){
        float x = vUv.x * 2.0 - 1.0;   // across the shadow
        float s = 1.0 - vUv.y;          // 0 at bottle base, 1 at the neck tip of the shadow
        // shadow silhouette width: body then neck
        float w = mix(1.0, 0.36, smoothstep(0.5, 0.72, s));
        float body = smoothstep(w, w * 0.6, abs(x)) * smoothstep(0.0, 0.05, s) * smoothstep(1.0, 0.9, s);
        // lens focus: bright line pinched toward the axis, plus wavy filaments
        float focusLine = exp(-pow((abs(x) - 0.12 * w) / (0.07 * w), 2.0)) * smoothstep(0.05, 0.2, s) * smoothstep(0.62, 0.4, s);
        float core = exp(-pow(x / 0.22, 2.0) - pow((s - 0.3) / 0.12, 2.0));
        float wav = 0.5 + 0.5 * sin(x * 22.0 + sin(s * 31.0 + uTime * 0.6) * 1.6 + s * 9.0);
        wav = pow(wav, 6.0) * body * 0.9;
        float liquidBoost = 1.0 + uFill * 0.8;
        vec3 c = uTint * (body * 0.22 + wav * 0.55 + focusLine * 1.2 * liquidBoost + core * 1.6 * liquidBoost);
        float clip = smoothstep(uRailZ.x, uRailZ.x + 0.01, vW.z) * smoothstep(uRailZ.y, uRailZ.y - 0.01, vW.z);
        gl_FragColor = vec4(c * uStrength * clip, 1.0);
      }`,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new Mesh(geo, mat);
  mesh.scale.set(radius * 2.1, 1, len);
  mesh.lookAt(flat); // object +z → shadow direction
  mesh.rotation.set(0, Math.atan2(flat.x, flat.z), 0);
  mesh.position.y = 0.0015;
  mesh.renderOrder = 2;
  mesh.name = 'caustic';
  return mesh;
}
