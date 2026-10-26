/** The computer's light field: slow, deep light behind the glass panels. Ported from take four's `FX.field`. */
import { Mesh, PerspectiveCamera, PlaneGeometry, Scene, ShaderMaterial, Vector2 } from 'three';
import type { FxFactory } from '../engine.js';
import { raw } from './shared.js';

export interface FieldOptions {
  color: string;
  /**
   * Let the light drift. Off by default: the computer's glass panels blur what is behind them, and a blur over moving
   * content re-blurs every frame (the GPU budget). Turn it on only where nothing blurred sits on top.
   */
  drift?: boolean;
}

const FRAGMENT = `uniform float uT;uniform vec3 uA,uB;uniform vec2 uR;varying vec2 vU;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fb(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p*=2.03;a*=.5;}return v;}
void main(){vec2 p=vU;p.x*=uR.x/uR.y;float t=uT*.035;
vec2 q=vec2(fb(p*1.6+t),fb(p*1.6-t+3.1));float f=fb(p*1.3+q*1.7+vec2(t*.6,-t));
float a=smoothstep(.35,.95,f)*smoothstep(1.25,.15,distance(vU,vec2(.78,.92)));
float b=smoothstep(.45,1.,fb(p*1.1-q+5.))*smoothstep(1.1,.1,distance(vU,vec2(.12,.05)));
vec3 c=uA*a*.95+uB*b*.55;c+=uA*.03;gl_FragColor=vec4(c,1.);}`;

export const field: FxFactory<FieldOptions> = (ctx, o) => {
  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.1, 100);
  const U = {
    uT: { value: 0 },
    uA: { value: raw(o.color) },
    uB: { value: raw(o.color).multiplyScalar(0.45) },
    uR: { value: new Vector2(1, 1) },
  };
  const mesh = new Mesh(
    new PlaneGeometry(2, 2),
    new ShaderMaterial({
      uniforms: U,
      vertexShader: 'varying vec2 vU;void main(){vU=uv;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader: FRAGMENT,
    }),
  );
  mesh.frustumCulled = false;
  scene.add(mesh);
  void ctx;
  return {
    scene,
    camera,
    bloom: null,
    // a wide background: half resolution, as take four drew it
    resolution: 0.5,
    exposure: 1,
    animated: o.drift === true,
    tick(t, w, h) {
      U.uT.value = t + 20;
      U.uR.value.set(w, h);
    },
    setColor(accent) {
      U.uA.value = raw(accent);
      U.uB.value = raw(accent).multiplyScalar(0.45);
    },
  };
};
