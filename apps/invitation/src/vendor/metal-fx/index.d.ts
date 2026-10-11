import { CSSProperties } from 'react';
import { ForwardRefExoticComponent } from 'react';
import { HTMLAttributes } from 'react';
import { JSX as JSX_2 } from 'react/jsx-runtime';
import { ReactNode } from 'react';
import { RefAttributes } from 'react';
import { RefObject } from 'react';

export declare const BEND: BendConfig;

export declare const BEND_DEFAULTS: Readonly<BendConfig>;

/**
 * Live config for the cursor "bend" effect — a local liquid dent.
 *
 * The cursor carries a blob of displacement that rides the ring: moving
 * toward the button's centre dents the edge inward, moving away drags it
 * outward, and on release the bulge springs back. Implemented as an SVG
 * `feDisplacementMap` over the whole MetalFx root (button, ring, glow), with
 * the vector field regenerated each frame into a small canvas.
 *
 * Mutable singleton, read every frame by `useBend`.
 */
export declare interface BendConfig {
    enabled: boolean;
    /** What deforms. `ring` = the metal canvas only; button content and glow
     *  stay rigid. `all` = the whole MetalFx root. */
    applyTo: 'ring' | 'all';
    /** Global amplitude multiplier on the whole displacement field. */
    strength: number;
    /** Time for the effect to ease in after the cursor arrives, ms. Without
     *  this the directional spring lands the dent in 2–3 frames — a pop. */
    fadeInMs: number;
    /** Time for the effect to ease out after the cursor leaves, ms. */
    fadeOutMs: number;
    /** Low-pass on the field's *target* before the spring sees it, ms. A fast
     *  sweep across the ring flips press→pull and swings the direction vector
     *  within a frame; this keeps the dent from snapping to each new target. */
    smoothMs: number;
    /** How far beyond the element's edge the cursor is still felt, CSS px. */
    reach: number;
    /** Area of the directional bend (gaussian σ), CSS px. */
    blob: number;
    /** Area of the liquid push (gaussian σ), CSS px. Independent of `blob`. */
    liquidBlob: number;
    /** Displacement cap, CSS px. Also sets the filter's `scale`. */
    maxDisp: number;
    /** Displacement px produced per 100 px/s of cursor speed — a transient
     *  kick on fast moves. 0 disables. */
    gain: number;
    /** Position-based press: dent px per px the cursor sits inside the ring's
     *  edge, pushing toward the centre. Holds while the cursor stays. */
    pressGain: number;
    /** Position-based pull: bulge px per px the cursor sits outside the edge
     *  (within `reach`), dragging the ring toward the cursor — the sticky part. */
    pullGain: number;
    /** Extra inward dent (toward element centre) while pressed, px. */
    press: number;
    /** Radial push away from the contact point, px at full pressure. This is
     *  the divergent part of the field — it *stretches* material rather than
     *  sliding it, so the stroke thins under the cursor and bulges around it.
     *  Pressure is 1 with the cursor on the ring, fading to 0 at `reach`. */
    liquid: number;
    /** Distance from the ring (either side) over which liquid pressure fades
     *  to zero, px. Keep this small — a large value lets a cursor sitting
     *  inside the button push the whole ring outward, which reads as a scale. */
    liquidReach: number;
    /** Spring constant for the liquid push. Lower = slower swell. */
    liquidStiffness: number;
    /** Damping for the liquid push. Below 2·√k it overshoots on release. */
    liquidDamping: number;
    /** Spring on the displacement vector — snap back speed. */
    stiffness: number;
    /** Below 2·√(k·m) the surface wobbles after release. */
    damping: number;
    mass: number;
    /** Blob-centre tracking, as a per-frame lerp at 60 Hz (0..1); applied
     *  time-based so 120 Hz pointers don't track twice as hard. Lower = the
     *  blob lags and stretches behind the cursor — stickier. */
    follow: number;
    /** Map resolution multiplier. 1 = one texel per CSS px, 2 = device parity
     *  on a 2× display. Steps in the field are visible below device parity. */
    mapRes: number;
    /** Post-displacement blur, CSS px. `feDisplacementMap` samples the source
     *  nearest-neighbour, which shows as stepping where material is stretched;
     *  a quarter-pixel blur hides it. 0 disables. */
    smooth: number;
}

export declare function createInstance(opts: CreateInstanceOptions): MetalFxInstance;

declare interface CreateInstanceOptions {
    hostCanvas: HTMLCanvasElement;
    cssWidth: number;
    cssHeight: number;
    cornerRadius: number;
    kind: 'pill' | 'circle';
    shaderScale?: number;
    ringCssPx?: number;
    opacityMul?: number;
    glowGain?: number;
    paused?: boolean;
    scale?: number;
    onAfterFrame?: () => void;
    onComposite?: () => void;
    onFirstCopy?: () => void;
    mask?: MaskFn | null;
}

