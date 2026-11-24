import test from 'node:test';
import assert from 'node:assert/strict';
import { blockSides, judgeFile, judgeLine } from './look-drift.mjs';

// Each case compares a judgement with its expected value; the counter proves every case in a block ran.
function counter() {
  const eq = (got, want, m) => {
    eq.count++;
    assert.deepEqual(got, want, m);
  };
  eq.count = 0;
  return eq;
}
const css = (l) => judgeLine(l, 'css');
const ts = (l) => judgeLine(l, 'ts');

test('judgeLine: CSS colours, sizes and sides', () => {
  const eq = counter();
  eq(css('  color: #3f7dff;'), ['raw colour'], 'hex');
  eq(css('  background: rgba(0, 0, 0, 0.4);'), ['raw colour'], 'rgba');
  eq(css('  color: white;'), ['raw colour'], 'named');
  eq(css('  border: 1px solid black;'), ['raw colour'], 'named in shorthand, 1px hairline passes');
  eq(css('  color: var(--lit-text-1);'), [], 'role token');
  eq(css('  background: rgb(var(--if-bg-rgb) / 0.5);'), [], 'rgb of a token');
  eq(css('  color: transparent;'), [], 'transparent');
  eq(css('  padding: 12px;'), ['pixel size'], 'px');
  eq(css('  padding: 0px;'), [], '0px');
  eq(css('  inline-size: calc(100% - var(--lit-gap));'), [], 'calc of a token');
  eq(css('@media (min-width: 768px) {'), [], 'px in a media query');
  eq(css('  outline: 2px solid var(--if-focus);'), [], 'a 2px focus ring is a line weight');
  eq(css('  border-block-end: 2px solid var(--lit-line);'), [], 'a 2px border');
  eq(css('  border-radius: 8px;'), ['pixel size'], 'a radius is a size');
  eq(css('  border: 3px solid var(--lit-line);'), ['pixel size'], 'a heavy border needs a token');
  eq(css('  margin-left: auto;'), ['physical side'], 'margin-left');
  eq(css('  left: 0;'), ['physical side'], 'left:');
  eq(css('  text-align: right;'), ['physical side'], 'text-align right');
  eq(css('  border-top-left-radius: var(--lit-r);'), ['physical side'], 'physical corner');
  eq(css('  margin-inline-start: auto;'), [], 'logical');
  eq(css('  inset-inline-start: 0;'), [], 'logical inset');
  eq(css('  text-align: start;'), [], 'text-align start');
  eq(css('  grid-template-areas: "left right";'), [], 'words in a string are not properties');
  eq(css('  color: #fff; /* look-drift-allow: the payment network asks for its exact mark colour */'), [], 'allowed');
  eq(css('  /* was #fff */ color: var(--lit-text-1);'), [], 'comment ignored');
  eq(css('  transition: transform 120ms var(--lit-ease);'), [], 'ms is not px');
  eq(css('  margin-top: -12px;'), ['pixel size'], 'negative px');
  eq(css('  transform: translateX(-4px);'), ['pixel size'], 'negative px in a function');
  eq(css('  margin-block-start: -1px;'), [], 'negative hairline');
  eq(css('a { color: white }'), ['raw colour'], 'named colour before a closing brace');
  eq(css('#add-button { display: none; }'), [], 'an id selector is not a colour');
  eq(css('a[href="#face"] { text-decoration: underline; }'), [], 'an attribute selector is not a colour');
  eq(css('#add,'), [], 'a selector list line');
  eq(css('    #0a0a0a 3%, #ececec 20%,'), ['raw colour'], 'a gradient carried over a line');
  assert.equal(eq.count, 34, 'every case ran');
});

