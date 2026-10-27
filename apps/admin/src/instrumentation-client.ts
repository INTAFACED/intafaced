// The console's policy (lib/security-headers.mjs) has no 'unsafe-eval'. zod's speed-up probe, a `Function('')` call, is
// refused and reported as a Content-Security-Policy violation on every signed-in page. zod reads this shared setting
// before probing and skips the probe; parsing behaves the same. Next runs this file before the console's own code in the
// browser, as apps/customer/public/assets/no-eval-v1.js does for the Customer app.
const zodConfig = globalThis as { __zod_globalConfig?: Record<string, unknown> };
zodConfig.__zod_globalConfig = Object.assign(zodConfig.__zod_globalConfig ?? {}, { jitless: true });