/** Live values. Read every frame; write via `setCursorLightConfig`. */
export declare const CURSOR_LIGHT: CursorLightConfig;

export declare const CURSOR_LIGHT_DEFAULTS: Readonly<CursorLightConfig>;

export declare interface CursorLightConfig {
    enabled: boolean;
    /** Distance from the ring's edge, either side, where the pointer is felt (CSS px). */
    reach: number;
    /** Envelope for the whole effect on enter/leave, ms (~95% settled). */
    fadeMs: number;
    /** Pointer sprite lit by the ring (needs `setCursorSprite`). */
    cursor: boolean;
    /** How far from the ring edge the pointer still gets lit, px. Beyond it
     *  nothing is drawn on the pointer; the last third ramps out. Independent
     *  of `reach`, which gates spill / catch-light. */
    cursorDistance: number;
    /** Specular: intensity of the mirrored ring (0..4, >1 stacks passes). */
    cursorStrength: number;
    /** Diffuse: intensity of the lit rim on the face toward the ring (0..2). */
    cursorDiffuse: number;
    /** Distance from the ring edge at which light has fallen to half, px.
     *  Inverse-square: I = 1 / (1 + (d / falloff)²). */
    cursorFalloff: number;
    /** Depth compression of the mirrored ring (0.1..1). Lower = the ring stays
     *  on the pointer's edge as it gets farther, like a convex surface. */
    cursorDepth: number;
    /** Mirror plane offset from the pointer's silhouette edge, px (+ = outside). */
    cursorEdge: number;
    /** How far the light spreads across the body from the facing edge, px.
     *  ~6 lights one side of the ~8 px wide arrow; 20+ covers all of it. */
    cursorReach: number;
    /** Blur on the mirrored ring, px. */
    cursorBlur: number;
    /** Magnification of the mirrored ring (1..5). The ring is ~2 px thick;
     *  without this it compresses into a hairline nobody can see. */
    cursorZoom: number;
    /** Glint on the page under the pointer. */
    spill: boolean;
    /** Glint radius, CSS px. */
    spillRadius: number;
    /** Peak opacity with the pointer on the ring (0..1). */
    spillStrength: number;
    /** 0 = centred on the pointer, 1 = centred on the nearest ring point. */
    spillOffset: number;
    /** How much the ring's brightness at that point modulates the glint (0..1). */
    spillLumGain: number;
    /** Saturation multiplier on the sampled tint. */
    spillSaturation: number;
    /** Strength multiplier while the pointer is inside the ring (over content). */
    spillInside: number;
    /** Extra blur on the glint element, CSS px. 0 = gradient only. */
    spillBlur: number;
    /** Ring catch-light follows the pointer. */
    catchLight: boolean;
    /** Hotspot tracking, per-60 Hz-frame lerp (0..1). Lower = lags more. */
    catchFollow: number;
    /** Opacity multiplier on the cursor-driven catch-light. */
    catchGain: number;
}

/** A raster of the platform's real pointer. `width`/`height` in CSS px,
 *  `hotX`/`hotY` the click point. `centerX`/`centerY` optionally override
 *  the body centre (default: alpha centroid). */
export declare interface CursorSprite {
    src: string;
    width: number;
    height: number;
    hotX: number;
    hotY: number;
    centerX?: number;
    centerY?: number;
}

/**
 * Vector deformation hook. Maps a point in the instance's CSS-px box (origin
 * top-left, before any overscan) to its displaced position, writing into
 * `out`. When an instance carries one, the ring mask is built from displaced
 * rounded-rect outlines instead of `roundRect`, so stretch stays anti-aliased
 * at any magnitude — unlike a pixel displacement filter.
 */
export declare type DeformFn = (x: number, y: number, out: {
    x: number;
    y: number;
}) => void;

/**
 * Extra layers drawn into the canvas while deforming — things that live on
 * CSS boxes (root background, `::after` rim, `.metal-fx-inner` hairline) and
 * therefore can't follow a vector deformation on their own.
 */
export declare interface DeformLayers {
    /** Fill colour behind the ring (the root background), or null. */
    fill?: string | null;
    /** Inset stroke drawn over the ring. `inset` is the band's inner edge from
     *  the outer outline; `width` the band thickness; CSS px. */
    rim?: {
        inset: number;
        width: number;
        color: string;
    } | null;
    /** Thin stroke at `inset` from the outer outline, under the ring. */
    hairline?: {
        inset: number;
        width: number;
        color: string;
    } | null;
}

export declare function destroyInstance(inst: MetalFxInstance): void;

export declare const FIT_CONTAIN = 1;

export declare const FIT_COVER = 2;

/** Paper's `ShaderFitOptions`. */
export declare const FIT_NONE = 0;

/** The preset the shared renderer is currently drawing with, or null before
 *  any instance has mounted. Read-only snapshot — mutate via the setters. */
