// Diagnostic only: when a locator with an exact part finds nothing but its loose twin does, log it and use the loose one.
import { appendFileSync } from 'node:fs';
const LOG = process.env.EXACT_DIAG_LOG;
const loosen = (sel) => sel.replace(/("(?:[^"\\]|\\.)*")s/g, '$1i');
const WAITING = new Set([
  'click',
  'dblclick',
  'fill',
  'check',
  'uncheck',
  'setChecked',
  'selectOption',
  'press',
  'pressSequentially',
  'type',
  'hover',
  'focus',
  'tap',
  'setInputFiles',
  'textContent',
  'innerText',
  'innerHTML',
  'inputValue',
  'getAttribute',
  'waitFor',
  'evaluate',
  'scrollIntoViewIfNeeded',
  'boundingBox',
  'screenshot',
  '_expect',
  'ariaSnapshot',
  'dispatchEvent',
  'selectText',
  'clear',
  'blur',
]);
const NOW = new Set([
  'count',
  'all',
  'isVisible',
  'isHidden',
  'isChecked',
  'isEnabled',
  'isDisabled',
  'isEditable',
  'allTextContents',
  'allInnerTexts',
  'evaluateAll',
]);
const site = () => (new Error().stack.split('\n').find((l) => /\.pw\.mjs:\d+/.test(l) && !l.includes('exact-diag')) ?? '').trim();
let done = false;
export function patchExact(page) {
  if (done) return;
  done = true;
  const proto = Object.getPrototypeOf(page.locator('body'));
  const origWaitFor = proto.waitFor;
  const origCount = proto.count;
  for (const name of [...WAITING, ...NOW]) {
    const orig = proto[name];
    if (typeof orig !== 'function') continue;
    proto[name] = async function (...args) {
      const sel = this._selector;
      const loose = typeof sel === 'string' ? loosen(sel) : sel;
      if (loose === sel || this.__diag) return orig.apply(this, args);
      const twin = new this.constructor(this._frame, loose);
      twin.__diag = true;
      const mk = new this.constructor(this._frame, sel);
      mk.__diag = true;
      let e = 0;
      let l = 0;
      const wait = WAITING.has(name) ? (name === '_expect' && args[1]?.isNot ? 300 : 4000) : 0;
      if (wait) await origWaitFor.call(mk.or(twin).first(), { state: 'attached', timeout: wait }).catch(() => {});
      try {
        e = await origCount.call(mk);
        l = await origCount.call(twin);
      } catch {}
      if (e === 0 && l > 0) {
        let names = '';
        try {
          names = (
            await twin.evaluateAll((els) =>
              els
                .slice(0, 3)
                .map((x) => (x.getAttribute('aria-label') || x.innerText || x.value || '').replace(/\s+/g, ' ').trim().slice(0, 160)),
            )
          ).join(' || ');
        } catch {}
        const line = JSON.stringify({ site: site(), name, sel, loose: l, names });
        if (LOG) appendFileSync(LOG, line + '\n');
        else console.log('EXACT-DIAG', line);
        return orig.apply(twin, args);
      }
      return orig.apply(this, args);
    };
  }
}
