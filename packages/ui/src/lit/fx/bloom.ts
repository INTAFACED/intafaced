/**
 * Take four's bloom, exactly: three.js r128's UnrealBloomPass (MIT, three.js authors) ported to r186's Pass API.
 * r186's own UnrealBloomPass draws a different light (blur sigma a third as wide, three times the strength,
 * premultiplied blending, Rec. 709 luma), so the approved look would change if we used it. Measured on 26 Oct 2026:
 * with bloom off the r186 port and take four differ by 0.29/255 per pixel on the sphere; with r186's bloom, 2.31.
 */
import {
  AdditiveBlending,
  Color,
  LinearFilter,
  MeshBasicMaterial,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

const QUAD_VERTEX = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}';

const HIGH_PASS = `uniform sampler2D tDiffuse;uniform vec3 defaultColor;uniform float defaultOpacity;uniform float luminosityThreshold;uniform float smoothWidth;varying vec2 vUv;
void main(){vec4 texel=texture2D(tDiffuse,vUv);float v=dot(texel.xyz,vec3(0.299,0.587,0.114));vec4 outputColor=vec4(defaultColor.rgb,defaultOpacity);
float alpha=smoothstep(luminosityThreshold,luminosityThreshold+smoothWidth,v);gl_FragColor=mix(outputColor,texel,alpha);}`;

const BLUR = `varying vec2 vUv;uniform sampler2D colorTexture;uniform vec2 invSize;uniform vec2 direction;
float gaussianPdf(in float x,in float sigma){return 0.39894*exp(-0.5*x*x/(sigma*sigma))/sigma;}
void main(){float fSigma=float(SIGMA);float weightSum=gaussianPdf(0.0,fSigma);vec3 diffuseSum=texture2D(colorTexture,vUv).rgb*weightSum;
for(int i=1;i<KERNEL_RADIUS;i++){float x=float(i);float w=gaussianPdf(x,fSigma);vec2 uvOffset=direction*invSize*x;
vec3 sample1=texture2D(colorTexture,vUv+uvOffset).rgb;vec3 sample2=texture2D(colorTexture,vUv-uvOffset).rgb;diffuseSum+=(sample1+sample2)*w;weightSum+=2.0*w;}
gl_FragColor=vec4(diffuseSum/weightSum,1.0);}`;

const COMPOSITE = `varying vec2 vUv;uniform sampler2D blurTexture1;uniform sampler2D blurTexture2;uniform sampler2D blurTexture3;uniform sampler2D blurTexture4;uniform sampler2D blurTexture5;
uniform float bloomStrength;uniform float bloomRadius;uniform float bloomFactors[NUM_MIPS];uniform vec3 bloomTintColors[NUM_MIPS];
float lerpBloomFactor(const in float factor){float mirrorFactor=1.2-factor;return mix(factor,mirrorFactor,bloomRadius);}
void main(){gl_FragColor=bloomStrength*(lerpBloomFactor(bloomFactors[0])*vec4(bloomTintColors[0],1.0)*texture2D(blurTexture1,vUv)+
lerpBloomFactor(bloomFactors[1])*vec4(bloomTintColors[1],1.0)*texture2D(blurTexture2,vUv)+lerpBloomFactor(bloomFactors[2])*vec4(bloomTintColors[2],1.0)*texture2D(blurTexture3,vUv)+
lerpBloomFactor(bloomFactors[3])*vec4(bloomTintColors[3],1.0)*texture2D(blurTexture4,vUv)+lerpBloomFactor(bloomFactors[4])*vec4(bloomTintColors[4],1.0)*texture2D(blurTexture5,vUv));}`;

const COPY = 'uniform float opacity;uniform sampler2D tDiffuse;varying vec2 vUv;void main(){gl_FragColor=opacity*texture2D(tDiffuse,vUv);}';

const N_MIPS = 5;
const KERNELS = [3, 5, 7, 9, 11];
const X = new Vector2(1, 0);
const Y = new Vector2(0, 1);

function target(w: number, h: number): WebGLRenderTarget {
  const t = new WebGLRenderTarget(w, h, { minFilter: LinearFilter, magFilter: LinearFilter, type: UnsignedByteType });
  t.texture.generateMipmaps = false;
  return t;
}

export class LegacyBloomPass extends Pass {
  strength: number;
  radius: number;
  threshold: number;
  private readonly bright: WebGLRenderTarget;
  private readonly horizontal: WebGLRenderTarget[] = [];
  private readonly vertical: WebGLRenderTarget[] = [];
  private readonly highPass: ShaderMaterial;
  private readonly blurs: ShaderMaterial[] = [];
  private readonly composite: ShaderMaterial;
  private readonly copy: ShaderMaterial;
  private readonly basic = new MeshBasicMaterial();
  private readonly quad = new FullScreenQuad();
  private readonly oldClear = new Color();

