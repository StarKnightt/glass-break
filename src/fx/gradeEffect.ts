import { Effect } from 'postprocessing';
import { Uniform, Vector3 } from 'three';

const frag = /* glsl */ `
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform float uSat;
uniform float uContrast;
uniform float uToe;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = clamp(inputColor.rgb, 0.0, 1.0);
  // toe: pull the darks down toward black
  c = max(c - uToe, 0.0) / (1.0 - uToe);
  // filmic S-curve around mid grey (in display space)
  vec3 g = pow(c, vec3(1.0 / 2.2));
  g = mix(g, g * g * (3.0 - 2.0 * g), uContrast);
  c = pow(g, vec3(2.2));
  // split tone: cool shadows, warm highlights
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float hl = smoothstep(0.08, 0.6, l);
  c *= mix(uShadowTint, uHighTint, hl);
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);
  outputColor = vec4(c, inputColor.a);
}`;

/** Display-referred grade after tone mapping: toe, S-curve, split-tone and saturation. */
export class GradeEffect extends Effect {
  constructor({
    shadowTint = new Vector3(0.9, 0.97, 1.08),
    highTint = new Vector3(1.06, 0.99, 0.88),
    saturation = 1.1,
    contrast = 0.45,
    toe = 0.012,
  } = {}) {
    super('GradeEffect', frag, {
      uniforms: new Map<string, Uniform>([
        ['uShadowTint', new Uniform(shadowTint)],
        ['uHighTint', new Uniform(highTint)],
        ['uSat', new Uniform(saturation)],
        ['uContrast', new Uniform(contrast)],
        ['uToe', new Uniform(toe)],
      ]),
    });
  }
}
