// Preloaded into the founder console's server by the look gate (admin.mjs): `Date` reads LOOK_GATE_NOW (epoch ms), so a
// time the console prints ("As of 12:00:00 UTC") is the same on every run, as the browser's clock is. A Proxy, not a
// subclass: the console refused every session under a `class extends Date` (measured), and kept it under this.
const now = Number(process.env.LOOK_GATE_NOW);
if (Number.isFinite(now)) {
  const Real = Date;
  Real.now = () => now;
  globalThis.Date = new Proxy(Real, {
    construct: (target, args, newTarget) =>
      Reflect.construct(target, args.length ? args : [now], newTarget === globalThis.Date ? target : newTarget),
    apply: () => new Real(now).toString(),
  });
}