export declare function getSharedPreset(): PresetMode | null;

/** Live values. Read directly by the glow engine; write via `setGlowConfig`. */
export declare const GLOW: GlowConfig;

export declare const GLOW_DEFAULTS: Readonly<GlowConfig>;

export declare const GLOW_MARKUP_KEYS: ReadonlySet<keyof GlowConfig>;

/**
 * Live-tunable glow parameters.
 *
 * Every number the halo + catch-light overlay used to hard-code lives here as
 * a mutable singleton so a tuning surface can drive it at runtime. Two classes:
 *
 *   • runtime — read every frame inside `updateGlow`. Changing one takes
 *     effect on the next frame with no DOM work.
 *   • markup — baked into the SVG (`buildSvgMarkup`) at inject time: stroke
 *     widths, blur radii, per-layer opacities, blob lengths. Changing one
 *     requires the SVG to be rebuilt, which `setGlowConfig` signals through
 *     `subscribeGlowConfig` so MetalFx can re-inject.
 *
 * `GLOW_DEFAULTS` are the values that shipped before this file existed, so
 * `resetGlowConfig()` is an exact restore.
 */
export declare interface GlowConfig {
    /** Overall halo group opacity multiplier. */
    haloOpMul: number;
    /** Catch-light group intensity multiplier (clamped to 1 after multiply). */
    extraIntensity: number;
    /** Glow opacity at a fully-lit perimeter point. */
    peakOp: number;
    /** Glow opacity at a dark perimeter point. */
    baseOp: number;
    /** Perpendicular inset of the halo from the ring, SVG units at 1×. */
    inset: number;
    /** Extra outward offset for the catch-light, SVG units at 1×. */
    extraOutward: number;
    /** Random wander amplitude along the perimeter, at the 140×40 reference. */
    wanderRange: number;
    /** Per-frame lerp toward the wander target. */
    wanderLerp: number;
    /** Per-frame lerp of opacity toward its luminance-driven target. */
    fadeRate: number;
    /** Luminance below which the glow sits at `baseOp`. */
    lumLo: number;
    /** Luminance above which the glow reaches `peakOp`. */
    lumHi: number;
    /** Minimum time at a hotspot before a brighter rival can steal it. */
    minDwellMs: number;
    /** Appear duration, ms. A relocation is a full fade-out at the old spot
     *  then a full fade-in at the new one — the glow never slides. */
    relocFadeMs: number;
    /** Disappear duration, ms. Slower than the appear so a hotspot lingers. */
    relocFadeOutMs: number;
    /** Point-mode (masked text/glyph) intensity multiplier. The mask discards
     *  most of the halo's blur, so what survives inside the strokes needs a
     *  boost to read at all. */
    pointGain: number;
    /** Half-length of the halo stroke path, at the reference pill. */
    haloHalfLen: number;
    /** Half-length of the catch-light stroke path, at the reference pill. */
    extraHalfLen: number;
    haloStrokeXl: number;
    haloStrokeLg: number;
    haloStrokeMd: number;
    haloStrokeSm: number;
    haloBlurXl: number;
    haloBlurLg: number;
    haloBlurMd: number;
    haloBlurSm: number;
    haloOpXl: number;
    haloOpLg: number;
    haloOpMd: number;
    haloOpSm: number;
    extraStrokeOuter: number;
    extraStrokeCore: number;
    extraBlurOuter: number;
    extraBlurCore: number;
    /** Radius of the radial mask that fades the catch-light's ends. */
    extraFadeR: number;
    extraOpOuter: number;
}

/** Converts `#rrggbb` (or `#rgb`) to a normalized `[r, g, b]` triple (0–1). */
export declare function hexToRgb(hex: string): [number, number, number];

/**
 * Converts `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` to a normalized
 * `[r, g, b, a]` quad (0–1). Alpha defaults to 1 when the hex omits it.
 *
 * Paper's shader takes colors as `vec4`, and for `u_colorTint` the alpha is a
 * blend *amount* (how much colour-burn to apply), not an opacity — so the
 * 8-digit form is the normal way to write a tint here, not an edge case.
 */
export declare function hexToRgba(hex: string): [number, number, number, number];

/**
 * Whether this browser can run the engine (WebGL2). Cached after the first
 * call. Consumers get this for free through `<MetalFx>`, which renders its
 * children plain when unsupported instead of throwing.
 */
export declare function isMetalFxSupported(): boolean;

declare type Listener = (markupChanged: boolean) => void;

/**
 * Custom alpha mask. Paints opaque shapes in *device* px onto a context whose
 * origin is the instance's box top-left; the engine keeps the shader only
 * where the mask painted (`destination-in`). Replaces the ring punch — use it
 * for metal-filled text or glyphs.
 */
export declare type MaskFn = (ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number) => void;