test('judgeLine: TS and TSX colours, sizes and sides', () => {
  const eq = counter();
  eq(ts(`  <div style={{ color: '#3f7dff' }} />`), ['raw colour'], 'inline hex');
  eq(ts(`  <a href="#add">Add</a>`), [], 'a fragment link is not a colour');
  eq(ts(`  const accent = '#3f7dff';`), ['raw colour'], 'a bare hex string');
  eq(ts(`  const glow = 'drop-shadow(0 0 4px #3f7dff)';`), ['raw colour', 'pixel size'], 'hex inside a style string');
  eq(ts(`  const id = '#deadbeef-row';`), [], 'a hex-like id with a suffix');
  eq(ts(`  <div className="bg-red-500 text-white" />`), ['raw colour'], 'tailwind palette');
  eq(ts(`  <div className="bg-[#123456]" />`), ['raw colour'], 'tailwind arbitrary colour');
  eq(ts(`  <div className="bg-[var(--lit-solid-bg)] text-[color:var(--lit-text-1)]" />`), [], 'tailwind with tokens');
  eq(ts(`  <div className="w-[12px]" />`), ['pixel size'], 'tailwind arbitrary px');
  eq(ts(`  <div style={{ width: '12px' }} />`), ['pixel size'], 'style px');
  eq(ts(`  <div className="ml-2 pr-4" />`), ['physical side'], 'tailwind ml/pr');
  eq(ts(`  <div className={cn('text-right', x)} />`), ['physical side'], 'tailwind text-right in cn');
  eq(ts(`  <div className="ms-2 pe-4 text-end start-0 border-s rounded-ss" />`), [], 'tailwind logical');
  eq(ts(`  <div style={{ marginLeft: 4 }} />`), ['physical side'], 'style marginLeft');
  eq(ts(`  const rect = { left: 0, right: 10 };`), [], 'geometry objects are not judged');
  eq(ts(`  const mode = 'left';`), [], 'a word is not a class');
  eq(ts(`  <Icon className="size-4" aria-label="Move left" />`), [], 'words in labels');
  eq(ts(`  // was ml-2 and #fff`), [], 'comment ignored');
  eq(ts(`   * A handle like "#A1B2C3D4" a person can quote.`), [], 'doc comment ignored');
  eq(ts(`  <li className="tb-mode min-[1000px]:hidden">`), [], 'a breakpoint variant is a query');
  eq(ts(`  const url = 'https://x.test/#abc';`), [], 'url fragment');
  eq(ts(`  const title = 'Order #123 is on its way';`), [], 'a number sign in copy');
  eq(ts(`  <aside className="left-rail" />`), [], 'a class named left-rail');
  eq(ts(`  <aside className="left-0 right-1/2 ml-auto pl-[var(--lit-gap)]" />`), ['physical side'], 'tailwind side values');
  eq(ts(`  <Link to="/x" style={{ color: '#ff0000' }}>`), ['raw colour'], 'a link on the line does not hide a colour');
  eq(ts(`  const g = { from: '#fff', to: '#000' };`), ['raw colour'], 'a gradient object');
  eq(ts(`  <div style={{ marginTop: '-8px' }} />`), ['pixel size'], 'negative px string');
  eq(ts(`  const wide = window.matchMedia('(min-width: 768px)');`), [], 'a media query string');
  eq(ts(`  const s = 'margin-left: 4px';`), ['pixel size', 'physical side'], 'CSS inside a string');
  assert.equal(eq.count, 29, 'every case ran');
});

