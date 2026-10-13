import { useEffect, useRef, useState } from 'react';
import '../backdrop.css';

/**
 * Living backdrop for the invitation journey.
 *  - 'ribbons': one full-screen WebGL fragment shader (diagonal graphite light bands, lime only in the cores).
 *  - 'photo'  : the graphite-fins photo with a slow drift and one travelling light sweep (CSS only).
 * Falls back to 'photo' (still) when WebGL is unavailable, the shader fails, or the context is lost.
 * Entrance (first visit only): nothing shows until the first frame / decode, then it resolves from black in 1.4s.
 * Dim (question steps): settles to ~35% brightness over 800ms, then the ribbons stop drawing (one still frame).
 */
export type LivingBackdropProps = {
  variant: 'ribbons' | 'photo';
  photoSrc: string;
  dim?: boolean;
  entrance?: boolean;
  onReady?: () => void;
};

const VERT = 'attribute vec2 a;varying vec2 v;void main(){v=a*.5+.5;gl_Position=vec4(a,0.,1.);}';

// GLSL ES 1.00 runs on both WebGL1 and WebGL2 contexts.
const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float uT;
uniform float uG;
uniform float uAsp;
uniform float uH;     // css px height
uniform float uPs;    // band-space units per css px
uniform vec2 uExt;
varying vec2 v;
const vec2 N = vec2(.788, .616);   // across the bands
const vec2 D = vec2(.616, -.788);  // along the bands: falls top-left to bottom-right, like the photo's fins
const float TAU = 6.2831853;

