import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, edgeUpstreamsOff, profileOff, stackProfile } from './local-stack-profile.mjs';

const desk = { LOCAL_STACK_PROFILE: 'launch-desk' };

test('with no profile every process starts', () => {
  assert.equal(stackProfile({}), null);
  assert.equal(stackProfile({ LOCAL_STACK_PROFILE: 'all' }), null);
  for (const name of ['matching', 'p2p', 'academy', 'admin', 'edge']) assert.equal(profileOff(name, {}), false);
});

test('launch-desk leaves off what the launch desk does not use and keeps what it does', () => {
  for (const name of PROFILES['launch-desk']) assert.equal(profileOff(name, desk), false, name);
  for (const name of [
    'matching',
    'token',
    'p2p',
    'academy',
    'support',
    'market',
    'agents',
    'blueprint',
    'quant',
    'execution',
    'tax',
    'mining-pool',
    'dex',
    'campaigns',
    'fix',
    'video-store',
    'invitation',
    'apex',
    'admin',
    'team-tls',
  ])
    assert.equal(profileOff(name, desk), true, name);
  // The stack's own plumbing is no profile's to turn off.
  for (const name of ['nats', 'chain', 'test-venue']) assert.equal(profileOff(name, desk), false, name);
});

test('an unknown profile refuses, naming the ones there are', () => {
  assert.throws(() => stackProfile({ LOCAL_STACK_PROFILE: 'launchdesk' }), /all or one of launch-desk, not "launchdesk"/);
});

test("edge is told each off service's route, and only those", () => {
  const upstreams = { IDENTITY_URL: 'identity', P2P_URL: 'p2p', BANK_URL: 'bank', DEX_URL: 'dex' };
  assert.deepEqual(edgeUpstreamsOff(upstreams, desk), ['P2P_URL', 'DEX_URL']);
  assert.deepEqual(edgeUpstreamsOff(upstreams, {}), []);
});
