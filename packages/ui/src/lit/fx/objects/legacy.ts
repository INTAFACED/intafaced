import { ShaderChunk, type Material } from 'three';

/**
 * Makes a lit r186 material draw as take four's r128 one did, so the port keeps the look Nino approved:
 * - r128's legacy point-light falloff, `(1 - d / distance) ^ decay`, instead of r186's inverse-square window;
 * - ACES tone mapping inside the material at `exposure`, wherever it draws: r128 tone-mapped into the composer's
 *   buffer too, where r186 tone-maps only on the screen (sRGB output still applies only on the screen, as in r128);
 * light intensities are multiplied by PI where the lights are made (r128 legacy lights were PI times brighter).
 */
const LEGACY_ATTENUATION = `float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {
	if ( cutoffDistance > 0.0 && decayExponent > 0.0 ) return pow( saturate( - lightDistance / cutoffDistance + 1.0 ), decayExponent );
	return 1.0;
}`;

const ACES = `vec3 legacyRRTAndODTFit( vec3 v ) {
	vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
	vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}
vec3 legacyACES( vec3 color, float exposure ) {
	const mat3 ACESInputMat = mat3( vec3( 0.59719, 0.07600, 0.02840 ), vec3( 0.35458, 0.90834, 0.13383 ), vec3( 0.04823, 0.01566, 0.83777 ) );
	const mat3 ACESOutputMat = mat3( vec3( 1.60475, -0.10208, -0.00327 ), vec3( -0.53108, 1.10813, -0.07276 ), vec3( -0.07367, -0.00605, 1.07602 ) );
	color *= exposure / 0.6;
	color = ACESInputMat * color;
	color = legacyRRTAndODTFit( color );
	color = ACESOutputMat * color;
	return clamp( color, 0.0, 1.0 );
}`;

function legacyLightsChunk(): string {
  const chunk = ShaderChunk.lights_pars_begin;
  const start = chunk.indexOf('float getDistanceAttenuation(');
  const end = chunk.indexOf('}', chunk.indexOf('return distanceFalloff;', start)) + 1;
  if (start < 0 || end <= start) throw new Error('three.js lights chunk changed: re-check the legacy falloff patch');
  return chunk.slice(0, start) + LEGACY_ATTENUATION + chunk.slice(end);
}

export function legacyLit<M extends Material>(material: M, exposure: number): M {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLegacyExposure = { value: exposure };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_pars_begin>', legacyLightsChunk())
      .replace('void main() {', `uniform float uLegacyExposure;\n${ACES}\nvoid main() {`)
      .replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb = legacyACES( gl_FragColor.rgb, uLegacyExposure );');
  };
  material.customProgramCacheKey = () => `legacy-lit-${exposure}`;
  return material;
}
