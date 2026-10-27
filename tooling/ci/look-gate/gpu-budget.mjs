/**
 * The GPU budget (redesign plan v2, B3): what a page may ask of a phone's graphics chip, read from the rendered page.
 *   blur      backdrop-filter only on the navigation and sheet layers (`data-layer="nav"|"sheet"`, the app's top bar
 *             `header.tb` and phone doors `.mobile-doors`, or a dialog);
 *   blurred   at most MAX_BLURRED blurred surfaces in any one screenful, a fixed or sticky one counted in every screenful;
 *   canvas    at most MAX_CANVASES 3D canvas (inside `[data-fx]`; a chart's 2D canvases are not 3D) in any one screenful,
 *             and any canvas's drawing buffer at most MAX_DPR times its box;
 *   3d        no 3D object (`[data-fx]`, a canvas) on a confirm or review step (`data-state="confirm"`, `data-slot="review"`).
 * Money on an opaque surface is the gate's `money` check. The gate renders at a device pixel ratio of 1, so the canvas
 * rule catches a buffer sized past its cap by hand; the cap itself (1.5 on a 3x phone) is fx/tier.ts's, tested there.
 */
export const MAX_BLURRED = 3;
export const MAX_CANVASES = 1;
export const MAX_DPR = 1.5;

/** Runs in the page (page.evaluate): every blurred surface, canvas and 3D object, with its box in page coordinates. */
export function measureGpu() {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { y: r.top + scrollY, height: r.height, width: r.width };
  };
  const name = (el) =>
    el.getAttribute('data-testid') ||
    el.getAttribute('data-fx') ||
    `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/)[0]}` : ''}`;
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const c = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none';
  };
  const layer = '[data-layer="nav"], [data-layer="sheet"], header.tb, .mobile-doors, dialog, [role="dialog"]';
  // a fixed or sticky surface (or one inside such a bar) is on every screenful, wherever the unrolled page puts it
  const pinned = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) if (/^(fixed|sticky)$/.test(getComputedStyle(n).position)) return true;
    return false;
  };
  const stepWithout3d = '[data-state="confirm"], [data-slot="review"]';
  const blurred = [];
  for (const el of document.querySelectorAll('body *')) {
    const c = getComputedStyle(el);
    const f = c.backdropFilter || c.webkitBackdropFilter;
    if (!f || f === 'none' || !/blur\(/.test(f) || !shown(el)) continue;
    blurred.push({ name: name(el), ...box(el), layer: Boolean(el.closest(layer)), pinned: pinned(el) });
  }
  const canvases = [...document.querySelectorAll('canvas')].filter(shown).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      name: name(el.closest('[data-fx]') ?? el),
      ...box(el),
      ratio: Math.max(el.width / r.width, el.height / r.height),
      fx: Boolean(el.closest('[data-fx]')),
      pinned: pinned(el),
    };
  });
  const onStep = [...document.querySelectorAll('[data-fx]')]
    .filter((el) => el.closest(stepWithout3d))
    .map((el) => `${name(el.closest('[data-fx]') ?? el)} in ${name(el.closest(stepWithout3d))}`);
  return { blurred, canvases, onStep };
}

/**
 * The most boxes that share any one screenful (a window of the viewport's height sliding down the page). A pinned box
 * (fixed or sticky) is in every screenful.
 */
export function mostInOneScreen(boxes, screen) {
  const pinned = boxes.filter((b) => b.pinned).length;
  const flowing = boxes.filter((b) => !b.pinned);
  let most = 0;
  for (const top of flowing.map((b) => b.y)) {
    const n = flowing.filter((b) => b.y < top + screen && b.y + b.height > top).length;
    most = Math.max(most, n);
  }
  return pinned + most;
}

/** The findings, as the gate's other checks word them. `screen` is the viewport's height before the page was unrolled. */
export function judgeGpu(m, screen) {
  const out = [];
  for (const b of m.blurred.filter((x) => !x.layer)) out.push(`blur on ${b.name}, which is not a nav or sheet layer`);
  const blurredAtOnce = mostInOneScreen(m.blurred, screen);
  if (blurredAtOnce > MAX_BLURRED) out.push(`${blurredAtOnce} blurred surfaces in one screenful (at most ${MAX_BLURRED})`);
  const canvasesAtOnce = mostInOneScreen(
    m.canvases.filter((c) => c.fx),
    screen,
  );
  if (canvasesAtOnce > MAX_CANVASES) out.push(`${canvasesAtOnce} 3D canvases in one screenful (at most ${MAX_CANVASES})`);
  for (const c of m.canvases)
    if (c.ratio > MAX_DPR + 0.01) out.push(`${c.name} draws at ${c.ratio.toFixed(2)}x its box (at most ${MAX_DPR}x)`);
  for (const s of m.onStep) out.push(`3D object ${s}: no 3D on a confirm or review step`);
  return out;
}

export function selfTest(eq) {
  const b = (y, height = 50, extra = {}) => ({ name: `at ${y}`, y, height, width: 100, layer: true, ...extra });
  const none = { blurred: [], canvases: [], onStep: [] };
  eq(judgeGpu(none, 844), [], 'gpu: an empty page has no findings');
  eq(judgeGpu({ ...none, blurred: [b(0)] }, 844), [], 'gpu: a blurred nav bar is allowed');
  eq(
    judgeGpu({ ...none, blurred: [b(100, 50, { layer: false, name: 'div.card' })] }, 844),
    ['blur on div.card, which is not a nav or sheet layer'],
    'gpu: blur off the nav and sheet layers is named',
  );
  eq(judgeGpu({ ...none, blurred: [b(0), b(100), b(200)] }, 844), [], 'gpu: three blurred surfaces in a screen are allowed');
  eq(
    judgeGpu({ ...none, blurred: [b(0), b(100), b(200), b(300)] }, 844),
    ['4 blurred surfaces in one screenful (at most 3)'],
    'gpu: a fourth blurred surface in the same screen is one too many',
  );
  eq(judgeGpu({ ...none, blurred: [b(0), b(100), b(200), b(1000)] }, 844), [], 'gpu: a fourth a screen further down is fine');
  eq(mostInOneScreen([b(0, 50), b(800, 50)], 844), 2, 'gpu: boxes within one viewport height share a screen');
  eq(mostInOneScreen([b(0, 50), b(900, 50)], 844), 1, 'gpu: boxes a viewport apart do not');
  const canvas = (y, ratio = 1, fx = true) => ({ name: 'sphere', y, height: 200, width: 200, ratio, fx });
  eq(
    judgeGpu({ ...none, canvases: [canvas(100, 1, false), canvas(150, 1, false), canvas(300, 1, false)] }, 844),
    [],
    "gpu: a chart's 2D canvases are not 3D canvases",
  );
  eq(
    judgeGpu({ ...none, blurred: [b(0, 48, { pinned: true }), b(5000, 60, { pinned: true }), b(2000), b(2100)] }, 844),
    ['4 blurred surfaces in one screenful (at most 3)'],
    'gpu: fixed and sticky bars count in every screenful, wherever the unrolled page puts them',
  );
  eq(mostInOneScreen([b(0, 48, { pinned: true }), b(9000, 60, { pinned: true })], 844), 2, 'gpu: pinned boxes share every screen');
  eq(judgeGpu({ ...none, canvases: [canvas(100, 1.5)] }, 844), [], 'gpu: one canvas at 1.5x is allowed');
  eq(
    judgeGpu({ ...none, canvases: [canvas(100), canvas(400)] }, 844),
    ['2 3D canvases in one screenful (at most 1)'],
    'gpu: two canvases in one screen are one too many',
  );
  eq(judgeGpu({ ...none, canvases: [canvas(100), canvas(2000)] }, 844), [], 'gpu: two canvases screens apart are fine');
  eq(
    judgeGpu({ ...none, canvases: [canvas(100, 2)] }, 844),
    ['sphere draws at 2.00x its box (at most 1.5x)'],
    'gpu: a canvas past the pixel-ratio cap is named',
  );
  eq(
    judgeGpu({ ...none, onStep: ['coin in div.lt-review'] }, 844),
    ['3D object coin in div.lt-review: no 3D on a confirm or review step'],
    'gpu: 3D on a confirm or review step is named',
  );
}
