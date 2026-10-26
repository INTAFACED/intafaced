import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { mountFx, type FxKind, type FxKinds } from './index.js';

export interface LitFxProps<K extends FxKind> {
  kind: K;
  options: FxKinds[K];
  /** Pre-rendered still of the same scene: shown first, and for good when the tier is `poster` or WebGL fails. */
  poster?: string;
  className?: string;
  style?: CSSProperties;
  /** Draw one frame and stop (screenshots). */
  still?: boolean;
}

const fill: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' };

/** Waits for the page's load event and then an idle moment, so three.js never competes with first paint. */
function afterFirstPaint(run: () => void): () => void {
  let idle = 0;
  let timer = 0;
  const later = () => {
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(run, { timeout: 1500 });
    else timer = window.setTimeout(run, 200);
  };
  if (document.readyState === 'complete') later();
  else window.addEventListener('load', later, { once: true });
  return () => {
    window.removeEventListener('load', later);
    if (idle && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
    if (timer) clearTimeout(timer);
  };
}

/** Function-valued options (callbacks) don't restart the object; every other change rebuilds it. */
function optionsKey(options: object): string {
  return JSON.stringify(options, (_key, value: unknown) => (typeof value === 'function' ? undefined : value));
}

/**
 * One light object in a positioned box. Decorative: it is hidden from assistive technology, so the screen states in
 * text what the object shows (the sphere's holdings as a list). The canvas adds its light onto what is underneath
 * (`mix-blend-mode: screen`); never put a blurred glass surface over it (README, budgets).
 */
export function LitFx<K extends FxKind>({ kind, options, poster, className, style, still }: LitFxProps<K>) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(options);
  latest.current = options;
  const [live, setLive] = useState(false);
  // why the poster stayed (tier-poster, software renderer, context-lost ...): for tests and support, never shown
  const [failed, setFailed] = useState<string | null>(null);
  const key = optionsKey(options);
  useEffect(() => {
    let dead = false;
    let stop: () => void = () => undefined;
    const callbacks = Object.fromEntries(
      Object.entries(latest.current).map(([name, value]) => [
        name,
        typeof value === 'function'
          ? (...args: unknown[]) => (latest.current as unknown as Record<string, (...a: unknown[]) => unknown>)[name]?.(...args)
          : value,
      ]),
    ) as FxKinds[K];
    const cancel = afterFirstPaint(() => {
      if (dead || !box.current || !canvas.current) return;
      void mountFx(box.current, canvas.current, kind, callbacks, {
        still,
        onReady: () => {
          if (dead) return;
          setLive(true);
          setFailed(null);
        },
        onFail: (reason) => {
          if (dead) return;
          setLive(false);
          setFailed(reason);
        },
      }).then((s) => {
        if (dead) s();
        else stop = s;
      });
    });
    return () => {
      dead = true;
      cancel();
      stop();
      setLive(false);
    };
  }, [kind, key, still]);
  return (
    <div
      ref={box}
      className={className}
      style={{ position: 'absolute', inset: 0, ...style }}
      aria-hidden="true"
      data-fx={kind}
      data-fx-live={live ? '' : undefined}
      data-fx-fail={failed ?? undefined}
    >
      {poster ? (
        // shown at the box's height and centred, as the 3D camera frames the object (presets.ts: posters are wide)
        <img
          src={poster}
          alt=""
          decoding="async"
          // the poster is usually the screen's largest paint, so it is fetched ahead of other images
          fetchPriority="high"
          style={{
            position: 'absolute',
            top: 0,
            left: '50%',
            height: '100%',
            width: 'auto',
            maxWidth: 'none',
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
            mixBlendMode: 'screen',
            opacity: live ? 0 : 1,
            // live frames can differ from the poster (a holdings split it can't know), so the hand-over fades
            transition: 'opacity 240ms ease-out',
          }}
        />
      ) : null}
      <canvas ref={canvas} style={{ ...fill, mixBlendMode: 'screen', opacity: live ? 1 : 0, transition: 'opacity 240ms ease-out' }} />
    </div>
  );
}