/** Tuned on the demo's "Live mode · New" card. */
export declare const METAL_BADGE_DEFAULTS: Readonly<{
    metalOpacity: 0.8;
    shaderScale: 1.6;
    /** White core under the label: solid radius (% of ellipse), ramp width, opacity, ellipse size (% of box). */
    core: Readonly<{
        r: 46;
        blur: 100;
        a: 0.94;
        size: 49;
    }>;
    gradient: 0;
    glow: 0.41;
}>;

/** Tuned on the demo's "Plan Pro" card. */
export declare const METAL_TEXT_DEFAULTS: Readonly<{
    metalOpacity: 0.62;
    shaderScale: 2.8;
    glowGain: 2.5;
    innerShadow: TextInnerShadow;
}>;

export declare function MetalBadge({ children, strength, theme, scale, reflectionTargets, metalOpacity, shaderScale, core, gradient, glow, textColor, }: {
    children?: string;
    strength?: number;
    theme?: MetalFxTheme;
    /** Size multiplier on the Figma metrics (45×25, 12.222px). */
    scale?: number;
    reflectionTargets?: ReadonlyArray<MetalFxReflectionTarget>;
    /** How much metal shows over the white fill (0..1), multiplied with `strength`. */
    metalOpacity?: number;
    shaderScale?: number;
    core?: MetalBadgeCore;
    /** Top→bottom white wash strength (0..1). */
    gradient?: number;
    /** Inner white glow strength (0..1). */
    glow?: number;
    textColor?: string;
}): JSX_2.Element;

export declare interface MetalBadgeCore {
    r: number;
    blur: number;
    a: number;
    size: number;
}

/**
 * Wraps any element with an animated metallic ring effect driven by a
 * single shared WebGL renderer. All visible MetalFx instances on the page
 * share one offscreen GL canvas; each instance composites a cropped/scaled
 * copy of it onto its own 2D canvas with a rounded hole punched through the
 * centre.
 */
export declare const MetalFx: ForwardRefExoticComponent<MetalFxProps & RefAttributes<HTMLDivElement>>;

export declare interface MetalFxInstance {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    cssWidth: number;
    cssHeight: number;
    cornerRadius: number;
    kind: 'pill' | 'circle';
    ringCssPx: number;
    shaderScale: number;
    opacityMul: number;
    /** Extra multiplier on the glow only (halo + catch-light), default 1. Lets
     *  a dim shader (low `opacityMul`) still carry a visible glow. */
    glowGain: number;
    visible: boolean;
    /** Per-instance freeze flag. When true the instance's 2D canvas keeps the
     *  last copied frame; the shared GL loop continues for any other unpaused
     *  instance. */
    paused: boolean;
    /** Set to true after the first successful copyShaderToInstance — so an
     *  instance that mounts already paused still gets one frame painted before
     *  it freezes (otherwise it would render a blank canvas). */
    everCopied: boolean;
    /** The shader frame this instance froze on when paused. While paused every
     *  composite (a bend redraw, a resize) draws from this copy, so the ring
     *  keeps its still texture while the shared loop runs on for others. */
    frozen: HTMLCanvasElement | null;
    dpr: number;
    /** Master scale multiplier for absolute-pixel internals (glow stroke
     *  widths/blurs, reflection stroke band, etc.). 1 is the baseline. Set to
     *  2 for a CSS-zoomed 2× hero so glow + reflection grow with the layout. */
    scale: number;
    onAfterFrame?: () => void;
    /** Fired after every composite, synchronously — for layers that must track
     *  the ring exactly (the glow's mask while deforming). */
    onComposite?: () => void;
    /** One-shot callback fired after the very first copyShaderToInstance.
     *  Auto-cleared by the loop so it never fires twice. */
    onFirstCopy?: () => void;
    /** See `MaskFn`. Takes precedence over the ring punch and over `deform`. */
    mask: MaskFn | null;
    /** Unmasked copy of the metal sheet for masked instances — what a mirror
     *  facing the glyphs would see (the stripes, not three thin letters).
     *  Allocated on demand when a glyph reflection target asks for it. */
    rawCanvas: HTMLCanvasElement | null;
    wantRaw: boolean;
    /** Ring-only copy while a deform is active. The bend draws the host's
     *  fill / rim / hairline into the main canvas so they bend along; a
     *  reflection that mirrored that would jump from "ring" to "filled disc"
     *  the moment the bend starts. Allocated on demand by reflection targets. */
    ringCanvas: HTMLCanvasElement | null;
    wantRing: boolean;
    /** See `DeformFn`. Null = rigid rounded-rect mask. */
    deform: DeformFn | null;
    deformLayers: DeformLayers | null;
    /** Canvas margin beyond the CSS box, CSS px, so displaced geometry that
     *  bulges outward isn't clipped. 0 unless deforming. */
    overscan: number;
    /** Pointer acting as a light source: the outline point nearest the cursor
     *  (box-local CSS px) and a 0..1 proximity weight. Set by the cursor-light
     *  tracker; the glow's hotspot faces it. Null when the pointer is away. */
    cursorLight: {
        x: number;
        y: number;
        w: number;
    } | null;
    /** Set by the glow callback when its envelope is mid-fade: the loop then
     *  ticks the glow every animation frame instead of every shader frame, so
     *  a 300 ms fade gets ~20 steps rather than 4. */
    glowFast: boolean;
}

