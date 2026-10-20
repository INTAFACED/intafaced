import { createOpsApprovalClient } from './operator-desks.js';
import { SECRET, keyCases } from './s2s-keys-fixture.js';

const input = {
  approvalId: 'a1b2c3d4-0000-4000-8000-000000000001',
  operationId: 'ops.custody:1',
  payloadHash: 'a'.repeat(64),
  targetService: 'svc-ops',
  targetId: 'custody:1',
  expectedVersion: '1',
};

// The recorder's empty reply is not a consumed approval, so the call is refused after the request went out; only the
// request is judged.
keyCases('svc-ops -> svc-identity approval consume', 'svc-identity', async (fetchImpl, s2s) => {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await createOpsApprovalClient('http://identity.test', SECRET, s2s)
      .consume(input)
      .catch(() => undefined);
  } finally {
    globalThis.fetch = real;
  }
});
