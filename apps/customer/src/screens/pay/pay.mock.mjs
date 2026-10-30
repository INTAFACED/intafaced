// Answers the calls the Pay screen makes, for the Playwright tests. No service is contacted.
//  - /api/identity/trpc/me                    (GET)   caller's own handle        [backend PR #4688]
//  - /api/identity/trpc/users.resolveHandle   (GET)   exact @handle lookup       [backend PR #4688]
//  - /api/identity/trpc/handle.get            (GET)   own handle settings        [PP-send-request-03]
//  - /api/identity/trpc/handle.change         (POST)  change own handle (TEST cap below)
//  - /api/identity/trpc/handle.setDiscoverable (POST) findable by handle or not
//  - /api/bank/trpc/spaces.list               (GET)   the customer's own balances
//  - /api/bank/trpc/transfers.quote           (GET)   published limits and fee (TEST figures below)
//  - /api/bank/trpc/transfers.toUser          (POST)  the payment
// A small world (balances) really changes when a payment is accepted. Overrides replace one answer: a JSON body, a
// function of the request, 'error' (500), 'abort' (connection dropped), 'hang' (held until release()), or { status, json }.

export const ME = '00000000-0000-4000-8000-000000000001';
export const MAYA = { userId: '5b0f4c1e-2f6d-4a38-9a51-0f8d2a6c7e11', handle: 'maya_test' };
export const SPACE = {
  usdt: '11111111-1111-4111-8111-111111111111',
  eth: '22222222-2222-4222-8222-222222222222',
  btc: '33333333-3333-4333-8333-333333333333',
  sol: '44444444-4444-4444-8444-444444444444',
  holiday: '55555555-5555-4555-8555-555555555555',
};

const space = (id, assetId, balance, over = {}) => ({
  id,
  assetId,
  kind: 'primary',
  name: `${assetId} main`,
  goalTarget: null,
  lockedUntil: null,
  balance,
  ledgerAccount: { ownerType: 'user', ownerId: ME, assetId, kind: 'available' },
  ...over,
});

export const startingBalances = () => ({ USDT: '1000.5', ETH: '0.25', BTC: '0' });
export const spacesFor = (balances) => [
  space(SPACE.usdt, 'USDT', balances.USDT),
  space(SPACE.eth, 'ETH', balances.ETH),
  space(SPACE.btc, 'BTC', balances.BTC),
  // Time-locked: never offered for sending.
  space(SPACE.sol, 'SOL', '9', { lockedUntil: '2099-01-01T00:00:00Z' }),
];

const trpc = (data) => ({ result: { data } });
const refusal = (status, message, code) => ({ status, json: { error: { message, data: code ? { intafacedCode: code } : {} } } });
export { refusal };