/**
 * Bundled preset names. Each preset ships both a dark and light mode block.
 */
export declare type MetalFxPreset = 'chromatic' | 'silver' | 'gold';

/**
 * Props for the MetalFx React component.
 */
export declare interface MetalFxProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
    /**
     * The single host element to wrap with the metal effect. Must be a single
     * React node (button, anchor, div, ...). MetalFx measures this element each
     * frame via `ResizeObserver` and paints its canvas + glow on top.
     */
    children: ReactNode;
    /**
     * Variant — controls the shader sampling scale + ring width.
     * - `button` (default): pill-style ring at 1 px wide, scale 1.6
     * - `circle`: compact circle with a 2 px ring, scale 1.3
     */
    variant?: MetalFxVariant;
    /**
     * Color preset. All three presets ship both dark and light mode tunings —
     * `theme` picks the right side at runtime.
     * @default 'chromatic'
     */
    preset?: MetalFxPreset;
    /**
     * Theme mode. `'auto'` (default) resolves via
     * `matchMedia('(prefers-color-scheme: dark)')` and switches live when the
     * OS theme changes. Pass `'dark'` or `'light'` to pin a specific mode.
     * @default 'auto'
     */
    theme?: MetalFxTheme;
    /**
     * Effect strength (0..1). Multiplies the shader bitmap opacity and the glow
     * SVG alpha. The shader continues to animate at full intensity at any value;
     * only the rendered alpha onto the host is scaled. Lighter values let the
     * underlying child surface show through more strongly.
     * @default 1
     */
    strength?: number;
    /**
     * Multiplier on the glow only (halo + catch-light), on top of `strength`.
     * Use it when the shader runs at low `strength` but the glow should still
     * read — e.g. metal text. Clamped to 0..1 after multiplying.
     * @default 1
     */
    glowGain?: number;
    /**
     * Pause the shader animation. The visible canvas keeps the last painted
     * frame so the metal silhouette stays on screen.
     * @default false
     */
    paused?: boolean;
    /**
     * Optional explicit border radius (CSS px). When omitted, MetalFx reads the
     * computed border-radius of the wrapped child each resize.
     */
    borderRadius?: number;
    /**
     * When true, MetalFx normalizes the host element's outer chrome (border /
     * outline / box-shadow) so user-provided component styles don't clash with
     * the metal ring. Inner fills, typography, and content remain untouched.
     * @default true
     */
    normalizeHostStyles?: boolean;
    /**
     * Neighbour elements that should receive a soft proximity reflection of the
     * metal effect. Reflections only render when the resolved theme is `dark` —
     * pass-through in light mode (no DOM scan, no per-frame work).
     *
     * Pass refs to the sibling DOM elements you want to receive the reflection
     * (chips next to a send button, search field next to an Upgrade pill, ...).
     *
     * A target that *contains* the wrapped element (its parent card, say)
     * receives the reflection on both the nearest vertical and horizontal
     * inner edges. Pair with `{ ref, strength }` to keep that subtle.
     */
    reflectionTargets?: ReadonlyArray<MetalFxReflectionTarget>;
    /**
     * Disable the wandering halo overlay. The shader ring still renders.
     * @default false
     */
    disableGlow?: boolean;
    /**
     * Light rim along the top inside edge of the ring — an inner shadow from
     * above, like the one on metal text. `true` uses the design defaults
     * (white 90 %, offset 1 px, blur 0.5 px); pass an object to tune.
     * @default undefined (off)
     */
    innerShadow?: boolean | {
        offsetY?: number;
        blur?: number;
        alpha?: number;
        color?: string;
    };
    /**
     * Override the shader sampling scale. Larger values zoom into the shared
     * shader (visibly bigger pattern features); smaller values zoom out.
     * Defaults to the variant's baseline (1.6 for `'button'`, 1.3 for
     * `'circle'`) multiplied by `scale`.
     */
    shaderScale?: number;
    /**
     * Override the ring thickness in CSS pixels. Defaults to the variant's
     * baseline (1 for `'button'`, 2 for `'circle'`) multiplied by `scale`.
     */
    ringCssPx?: number;
    /**
     * Master scale multiplier for every absolute-pixel constant the engine
     * uses internally. Set this when you render the wrapped element at a
     * non-1× size (e.g. inside a CSS `zoom: 2` container, or when you've
     * doubled all your Tailwind sizes by hand). It scales:
     *   - shader sampling (so pattern features grow proportionally)
     *   - ring thickness on the canvas
     *   - glow SVG stroke widths, blur radii, fade-circle radius, and the
     *     small inset/outward offsets that position the catch-light
     *   - reflection canvas stroke band, border-highlight thickness, and the
     *     reference draw width baseline
     * @default 1
     */
    scale?: number;
    /**
     * Custom alpha mask painter. When set, the shader is kept only where the
     * mask paints (device px, origin at the wrapper's top-left) and the ring
     * punch is skipped — for metal-filled text or glyphs. Pair with
     * `disableGlow`; the glow assumes a ring perimeter.
     */
    mask?: MaskFn;
    /**
     * How the glow is placed when `mask` is set. `'mask'` (default) samples
     * points inside the mask and clips the halo to it — right for metal text.
     * `'ring'` keeps the rounded-rect perimeter behaviour — a halo along the
     * element's edge — for a full-fill mask like a badge.
     */
    glowMode?: 'mask' | 'ring';
    /**
     * Forwarded class name for the wrapper element.
     */
    className?: string;
    /**
     * Forwarded inline styles for the wrapper element.
     */
    style?: CSSProperties;
}