test('judgeLine: top and bottom sides in the new look only', () => {
  const eq = counter();
  const litCss = (l) => judgeLine(l, 'css', { query: 0 }, { newLook: true });
  const litTs = (l) => judgeLine(l, 'ts', { query: 0 }, { newLook: true });
  eq(css('  margin-top: var(--lit-gap);'), [], 'a top side passes in an old room');
  eq(litCss('  margin-top: var(--lit-gap);'), ['top or bottom side'], 'margin-top in the new look');
  eq(litCss('  padding-bottom: 0;'), ['top or bottom side'], 'padding-bottom');
  eq(litCss('  border-top: 1px solid var(--lit-line);'), ['top or bottom side'], 'border-top');
  eq(litCss('  position: sticky; top: 0;'), ['top or bottom side'], 'top:');
  eq(litCss('  border-top-left-radius: var(--lit-r);'), ['physical side'], 'a corner is one finding, not two');
  eq(litCss('  margin-block-start: var(--lit-gap); inset-block-end: 0;'), [], 'block sides pass');
  eq(litCss('  vertical-align: top; background-position: bottom;'), [], 'top as a value is not a side');
  eq(litCss('  --lit-gap-top: 1rem;'), [], 'a custom property name is not a side');
  eq(litTs(`  <div className="mt-2 pb-4 border-b" />`), ['top or bottom side'], 'tailwind mt/pb/border-b');
  eq(litTs(`  <div className="mbs-2 pbe-4 inset-bs-0 border-be rounded-ss" />`), [], 'tailwind block logical');
  eq(litTs(`  <div style={{ marginTop: 4 }} />`), ['top or bottom side'], 'style marginTop');
  eq(litTs(`  const rect = { top: 0, bottom: 10 };`), [], 'geometry objects are not judged');
  eq(litTs(`  <p className="top-note" />`), [], 'a class named top-note');
  eq(litCss('  border-bottom-color: var(--lit-line); border-top-width: 1px;'), ['top or bottom side'], 'border longhands');
  eq(litTs(`  const s = 'border-top-left-radius: 1rem';`), [], 'a corner in a string is not a block side');
  eq(litTs(`  <div className="mt-(--lit-gap) top-(--lit-gap)" />`), ['top or bottom side'], 'tailwind variable values');
  eq(litTs(`  const { marginTop } = getComputedStyle(el);`), [], 'a measurement read is not a style');
  eq(litTs(`  el.style.marginTop = '0';`), ['top or bottom side'], 'a style write');
  eq(ts(`  <div className="mt-2" />`), [], 'tailwind mt passes in an old room');
  assert.equal(eq.count, 20, 'every case ran');
});