float hash(vec2 p){
  vec3 q = fract(vec3(p.xyx) * .1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// One emissive band. kind 0 = graphite steel, 1 = lime. front: defined edge + specular rim line.
// Brightness pulses travel along the band axis at speed px/s; wavelength lam px; ph staggers bands.
vec3 band(float s, float ua, float c, float w, float soft, float amp, float kind, float rim,
          float speed, float lam, float ph, float per){
  float d = s - c + .012 * sin(uT * TAU / (per * 1.3) + ph);   // slow lateral drift
  float ad = abs(d);
  float edge = 1. - smoothstep(w - soft, w + soft, ad);
  float cr = clamp(1. - ad / (w + soft), 0., 1.);
  float a1 = (ua - speed * uT) * TAU / lam + ph;
  float a2 = (ua - speed * .62 * uT) * TAU / (lam * 1.9) + ph * 2.3;
  float pulse = .62 * sin(a1) + .38 * sin(a2);
  float along = mix(.16, 1., smoothstep(-.4, .8, pulse));
  float breathe = .9 + .1 * sin(uT * TAU / per + ph * 1.7);
  float e = edge * (.3 + .7 * pow(cr, 1.25)) * along * breathe * amp;

  vec3 eC, mC, hC, rC;
  if (kind > .5) {
    eC = vec3(.16, .30, .04); mC = vec3(.784, .965, .29); hC = vec3(.90, 1., .66); rC = vec3(.93, 1., .72);
  } else {
    eC = vec3(.035, .055, .065); mC = vec3(.215, .285, .315); hC = vec3(.52, .62, .65); rC = vec3(.72, .83, .87);
  }
  vec3 col = mix(eC, mC, smoothstep(.1, .5, e));
  col = mix(col, hC, smoothstep(.55, .98, e));
  col *= smoothstep(0., .1, e);

  // Thin specular rim on the lit (lower-left) edge, a quieter one on the far edge. 1-2 css px.
  float rl = (1. - smoothstep(0., 1.7 * uPs, abs(ad - w))) * rim;
  float lit = d < 0. ? 1. : .4;
  col += rC * rl * lit * mix(.3, 1., along) * (.55 + .45 * amp);

  // Soft haze around the band so light seems to spill into the dark.
  float hz = exp(-pow(ad / (w * 3.2 + soft * 1.5), 2.));
  col += mC * hz * amp * mix(.2, 1., along) * (kind > .5 ? .085 : .05);
  return col;
}

void main(){
  vec2 q = v - .5;
  vec2 p = q * vec2(uAsp, 1.);
  float s = dot(p, N) / uExt.x;      // -1..1 across the bands
  float ua = dot(p, D) * uH;         // css px along the bands

  // Light sits upper-right (s > 0) and lower-left (s < 0); the diagonal through the centre stays calm.
  float W = mix(.25, 1., smoothstep(.04, .6, abs(s)));
  // Calm zone behind the headline: roughly the middle 55% x 45%.
  vec2 z = abs(q) / vec2(.30, .25);
  float zone = 1. - smoothstep(.55, 1.25, pow(pow(z.x, 3.) + pow(z.y, 3.), .3333));
  W *= 1. - .85 * zone;

  vec3 L = vec3(0.);
  //          s      w     soft   amp   kind rim  px/s  lambda  phase per
  L += band(s, ua, -.92, .026, .008, .80, 0., 1., 42., 760., 0.6, 29.);   // thin steel, front
  L += band(s, ua, -.68, .042, .012, .42, 1., 1., 36., 640., 2.4, 33.);   // lime echo, front, weaker
  L += band(s, ua, -.38, .075, .095, .55, 0., 0., 52., 900., 4.1, 37.);   // steel, back, out of focus
  L += band(s, ua,  .40, .042, .014, .85, 0., 1., 31., 560., 1.5, 31.);   // steel, front
  L += band(s, ua,  .67, .058, .012, 1.0, 1., 1., 48., 700., 3.3, 27.);   // lime hero, front
  L += band(s, ua,  .90, .055, .085, .60, 0., 0., 58., 820., 5.2, 35.);   // steel, back, soft
  L *= W;

  vec3 ground = vec3(.016, .020, .024);
  float vg = smoothstep(1.15, .25, length(q * vec2(1.25, 1.1) * 1.55));
  vec3 col = ground + L;
  col *= mix(.6, 1., vg);

  // Fine film grain + triangular dither, monochrome, a little stronger where there is light.
  float n1 = hash(gl_FragCoord.xy + uG * vec2(37., 17.));
  float n2 = hash(gl_FragCoord.yx * 1.31 + uG * vec2(11., 53.));
  float lum = dot(col, vec3(.3, .5, .2));
  col += (n1 + n2 - 1.) * (1.1 / 255. + .010 * lum);
  gl_FragColor = vec4(col, 1.);
}
`;

type Gl = WebGLRenderingContext | WebGL2RenderingContext;

const STILL_T = 9; // seconds into the loop used for the reduced-motion still frame
const DIM_SETTLE_MS = 900;

function readReduced(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function LivingBackdrop({ variant, photoSrc, dim = false, entrance = false, onReady }: LivingBackdropProps) {
  const [mode, setMode] = useState<'ribbons' | 'photo'>(variant);
  const [ready, setReady] = useState(false);
  const [entering, setEntering] = useState(false);
  const [reduced, setReduced] = useState(readReduced);
  const entranceFirst = useRef(entrance); // the entrance is a first-mount decision, never replayed
  const playedRef = useRef(false);
  const readyCb = useRef(onReady);
  const readyFired = useRef(false);
  const dimRef = useRef(dim);
  const hostRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const wakeRef = useRef<(() => void) | null>(null);
  readyCb.current = onReady;
  dimRef.current = dim;

  useEffect(() => {
    setMode(variant);
    setReady(false);
  }, [variant]);

  // Live reduced-motion changes.
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return;
    }
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Dim changes wake the ribbons loop (it parks on a still frame once dim has settled).
  useEffect(() => {
    wakeRef.current?.();
  }, [dim]);

  const markReady = () => {
    setReady(true);
    if (!playedRef.current) {
      playedRef.current = true;
      setEntering(entranceFirst.current && !readReducedNow());
    }
    if (!readyFired.current) {
      readyFired.current = true;
      readyCb.current?.();
    }
  };
  const readReducedNow = readReduced;

  // Photo variant: decode before showing.
  useEffect(() => {
    if (mode !== 'photo') return;
    let alive = true;
    const img = imgRef.current;
    const done = () => alive && markReady();
    if (!img) return;
    if (typeof img.decode === 'function') img.decode().then(done, done);
    else if (img.complete) done();
    else {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, photoSrc]);

  // Ribbons variant: WebGL.
  useEffect(() => {
    if (mode !== 'ribbons') return;
    const host = hostRef.current;
    if (!host) return;
    let dead = false;
    const fail = () => {
      if (dead) return;
      dead = true;
      setReady(false);
      setMode('photo');
    };

    const canvas = document.createElement('canvas');
    canvas.className = 'lb__canvas';
    let gl: Gl | null = null;
    try {
      const opts = { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' as const };
      gl = (canvas.getContext('webgl2', opts) as Gl | null) || (canvas.getContext('webgl', opts) as Gl | null);
    } catch {
      gl = null;
    }
    if (!gl) {
      fail();
      return;
    }
    const g = gl;
    const stage = host.querySelector('.lb__stage');
    if (!stage) return;
    stage.insertBefore(canvas, stage.firstChild);

    // Any failure while setting up the shader (createShader returning null on a lost or exhausted
    // context, a compile error, a throw) must end in the still photo, never in a broken page.
    let vs: WebGLShader, fs: WebGLShader, prog: WebGLProgram, parallel: any;
    try {
      const v = g.createShader(g.VERTEX_SHADER);
      const f = g.createShader(g.FRAGMENT_SHADER);
      const p = g.createProgram();
      if (!v || !f || !p) throw new Error('webgl-alloc');
      vs = v;
      fs = f;
      prog = p;
      g.shaderSource(vs, VERT);
      g.shaderSource(fs, FRAG);
      g.compileShader(vs);
      g.compileShader(fs);
      g.attachShader(prog, vs);
      g.attachShader(prog, fs);
      g.bindAttribLocation(prog, 0, 'a');
      g.linkProgram(prog);
      parallel = g.getExtension('KHR_parallel_shader_compile');
    } catch {
      canvas.remove();
      fail();
      return;
    }

    const cleanups: Array<() => void> = [];
    let raf = 0;
    cleanups.push(() => cancelAnimationFrame(raf));

    const onLost = (e: Event) => {
      e.preventDefault();
      fail();
    };
    canvas.addEventListener('webglcontextlost', onLost);

    const startInner = () => {
      if (dead) return;
      if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
        fail();
        return;
      }
      g.useProgram(prog);
      const buf = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, buf);
      g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
      g.enableVertexAttribArray(0);
      g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
      const uT = g.getUniformLocation(prog, 'uT');
      const uG = g.getUniformLocation(prog, 'uG');
      const uAsp = g.getUniformLocation(prog, 'uAsp');
      const uExt = g.getUniformLocation(prog, 'uExt');
      const uH = g.getUniformLocation(prog, 'uH');
      const uPs = g.getUniformLocation(prog, 'uPs');

      const phone = () => window.innerWidth < 700 || (navigator.hardwareConcurrency || 8) <= 4;
      let scale = 1; // adaptive render scale if the device cannot keep up
      let scene = 0;
      let speed = 1;
      let frame = 0;
      let lastDraw = 0;
      let dimSince = 0;
      let parked = false;
      let hidden = document.hidden;
      let isReduced = readReduced();
      let slow = 0;
      let slowN = 0;

      const size = () => {
        const w = Math.max(1, host.clientWidth);
        const h = Math.max(1, host.clientHeight);
        const dpr = Math.min(window.devicePixelRatio || 1, w < 700 ? 1 : 1.5) * scale;
        const cw = Math.max(2, Math.round(w * dpr));
        const ch = Math.max(2, Math.round(h * dpr));
        if (canvas.width !== cw || canvas.height !== ch) {
          canvas.width = cw;
          canvas.height = ch;
          g.viewport(0, 0, cw, ch);
        }
        const asp = w / h;
        g.uniform1f(uAsp, asp);
        const ex = 0.5 * (asp * 0.788 + 0.616);
        g.uniform2f(uExt, ex, 0.5 * (asp * 0.616 + 0.788));
        g.uniform1f(uH, h);
        g.uniform1f(uPs, 1 / (h * ex));
      };
      const draw = (t: number) => {
        g.uniform1f(uT, t);
        g.uniform1f(uG, frame % 997);
        g.drawArrays(g.TRIANGLES, 0, 3);
      };

      const cancelLoop = () => {
        cancelAnimationFrame(raf);
        raf = 0;
      };
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        const interval = phone() ? 33.3 : 16.6;
        const gap = now - lastDraw;
        if (gap < interval - 3) return;
        const dt = Math.min(gap / 1000, 0.1);
        // Adaptive quality: if the first 40 frames average far over budget, render smaller (cheap upscale).
        if (frame > 8 && frame <= 48 && lastDraw) {
          slow += gap;
          slowN++;
          if (slowN === 40) {
            if (slow / slowN > interval * 1.7 && scale > 0.5) {
              scale = scale > 0.75 ? 0.75 : 0.5;
              size();
            }
          }
        }
        lastDraw = now;
        const target = dimRef.current ? 0.5 : 1;
        speed += (target - speed) * Math.min(1, dt * 3);
        scene += dt * speed;
        frame++;
        draw(scene);
        if (dimRef.current && now - dimSince > DIM_SETTLE_MS) {
          // Settled in dim: park on this frame. Zero cost until the dim is lifted.
          parked = true;
          cancelLoop();
        }
      };
      const run = () => {
        if (dead || raf) return;
        lastDraw = performance.now() - 100; // first frame after a pause draws at once, with a small dt
        raf = requestAnimationFrame(tick);
      };
      const evaluate = () => {
        if (isReduced) {
          cancelLoop();
          size();
          draw(STILL_T);
        } else if (hidden || (parked && dimRef.current)) {
          cancelLoop();
        } else {
          run();
        }
      };
      wakeRef.current = () => {
        // Entering dim starts the settle timer; leaving it un-parks.
        if (dimRef.current) {
          parked = false;
          dimSince = performance.now();
        } else parked = false;
        evaluate();
      };

      const onVis = () => {
        hidden = document.hidden;
        evaluate();
      };
      document.addEventListener('visibilitychange', onVis);
      cleanups.push(() => document.removeEventListener('visibilitychange', onVis));

      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      const onMq = () => {
        isReduced = mq.matches;
        evaluate();
      };
      mq.addEventListener('change', onMq);
      cleanups.push(() => mq.removeEventListener('change', onMq));

      let resizeRaf = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          size();
          if (!raf) draw(isReduced ? STILL_T : scene); // parked or still: repaint, resize clears the buffer
        });
      });
      ro.observe(host);
      cleanups.push(() => {
        ro.disconnect();
        cancelAnimationFrame(resizeRaf);
      });

      // First frame, then tell the page.
      size();
      if (dimRef.current) {
        speed = 0.5;
        dimSince = performance.now() - DIM_SETTLE_MS; // arriving straight onto a question: no settle animation to wait for
      }
      scene = isReduced ? STILL_T : 0.5;
      frame = 0;
      draw(scene);
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (dead) return;
        markReady();
        evaluate();
      });
    };

    const start = () => {
      try {
        startInner();
      } catch {
        cleanups.forEach((fn) => fn());
        fail();
      }
    };

    // Do not block on compile: poll the parallel-compile flag when the browser has it.
    const pollInner = () => {
      if (dead) return;
      if (parallel && !g.getProgramParameter(prog, parallel.COMPLETION_STATUS_KHR)) {
        raf = requestAnimationFrame(poll);
        return;
      }
      if (!g.getShaderParameter(fs, g.COMPILE_STATUS) || !g.getProgramParameter(prog, g.LINK_STATUS)) {
        fail();
        return;
      }
      start();
    };
    const poll = () => {
      try {
        pollInner();
      } catch {
        fail();
      }
    };
    poll();

    return () => {
      dead = true;
      wakeRef.current = null;
      canvas.removeEventListener('webglcontextlost', onLost);
      cleanups.forEach((fn) => fn());
      canvas.remove();
      try {
        g.getExtension('WEBGL_lose_context')?.loseContext();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const cls = ['lb', dim ? 'is-dim' : '', reduced ? 'is-reduced' : '', entering ? 'is-entering-host' : ''].filter(Boolean).join(' ');
  return (
    <div ref={hostRef} className={cls} aria-hidden="true" data-backdrop={mode} data-ready={ready ? '1' : '0'}>
      <div className={'lb__stage' + (ready ? ' is-ready' : '') + (ready && entering ? ' is-entering' : '')}>
        {mode === 'photo' ? (
          <>
            <div className="lb__photo">
              <img ref={imgRef} src={photoSrc} alt="" width={1672} height={941} decoding="async" draggable={false} />
            </div>
            <div className="lb__sweep">
              <i />
            </div>
            <div className="lb__scrim" />
          </>
        ) : null}
        <div className="lb__dim" />
      </div>
      <div className={'lb__veil' + (ready && entering ? ' is-entering' : '')} />
    </div>
  );
}

export default LivingBackdrop;
