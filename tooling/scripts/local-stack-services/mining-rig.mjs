import net from 'node:net';

/**
 * A TEST rig for the local stack: it dials the pool's miner door (svc-mining-pool `stratum-door.ts`) at the address the
 * mining room shows, authorizes with the account id and worker name the room copies, takes the pool's job, finds a
 * nonce for it with the TEST proof-of-work parameters the job names, and submits one share. LOCAL TEST only.
 *
 * `pow` is svc-mining-pool's built `dist/pow.js`. `start` seeds the nonce search, so the same start finds the same work
 * (which the pool refuses as `mining.share_duplicate`); `invalid` sends a nonce that misses the target instead.
 * Resolves `{ ok: true, nonce, jobId }` or `{ ok: false, code, nonce? }` with the pool's typed code.
 */
export async function rigShare({ host, port, login, pow, start, invalid, timeoutMs = 15_000 }) {
  const socket = net.connect({ host, port });
  socket.setEncoding('utf8');
  const inbox = [];
  let wake = null;
  let failure = null;
  let buffered = '';
  socket.on('data', (chunk) => {
    buffered += chunk;
    let at = buffered.indexOf('\n');
    while (at !== -1) {
      try {
        inbox.push(JSON.parse(buffered.slice(0, at)));
      } catch {
        failure ??= new Error('the miner door sent a line that is not JSON');
      }
      buffered = buffered.slice(at + 1);
      at = buffered.indexOf('\n');
    }
    wake?.();
  });
  socket.on('error', (err) => {
    failure = err;
    wake?.();
  });
  socket.on('close', () => {
    failure ??= new Error('the miner door closed the connection');
    wake?.();
  });
  const timer = setTimeout(() => {
    failure ??= new Error(`the miner door at ${host}:${port} did not answer in ${timeoutMs} ms`);
    // Also ends a connect that never completes.
    socket.destroy(failure);
    wake?.();
  }, timeoutMs);
  const next = async (match) => {
    for (;;) {
      const at = inbox.findIndex(match);
      if (at !== -1) return inbox.splice(at, 1)[0];
      if (failure) throw failure;
      await new Promise((resolve) => (wake = resolve));
      wake = null;
    }
  };
  const call = (id, method, params) => {
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return next((message) => message.id === id);
  };
  try {
    await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
    await call(1, 'mining.subscribe', []);
    const authorized = await call(2, 'mining.authorize', [login]);
    if (authorized.error) return { ok: false, code: authorized.error.code };
    const job = await next((message) => message.method === 'mining.notify');
    const [jobId, headerHex, dimension, targetBits, testnet] = job.params;
    const spec = { dimension, targetBits, testnet };
    const header = Buffer.from(headerHex, 'hex');
    const nonce = invalid ? pow.failingPow(spec, header, start) : pow.grindPow(spec, header, start);
    const submitted = await call(3, 'mining.submit', [login, jobId, nonce]);
    if (submitted.error) return { ok: false, code: submitted.error.code, nonce };
    return { ok: true, nonce, jobId };
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