test('judgeFile: scope, changed lines and what is not judged', () => {
  const eq = counter();
  const f = (path, text, only) => judgeFile(path, text, only).findings.length;
  eq(f('apps/customer/src/x.css', 'a { color: #fff; }'), 1, 'new file judged');
  eq(f('packages/ui/src/lit/templates/balance.css', '.b { padding: 12px; }'), 1, 'a template is judged');
  eq(f('packages/ui/src/components/table.css', '.t { padding: 12px; }'), 0, 'kit components are the system');
  eq(f('apps/customer/src/x.css', 'a { color: #fff; }\nb { color: var(--if-fg); }', new Set([2])), 0, 'only changed lines');
  eq(f('packages/ui/src/theme/tokens.css', ':root { --if-bg: #000; }'), 0, 'token definitions not judged');
  eq(f('packages/ui/src/lit/lit.css', ':root { --lit-page: #05070d; }'), 0, 'lit token values not judged');
  eq(f('packages/ui/src/lit/components/key.css', '.k { inline-size: 18px; }'), 0, 'a lit component may hold structural px');
  eq(f('packages/ui/src/lit/components/key.css', '.k { margin-left: var(--lit-gap); }'), 1, 'a lit component may not use physical sides');
  eq(f('packages/ui/src/lit/components/key.css', '.k { color: #fff; }'), 1, 'a lit component may not use raw colours');
  eq(f('packages/ui/src/lit/components/key.tsx', `<i className="border-l" />`), 1, 'a lit component may not use a Tailwind physical side');
  eq(f('apps/customer/src/screens/home/home.test.tsx', `expect(x).toBe('#fff')`), 0, 'tests not judged');
  eq(f('apps/customer/src/screens/home/home.fixtures.mjs', `const c = '#fff';`), 0, 'fixtures not judged');
  eq(f('services/svc-bank/src/x.ts', `const c = '#fff';`), 0, 'out of scope');
  eq(
    f('apps/customer/src/x.css', '@media (max-width: 600px) {\n  a { padding: 4px; }\n}\nb { padding: 4px; }'),
    1,
    'px inside a query block passes, after it fails',
  );
  eq(
    f('apps/customer/src/x.css', '@media (min-width: 768px)\n{\n  a { padding: 4px; }\n}\nb { padding: 4px; }'),
    1,
    'query brace on the next line',
  );
  eq(f('apps/customer/src/x.css', '@supports (display: grid) {\n  a { padding: 40px; }\n}'), 1, '@supports is not a query');
  eq(
    f('apps/customer/src/x.css', 'a::before { content: "{"; }\n@media (min-width: 9px) {\n a { padding: 4px; }\n}\nb { padding: 4px; }'),
    1,
    'braces in strings are not counted',
  );
  eq(
    f(
      'packages/ui/src/lit/templates/templates.css',
      '/*\n * Rooms are 720px wide on a phone,\n * and the band was #fff once.\n */\n.a { color: var(--lit-text-1); }',
    ),
    0,
    'every line of a CSS block comment that spans lines is skipped',
  );
  eq(f('apps/customer/src/x.css', '/* open\n  still 12px\n*/ a { padding: 12px; }'), 1, 'code after a block comment closes is judged');
  eq(
    f('apps/customer/src/x.tsx', 'const a = 1; /* was\n  #fff and ml-2\n*/\nconst s = { marginLeft: 4 };'),
    1,
    'a TS block comment that spans lines is skipped, the code after it is not',
  );
  eq(
    f('apps/customer/src/x.tsx', "const g = '/*'; const c = 'drop-shadow(0 0 4px #3f7dff)';"),
    2,
    'a comment opener in a string opens nothing (px and colour found)',
  );
  eq(
    f('apps/customer/src/x.tsx', "// see /* here\nconst c = 'drop-shadow(0 0 4px #3f7dff)';"),
    2,
    'a comment opener after // opens nothing (px and colour found)',
  );
  eq(f('packages/ui/src/lit/templates/__gallery__/gallery.css', '.g { padding: 24px; color: #fff; }'), 0, 'the TEST gallery is not judged');
  eq(f('packages/ui/src/components/__gallery__/KitSections.tsx', `<i style={{ color: '#fff' }} />`), 0, 'the kit gallery is not judged');
  eq(f('packages/ui/src/lit/fx/glow.css', '.g { box-shadow: 0 0 2rem rgba(63, 125, 255, 0.4); }'), 1, 'lit/fx colours come from roles');
  eq(f('packages/ui/src/lit/fx/glow.css', '.g { box-shadow: 0 0 2rem var(--lit-glow); }'), 0, 'lit/fx role colour passes');
  eq(f('apps/customer/public/assets/vendor.js', "a.style.color='#fff'"), 0, '.js is not judged (see the header)');
  eq(f('apps/customer/src/features/more/playwright.config.ts', `viewport: '1280px'`), 0, 'a playwright config is not judged');
  eq(
    judgeFile('apps/customer/src/x.css', 'a { color: #fff; } /* look-drift-allow: exact partner mark colour */').allowed.length,
    1,
    'allowed lines listed',
  );
  assert.equal(eq.count, 29, 'every case ran');
});

test('judgeFile and blockSides: migrated rooms', () => {
  const eq = counter();
  const rooms = new Set(['apps/customer/src/screens/home']);
  const b = (path, text) => judgeFile(path, text, null, rooms).findings.map((x) => x.rule);
  eq(b('apps/customer/src/screens/home/home.css', '.h { margin-top: 0; }'), ['top or bottom side'], 'a migrated room');
  eq(b('apps/customer/src/screens/money/money.css', '.m { margin-top: 0; }'), [], 'a room not migrated');
  eq(b('packages/ui/src/lit/components/key.css', '.k { padding-bottom: 0; }'), ['top or bottom side'], 'the lit kit');
  eq(
    b('apps/customer/src/app/App.tsx', "import { X } from '@intafaced/ui/lit';\nconst s = { marginTop: 4 };"),
    [],
    'the app shell is old look',
  );
  eq(blockSides('apps/customer/src/app/App.tsx', rooms), false, 'the app shell is not a room');
  assert.equal(eq.count, 5, 'every case ran');
});