/**
 * A reflection target: either a bare ref, or a ref plus a per-target
 * `strength` multiplier (0..1+). Use the object form when a surface should
 * only catch a faint echo of the metal — a container the button sits inside,
 * for example — without turning down every other target.
 */
export declare type MetalFxReflectionTarget = RefObject<HTMLElement | null> | {
    ref: RefObject<HTMLElement | null>;
    strength?: number;
};

/**
 * Theme mode for the metal effect.
 *
 * - `auto` (default): follows the user's `prefers-color-scheme` and updates
 *   live when the OS / browser theme changes (also gracefully falls back to
 *   `dark` during SSR or when `matchMedia` is unavailable).
 * - `dark`: pin to the dark-mode tunings regardless of system preference.
 * - `light`: pin to the light-mode tunings regardless of system preference.
 *
 * Drive this from your app's theme state if you have a manual toggle that
 * doesn't follow the OS — otherwise `auto` is the right default.
 */
export declare type MetalFxTheme = 'dark' | 'light' | 'auto';

/**
 * Variant for the metal effect.
 * - 'button' (default): pill-shaped 134×40 baseline with shaderScale 1.6
 * - 'circle': compact 32×32 circle baseline with shaderScale 1.3
 *
 * In practice the wrapped child's measured dimensions drive the visible size —
 * the variant only controls the shader sampling scale and ring thickness.
 */
export declare type MetalFxVariant = 'button' | 'circle';

export declare function MetalText({ children, font, color, strength, theme, reflectionTargets, className, innerShadow, glow, glowGain, metalOpacity, shaderScale, }: {
    children: string;
    /** CSS `font` shorthand for the live span, e.g. `500 24px/1 Inter, sans-serif`. */
    font: string;
    /** Base text colour from the design; the metal composites over it. */
    color: string;
    strength?: number;
    theme?: MetalFxTheme;
    reflectionTargets?: ReadonlyArray<MetalFxReflectionTarget>;
    className?: string;
    /** Top-edge light rim inside the glyphs. Pass null to disable. */
    innerShadow?: TextInnerShadow | null;
    /** Halo on the glyphs. Off by default — the design has none. */
    glow?: boolean;
    /** Glow multiplier when `glow` is on. */
    glowGain?: number;
    /** How much metal shows over the base colour (0..1), multiplied with `strength`. */
    metalOpacity?: number;
    /** Zoom of the metal inside the glyphs. */
    shaderScale?: number;
}): JSX_2.Element;

/**
 * Paint an element's text run onto a canvas with the DOM's own font and
 * metrics, so canvas glyphs land on the DOM glyphs to within a device px.
 * Shared by the Pro badge's metal fill and the text reflection mask.
 *
 * `ctx` is expected in device px with origin at `root`'s top-left; the
 * function scales by `dpr` internally.
 */
export declare function paintTextRun(ctx: CanvasRenderingContext2D, root: HTMLElement, textEl: HTMLElement, dpr: number): void;

export declare function pauseShared(): void;

export declare interface Preset {
    name: PresetName;
    modes: Record<PresetTheme, PresetMode>;
}