  constructor(resolution: Vector2, strength: number, radius: number, threshold: number) {
    super();
    this.strength = strength;
    this.radius = radius;
    this.threshold = threshold;
    this.needsSwap = false;
    let w = Math.round(resolution.x / 2);
    let h = Math.round(resolution.y / 2);
    this.bright = target(w, h);
    for (let i = 0; i < N_MIPS; i++) {
      this.horizontal.push(target(w, h));
      this.vertical.push(target(w, h));
      this.blurs.push(
        new ShaderMaterial({
          defines: { KERNEL_RADIUS: KERNELS[i], SIGMA: KERNELS[i] },
          uniforms: { colorTexture: { value: null }, invSize: { value: new Vector2(1 / w, 1 / h) }, direction: { value: X } },
          vertexShader: QUAD_VERTEX,
          fragmentShader: BLUR,
        }),
      );
      w = Math.round(w / 2);
      h = Math.round(h / 2);
    }
    this.highPass = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        luminosityThreshold: { value: threshold },
        smoothWidth: { value: 0.01 },
        defaultColor: { value: new Color(0x000000) },
        defaultOpacity: { value: 0 },
      },
      vertexShader: QUAD_VERTEX,
      fragmentShader: HIGH_PASS,
    });
    this.composite = new ShaderMaterial({
      defines: { NUM_MIPS: N_MIPS },
      uniforms: {
        blurTexture1: { value: this.vertical[0]!.texture },
        blurTexture2: { value: this.vertical[1]!.texture },
        blurTexture3: { value: this.vertical[2]!.texture },
        blurTexture4: { value: this.vertical[3]!.texture },
        blurTexture5: { value: this.vertical[4]!.texture },
        bloomStrength: { value: strength },
        bloomRadius: { value: radius },
        bloomFactors: { value: [1.0, 0.8, 0.6, 0.4, 0.2] },
        bloomTintColors: { value: Array.from({ length: N_MIPS }, () => new Vector3(1, 1, 1)) },
      },
      vertexShader: QUAD_VERTEX,
      fragmentShader: COMPOSITE,
    });
    this.copy = new ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, opacity: { value: 1 } },
      vertexShader: QUAD_VERTEX,
      fragmentShader: COPY,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
  }

  /** Every material the pass draws with, so the engine can compile them before the first frame. */
  materials(): ShaderMaterial[] {
    return [this.highPass, ...this.blurs, this.composite, this.copy];
  }

  override setSize(width: number, height: number): void {
    let w = Math.round(width / 2);
    let h = Math.round(height / 2);
    this.bright.setSize(w, h);
    for (let i = 0; i < N_MIPS; i++) {
      this.horizontal[i]!.setSize(w, h);
      this.vertical[i]!.setSize(w, h);
      (this.blurs[i]!.uniforms.invSize!.value as Vector2).set(1 / w, 1 / h);
      w = Math.round(w / 2);
      h = Math.round(h / 2);
    }
  }

  override render(renderer: WebGLRenderer, _write: WebGLRenderTarget, read: WebGLRenderTarget): void {
    renderer.getClearColor(this.oldClear);
    const oldAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);
    if (this.renderToScreen) {
      this.quad.material = this.basic;
      this.basic.map = read.texture;
      renderer.setRenderTarget(null);
      renderer.clear();
      this.quad.render(renderer);
    }
    this.highPass.uniforms.tDiffuse!.value = read.texture;
    this.highPass.uniforms.luminosityThreshold!.value = this.threshold;
    this.quad.material = this.highPass;
    renderer.setRenderTarget(this.bright);
    renderer.clear();
    this.quad.render(renderer);
    let input = this.bright;
    for (let i = 0; i < N_MIPS; i++) {
      const blur = this.blurs[i]!;
      this.quad.material = blur;
      blur.uniforms.colorTexture!.value = input.texture;
      blur.uniforms.direction!.value = X;
      renderer.setRenderTarget(this.horizontal[i]!);
      renderer.clear();
      this.quad.render(renderer);
      blur.uniforms.colorTexture!.value = this.horizontal[i]!.texture;
      blur.uniforms.direction!.value = Y;
      renderer.setRenderTarget(this.vertical[i]!);
      renderer.clear();
      this.quad.render(renderer);
      input = this.vertical[i]!;
    }
    this.quad.material = this.composite;
    this.composite.uniforms.bloomStrength!.value = this.strength;
    this.composite.uniforms.bloomRadius!.value = this.radius;
    renderer.setRenderTarget(this.horizontal[0]!);
    renderer.clear();
    this.quad.render(renderer);
    this.quad.material = this.copy;
    this.copy.uniforms.tDiffuse!.value = this.horizontal[0]!.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : read);
    this.quad.render(renderer);
    renderer.setClearColor(this.oldClear, oldAlpha);
    renderer.autoClear = oldAutoClear;
  }

  override dispose(): void {
    for (const t of [this.bright, ...this.horizontal, ...this.vertical]) t.dispose();
    for (const m of [this.highPass, ...this.blurs, this.composite, this.copy, this.basic]) m.dispose();
    this.quad.dispose();
  }
}
