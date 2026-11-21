/**
 * Light objects lab: every object in the fx package on one page, for side-by-side checks against take four and for
 * the posters. Not shipped. `?kind=sphere&w=390&h=380` shows one object; `?still` freezes it at t = 0.
 */
import { createRoot } from 'react-dom/client';
import { LitFx, type FxKind, type FxKinds } from '../src/lit/fx/index.js';
import { FX_PRESETS } from '../src/lit/fx/posters/presets.js';

const BLUE = { color: '#3f7dff', hot: '#c7dbff' };
const q = new URLSearchParams(location.search);
const still = q.has('still');
if (still) document.documentElement.setAttribute('data-fx-still', '');
if (q.has('nb')) document.documentElement.dataset.fxBloom = 'off';
if (q.get('present') === 'copy') document.documentElement.dataset.fxPresent = 'copy';
const tier = q.get('tier');
if (tier) document.documentElement.dataset.fxTier = tier;

const all: Array<{ [K in FxKind]: { kind: K; w: number; h: number; options: FxKinds[K] } }[FxKind]> = [
  {
    kind: 'sphere',
    w: 390,
    h: 380,
    options: { ...BLUE, mood: 0.55, dist: 5.9, y: 0.02, shares: [0.409, 0.34, 0.15, 0.101], c1: BLUE.hot },
  },
  { kind: 'logo', w: 360, h: 300, options: { ...BLUE } },
  { kind: 'coin', w: 360, h: 300, options: { color: BLUE.color } },
  { kind: 'field', w: 720, h: 450, options: { color: BLUE.color } },
];
const only = q.get('kind');
const presetName = q.get('preset') as keyof typeof FX_PRESETS | null;
const preset = presetName ? FX_PRESETS[presetName] : null;
// posters.mjs records what each poster was rendered from (posters/<name>.json, checked by presets.test.ts)
(window as unknown as { __fxPreset: (name: string) => unknown }).__fxPreset = (name) => FX_PRESETS[name as keyof typeof FX_PRESETS] ?? null;
const shown = (preset ? [{ kind: preset.kind, w: preset.width, h: preset.height, options: preset.options }] : all)
  .filter((o) => !only || o.kind === only)
  .map((o) => ({ ...o, w: Number(q.get('w') ?? o.w), h: Number(q.get('h') ?? o.h) }));

function App() {
  return (
    <div className="grid">
      {shown.map((o) => (
        <figure key={o.kind}>
          <div className="box" id={`fx-${o.kind}`} style={{ width: o.w, height: o.h }}>
            {/* each kind's options type is checked in `all` above */}
            <LitFx kind={o.kind} options={o.options as never} still={still} />
          </div>
          <figcaption>{o.kind}</figcaption>
        </figure>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