export declare interface PresetMode {
    /** Backdrop RGBA as `#rrggbb` or `#rrggbbaa`. Composited under the metal. */
    colorBack: string;
    /** Tint RGBA as `#rrggbb` or `#rrggbbaa`. Applied as colour-burn; the alpha
     *  channel is the blend amount, not an opacity. */
    colorTint: string;
    /** Time multiplier applied JS-side before `u_time` is uploaded. */
    speed: number;
    /** Stripe density (1..10). */
    repetition: number;
    /** Stripe transition blur, 0 = hard edge (0..1). */
    softness: number;
    /** R-channel dispersion (-1..1). */
    shiftRed: number;
    /** B-channel dispersion (-1..1). */
    shiftBlue: number;
    /** Simplex-noise warp over the stripe field (0..1). */
    distortion: number;
    /** How strongly the pattern follows the shape edge (0..1). */
    contour: number;
    /** Pattern drift direction in degrees (0..360). */
    angle: number;
    /** Mask shape. `SHAPE_NONE` fills the frame — the right choice for a ring. */
    shape: number;
    /** Overall zoom (0.01..4). */
    scale: number;
    /** Overall rotation in degrees (0..360). */
    rotation: number;
    /** Graphic centre offset (-1..1). */
    offsetX: number;
    offsetY: number;
    /** Reference point for positioning the world box (0..1). */
    originX: number;
    originY: number;
    /** Virtual size before fitting. 0 = use the canvas dimension. */
    worldWidth: number;
    worldHeight: number;
    /** FIT_NONE / FIT_CONTAIN / FIT_COVER. */
    fit: number;
    /** Global alpha applied when the shared frame is copied onto an instance.
     *  Paper's shader has no equivalent uniform, so this is a JS-side multiply
     *  in `copyShaderToInstance` rather than something the GPU applies. */
    shaderOpacity: number;
}

/**
 * Bundled preset configurations for the metal effect.
 *
 * These sit on top of Paper Shaders' `liquidMetal`, so the parameter set is
 * Paper's, not the old plasma engine's. Baseline values come from Paper's own
 * `fullScreenPreset` ("Backdrop") — the `shape: 'none'` variant, which fills
 * the frame with the material instead of masking it to a circle/daisy/diamond.
 * That's the mode we want: metal-fx carves the ring itself on the 2D canvas
 * (`punchInnerHole`), so the shader should hand us a full sheet of metal.
 *
 * A note on color, because it is the big behavioural change from the plasma
 * engine: Paper hardcodes the stripe endpoints inside the shader to
 * near-white (.98,.98,1.) and near-black (.1,.1,.1). There is no palette to
 * feed. All three presets therefore render the *same* silver material and
 * differ only in `colorTint`, which the shader applies as a colour-burn pass
 * weighted by the tint's alpha. `chromatic` is consequently an approximation
 * — the old 5-stop rainbow is not reproducible here.
 *
 * `colorBack` is composited *under* the material at its own alpha. Keep it
 * fully transparent for ring use, otherwise the punched-out centre fills in.
 *
 * `speed` is applied JS-side to `u_time` before upload (cheaper than a
 * uniform, and it matches how Paper's own mount drives time).
 */
export declare type PresetName = 'chromatic' | 'silver' | 'gold';

export declare const PRESETS: Record<PresetName, Preset>;

export declare type PresetTheme = 'dark' | 'light';

/** Re-composite one instance now — for callers driving `deform` per frame at
 *  a higher rate than the shared 15 fps loop. */
export declare function redrawInstance(canvas: HTMLCanvasElement): void;

export declare const REFLECTION_OCCLUDER: ReflectionOccluderConfig;

export declare const REFLECTION_OCCLUDER_DEFAULTS: Readonly<ReflectionOccluderConfig>;

export declare interface ReflectionOccluderConfig {
    enabled: boolean;
    /** Occluder radius, CSS px — how "big" the cursor is as a light blocker. */
    radius: number;
    /** Peak shadow depth (0..1) with the pointer right at the target's edge. */
    strength: number;
    /** Penumbra growth: band half-height multiplier at the anchor's edge. */
    penumbra: number;
    /** How much depth is lost as the pointer moves from target edge (0) to
     *  anchor edge (1). 0 = same shadow everywhere in the gap. */
    falloff: number;
    /** Fade-in distance at the gap's ends, as a multiple of `radius`. */
    edgeFade: number;
    /** Band profile. 1 = smooth triangle, 0 = hard-edged plateau. */
    softness: number;
    /** Repaint throttle while the pointer moves, ms. */
    repaintMs: number;
}

export declare function resetBendConfig(): void;

export declare function resetCursorLightConfig(): void;

export declare function resetGlowConfig(): void;

export declare function resetReflectionOccluderConfig(): void;

export declare function resumeShared(): void;

export declare const RIM_DEFAULTS: Readonly<RimOptions>;

export declare interface RimOptions {
    /** Shadow offset, CSS px (positive = light from above). */
    offsetY: number;
    /** Blur, CSS px. */
    blur: number;
    /** Peak opacity of the rim (0..1). */
    alpha: number;
    /** Rim colour, `#rrggbb`. */
    color: string;
}

export declare function setBendConfig(patch: Partial<BendConfig>): void;

export declare function setCursorLightConfig(patch: Partial<CursorLightConfig>): void;

