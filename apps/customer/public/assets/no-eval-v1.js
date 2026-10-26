// The production policy (security-headers.conf.template) has no 'unsafe-eval'. zod's speed-up probe, a `Function('')`
// call made while the app's modules load, is refused and reported as a Content-Security-Policy violation on every page.
// zod reads this shared setting before probing and skips the probe; parsing behaves the same. A classic script, so it
// runs before any module (an import in main.tsx would run after the chunks it imports). nginx serves /assets/ as
// immutable, so a change to this file ships under a new name (no-eval-v2.js) and index.html points at it.
globalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig ?? {}, { jitless: true });
