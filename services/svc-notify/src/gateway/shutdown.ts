export function createRelayShutdown(options: { closeHttp: () => Promise<unknown>; closeSql: () => Promise<unknown> }) {
  let pending: Promise<void> | undefined;
  return () =>
    (pending ??= (async () => {
      let failed = false;
      // Drain HTTP before closing storage used to settle in-flight receipts.
      try {
        await options.closeHttp();
      } catch {
        failed = true;
      }
      try {
        await options.closeSql();
      } catch {
        failed = true;
      }
      if (failed) {
        console.error('notify.relay.shutdown_unavailable');
        process.exitCode = 1;
      }
    })());
}