export async function mock(page, overrides = {}) {
  // TEST cap of 3 handle changes: a harness figure, not an owner value.
  const world = {
    balances: startingBalances(),
    sent: new Map(),
    counter: 0,
    handle: { handle: 'harness_me', discoverable: true, changesUsed: 0, changeCap: 3 },
  };
  const handleView = () => ({ ...world.handle, changesLeft: world.handle.changeCap - world.handle.changesUsed });
  const calls = [];
  const held = [];
  const answer = async (route, value, request) => {
    if (value === 'error') return route.fulfill({ status: 500, body: 'no' });
    if (value === 'abort') return route.abort('connectionreset');
    const resolved = typeof value === 'function' ? await value(request) : value;
    if (resolved && typeof resolved === 'object' && 'status' in resolved && 'json' in resolved)
      return route.fulfill({ status: resolved.status, json: resolved.json });
    return route.fulfill({ status: 200, json: resolved });
  };
  const defaults = {
    me: () => trpc({ userId: ME, handle: 'harness_me' }),
    resolve: ({ input }) => {
      const handle = String(input.handle).toLowerCase();
      if (handle === 'maya_test') return trpc({ found: true, userId: MAYA.userId, handle: MAYA.handle, self: false });
      if (handle === 'harness_me') return trpc({ found: true, userId: ME, handle: 'harness_me', self: true });
      return trpc({ found: false });
    },
    handleGet: () => trpc(handleView()),
    handleChange: ({ body }) => {
      const next = String(body.handle).trim().replace(/^@/, '');
      if (!/^[a-zA-Z0-9_]*$/.test(next))
        return refusal(400, 'A handle uses only letters, digits and underscore', 'identity.handle_characters');
      if (next.length < 3 || next.length > 32) return refusal(400, 'A handle has 3 to 32 characters', 'identity.handle_length');
      if (world.handle.changesUsed >= world.handle.changeCap)
        return refusal(412, 'You have changed your handle 3 times, the most allowed', 'identity.handle_change_cap_reached');
      world.handle = { ...world.handle, handle: next, changesUsed: world.handle.changesUsed + 1 };
      return trpc(handleView());
    },
    handleDiscoverable: ({ body }) => {
      world.handle = { ...world.handle, discoverable: Boolean(body.discoverable) };
      return trpc(handleView());
    },
    spaces: () => trpc(spacesFor(world.balances)),
    // TEST limits, wide enough that only the balance ever stops a harness payment. No fee.
    quote: ({ input }) =>
      trpc({
        assetId: input.assetId,
        amount: input.amount,
        perTransferLimit: '1000000',
        dailyLimit: '1000000',
        spentToday: '0',
        fee: '0',
        feeBlocker: null,
        withinPerTransfer: true,
        withinDaily: true,
      }),
    toUser: ({ body }) => {
      // The service is idempotent on transferId: the same id answers with the same transaction and moves money once.
      const known = world.sent.get(body.transferId);
      if (known) return trpc(known);
      const out = { ledgerTxId: `tx-${(world.counter += 1)}`, amount: body.amount };
      world.sent.set(body.transferId, out);
      const asset = Object.entries({ [SPACE.usdt]: 'USDT', [SPACE.eth]: 'ETH' }).find(([id]) => id === body.fromSpaceId)?.[1];
      if (asset) {
        const [w, f = ''] = world.balances[asset].split('.');
        const have = BigInt(w + f.padEnd(18, '0'));
        const [aw, af = ''] = body.amount.split('.');
        const take = BigInt(aw + af.padEnd(18, '0'));
        const left = (have - take).toString().padStart(19, '0');
        const whole = left.slice(0, -18).replace(/^0+(?=\d)/, '');
        const fraction = left.slice(-18).replace(/0+$/, '');
        world.balances[asset] = fraction ? `${whole}.${fraction}` : whole;
      }
      return trpc(out);
    },
  };
  const served = { ...defaults, ...overrides };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const [, , module, , procedure] = url.pathname.split('/');
    const name = {
      me: 'me',
      'users.resolveHandle': 'resolve',
      'handle.get': 'handleGet',
      'handle.change': 'handleChange',
      'handle.setDiscoverable': 'handleDiscoverable',
      'spaces.list': 'spaces',
      'transfers.quote': 'quote',
      'transfers.toUser': 'toUser',
    }[procedure];
    const input = url.searchParams.get('input') ? JSON.parse(url.searchParams.get('input')) : undefined;
    const body = request.method() === 'POST' ? request.postDataJSON() : undefined;
    calls.push({ module, procedure, method: request.method(), input, body, at: Date.now() });
    if (!name || !(name in served)) return route.fulfill({ status: 404, json: { error: { message: 'not mocked' } } });
    const value = served[name];
    if (value === 'hang') return void held.push({ route, name, input, body });
    return answer(route, value, { input, body });
  });
  return {
    world,
    calls,
    /** Every call to one procedure, in order. */
    to: (procedure) => calls.filter((call) => call.procedure === procedure),
    /** Answer every held request with the normal data. */
    release: async () => {
      for (const { route, name, input, body } of held.splice(0)) await answer(route, defaults[name], { input, body });
    },
  };
}
