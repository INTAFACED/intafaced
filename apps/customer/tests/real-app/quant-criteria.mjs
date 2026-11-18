// svc-quant's owner criteria (AL-lifecycle-01), set and read as an operator, for the Algo dev journeys.

/** svc-quant's owner-criteria door (AL-lifecycle-01), with the stack's TEST founder's operator token, as the founder console would use it. */
export async function criteriaDoor(journey) {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const founders = await gates.approverSessions(ctx);
  const token = await founders.a.tradeOpsToken();
  const data = (res, what) => {
    const got = res.json?.result?.data;
    if (!got) throw new Error(`${what} refused: ${res.status} ${res.text.slice(0, 300)}`);
    return got;
  };
  let n = 0;
  const stamp = `${process.env.JOURNEY_RUN_ID ?? 'local'}:${Date.now()}`;
  return {
    async read() {
      return data(await ctx.edge.query('quant', 'ops.criteria.get', undefined, token), 'ops.criteria.get').criteria;
    },
    async set(name, value, toBoot = false) {
      n += 1;
      return data(
        await ctx.edge.mutate(
          'quant',
          'ops.criteria.set',
          { name, value, toBoot, reason: `LOCAL TEST ${journey}`, idempotencyKey: `journey:${journey}:${stamp}:${n}:${name}` },
          token,
        ),
        'ops.criteria.set',
      );
    },
  };
}
