'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto').webcrypto;
const { createDraftStorage } = require('./outreach-draft-storage.js');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fallback(kind) {
  const original = '{"pendingRequestId":"unchanged-intent","continuation":"private-test-value"}';
  let request, closes = 0, transactions = 0, mutations = 0;
  const session = {
    getItem() { return original; },
    setItem() { mutations++; },
    removeItem() { mutations++; },
  };
  const database = { close() { closes++; }, transaction() { transactions++; throw new Error('Late database must not be read or deleted'); } };
  const indexedDB = { open() {
    request = { result: database };
      Object.defineProperty(request, 'error', { get() {
        if (kind === 'error') return new Error('open failed');
        throw new DOMException('The request is pending', 'InvalidStateError');
      } });
    if (kind === 'blocked') queueMicrotask(() => request.onblocked?.());
    if (kind === 'error') queueMicrotask(() => request.onerror?.());
    return request;
  } };
  const started = Date.now();
  const adapter = await Promise.race([
    createDraftStorage({ session, indexedDB, crypto, storageKey: 'test', now: Date.now }),
    delay(kind === 'pending' ? 3400 : 100).then(() => 'still-pending'),
  ]);
  assert.notEqual(adapter, 'still-pending', `${kind} open must finish with existing session fallback`);
  assert.equal(adapter.persistentAvailable, false);
  assert.equal(adapter.getItem('test'), original, 'Original continuation and pending request bytes survive fallback');
  assert.equal(mutations, 0);
  if (kind === 'pending') assert.ok(Date.now() - started >= 2900, 'The real pending-open bound is exercised');
  request.onsuccess();
  assert.equal(closes, 1, 'A late success closes only its own connection');
  assert.equal(transactions, 0, 'A late result never reads, deletes or resurrects saved drafts');
  assert.equal(adapter.getItem('test'), original);
}
async function healthy() {
  let closes = 0, reads = 0;
  const database = { close() { closes++; }, transaction(store, mode) {
    assert.equal(mode, 'readonly');
    const tx = { objectStore() { return { get() {
      reads++;
      const request = {};
      queueMicrotask(() => { request.onsuccess(); tx.oncomplete(); });
      return request;
    } }; } };
    return tx;
  } };
  const indexedDB = { open() { const request = { result: database }; queueMicrotask(() => request.onsuccess()); return request; } };
  const adapter = await createDraftStorage({ session: { getItem() { return null; } }, indexedDB, crypto, storageKey: 'test', now: Date.now });
  assert.equal(adapter.persistentAvailable, true);
  assert.equal(reads, 1);
  assert.equal(closes, 0);
}
(async () => {
  await fallback('blocked');
  await fallback('pending');
  await fallback('error');
  await healthy();
  console.log('outreach-draft-storage.golden: blocked, pending, late-result, original-session and healthy-open regressions passed');
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
