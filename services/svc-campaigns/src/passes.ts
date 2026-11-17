/**
 * The service's recurring passes (the reconciler, the payer, expiries and the ticks of competitions, draws and pools),
 * each declared once as a row in `wiring.ts` and run here. A pass never overlaps itself: a tick that finds the last one
 * still running is skipped. Its timer never keeps the process alive, and `stop()` clears every one, so a new pass is one
 * row and never a hand-written timer, flag and shutdown line (project-state#2730).
 */
export interface Pass {
  /** Named in the log line when the pass throws: `<name> failed`. */
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

export interface RunningPasses {
  stop: () => void;
}

export function startPasses(passes: readonly Pass[], onError: (err: unknown, name: string) => void): RunningPasses {
  const timers = passes.map((pass) => {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      pass
        .run()
        .catch((err: unknown) => onError(err, pass.name))
        .finally(() => {
          running = false;
        });
    }, pass.everyMs);
    timer.unref();
    return timer;
  });
  return {
    stop: () => {
      for (const timer of timers) clearInterval(timer);
    },
  };
}