/** Supply the pointer raster (or null to turn the cursor effect off). Must
 *  match the OS pointer pixel-for-pixel, or the swap is visible. */
export declare function setCursorSprite(next: CursorSprite | null): void;

/**
 * Merge a partial config. Notifies subscribers, flagging whether any markup
 * key changed so they can decide between "next frame picks it up" and
 * "rebuild the SVG".
 */
export declare function setGlowConfig(patch: Partial<GlowConfig>): void;

/**
 * Attach (or clear) a vector deformation to the instance that owns `canvas`.
 * `overscan` grows the canvas by that many CSS px on every side so outward
 * bulges aren't clipped. Redraws immediately so a paused instance updates.
 */
export declare function setInstanceDeform(canvas: HTMLCanvasElement, deform: DeformFn | null, layers?: DeformLayers | null, overscan?: number): boolean;

export declare function setReflectionOccluderConfig(patch: Partial<ReflectionOccluderConfig>): void;

export declare function setSharedPreset(name: PresetName, theme: PresetTheme): void;

/**
 * Push raw Paper liquidMetal parameters into the shared renderer, bypassing
 * the named presets. Pass `null` to hand control back to `preset` / `theme`.
 *
 * This exists for the playground: every instance shares one GL program, so
 * tuning is necessarily global rather than per-instance.
 */
export declare function setSharedPresetMode(mode: PresetMode | null): void;

export declare const SHAPE_CIRCLE = 1;

export declare const SHAPE_DAISY = 2;

export declare const SHAPE_DIAMOND = 3;

export declare const SHAPE_METABALLS = 4;

/** Paper's `LiquidMetalShapes`. Only `none` fills the frame. */
export declare const SHAPE_NONE = 0;

export declare function subscribeGlowConfig(fn: Listener): () => void;

/**
 * Figma inner shadow on the text (1471:40930): white 90 %, offset 0/1,
 * blur 0.5 — a hairline of light along the top inside edge of every glyph.
 * CSS has no inner shadow for text, so it's computed: glyph alpha minus the
 * same alpha shifted down by the offset leaves exactly that top rim, which is
 * then blurred and drawn white on an overlay above the metal.
 */
export declare interface TextInnerShadow {
    offsetY: number;
    blur: number;
    alpha: number;
}

/** Render `textEl`'s glyphs white-on-transparent over `root`'s box → data URL. */
export declare function textMaskDataUrl(root: HTMLElement, textEl: HTMLElement): string | null;

export declare function updateInstance(inst: MetalFxInstance, patch: Partial<Pick<MetalFxInstance, 'cssWidth' | 'cssHeight' | 'cornerRadius' | 'kind' | 'shaderScale' | 'ringCssPx' | 'opacityMul' | 'glowGain' | 'paused' | 'scale' | 'mask'>>): void;

/**
 * Cursor-driven local deformation ("liquid dent") for a MetalFx root.
 *
 * Field
 * ─────
 * Two gaussian blobs centred at `c` (which lags the cursor by `follow`):
 *   • directional: `amp · g_bend(r)` — a 2-D spring chasing the cursor's
 *     smoothed velocity × gain, so motion toward the centre pushes the ring
 *     in and motion away drags it out; recoils on release.
 *   • liquid: `(p − c)/σ · g_liq(r) · la` — the gradient of a bump, i.e. a
 *     divergent push away from the contact point. This term *stretches*
 *     material rather than sliding it, so the stroke thins under the cursor
 *     and thickens either side. `la` is its own slower spring; pressure is 1
 *     with the cursor on the ring, fading over `liquidReach`.
 *
 * Two render paths, chosen by `applyTo`:
 *
 * `ring` — vector. The engine masks the ring with a rounded-rect outline it
 * traces every frame; we hand it a `DeformFn` that displaces those outline
 * points, plus the fill / rim / hairline that normally live on CSS boxes so
 * they bend along. Edges stay anti-aliased at any stretch. The instance is
 * redrawn from here at the pointer's frame rate, since the shared loop only
 * composites at 15 fps.
 *
 * `all` — SVG `feDisplacementMap` on the whole root. Bends the content too,
 * but the sampler duplicates source pixels where material is stretched, so
 * quality degrades with amplitude. Kept for comparison.
 */
export declare function useMetalBend(ref: RefObject<HTMLElement | null>, getCfg?: () => BendConfig): void;

/**
 * Confine a proximity reflection to an element's glyphs.
 *
 * The engine paints reflections into a wrapper it inserts inside the target
 * (`[data-metal-fx-reflection]`, canvases inset:0). For a text node that
 * would light the whole line box and stroke its rectangle. This masks the
 * wrapper with the text rendered white-on-transparent, so only the
 * letterforms catch the light. Re-rendered on resize and once fonts load.
 */
export declare function useMetalTextReflection(ref: RefObject<HTMLElement | null>): void;

export { }
