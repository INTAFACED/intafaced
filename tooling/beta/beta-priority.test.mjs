// The hosted beta runs ahead of builders on the shared box (#11062): its units carry a CPU and IO weight above anything
// a builder runs (T3's agents sit in app-t3code.slice at weight 10, other user services at systemd's default 100), and
// the beta's own service declares the memory it keeps under pressure. The supervisor keeps them so on every round,
// so a box installed before this change takes them with the next move to main, with no restart of the beta.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BETA_PRIORITY, betaPaths, frontUnitText, syncPriority, tunnelDropInText, unitText } from './beta-host.mjs';

/** The value one `Key=` line sets in a unit's text, or null. */
const setting = (text, key) => new RegExp(`^${key}=(.+)$`, 'm').exec(text)?.[1] ?? null;

test('the beta, its front and its tunnel each carry a CPU and IO weight of 1000, ten times a default service', () => {
  const paths = betaPaths('/home/x');
  assert.deepEqual(BETA_PRIORITY, { CPUWeight: '1000', IOWeight: '1000' });
  for (const [name, text] of [
    ['beta', unitText(paths)],
    ['front', frontUnitText(paths)],
    ['tunnel drop-in', tunnelDropInText()],
  ]) {
    assert.equal(setting(text, 'CPUWeight'), '1000', `${name}: CPUWeight`);
    assert.equal(setting(text, 'IOWeight'), '1000', `${name}: IOWeight`);
    // Each weight sits in the [Service] section, where systemd reads it.
    assert.ok(text.indexOf('[Service]') < text.indexOf('CPUWeight='), `${name}: in [Service]`);
    assert.ok(!/^\[Install\]/m.test(text.slice(text.indexOf('[Service]'), text.indexOf('CPUWeight='))), name);
  }
  assert.equal(setting(unitText(paths), 'MemoryLow'), '2G', "the beta's stack keeps 2G under memory pressure");
  // No setting a user manager may refuse at exec time (a negative Nice, a lower OOM score): the beta must still start.
  for (const text of [unitText(paths), frontUnitText(paths), tunnelDropInText()]) {
    assert.doesNotMatch(text, /^(Nice|OOMScoreAdjust|CPUSchedulingPolicy)=/m);
  }
});

test('syncPriority writes the beta unit and the tunnel drop-in when they differ, reloads once, and restarts nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-priority-'));
  const paths = betaPaths(dir);
  const calls = [];
  const systemctl = (...args) => (calls.push(args.join(' ')), { status: 0 });

  assert.deepEqual(syncPriority(paths, systemctl), [], 'nothing installed: nothing written');
  assert.deepEqual(calls, []);

  fs.mkdirSync(path.dirname(paths.unit), { recursive: true });
  fs.writeFileSync(paths.unit, '[Service]\nExecStart=/bin/true\n');
  fs.writeFileSync(paths.tunnelUnit, '[Service]\nExecStart=/home/x/.local/bin/cloudflared tunnel run\n');
  assert.deepEqual(syncPriority(paths, systemctl), [paths.unit, paths.tunnelDropIn]);
  assert.equal(fs.readFileSync(paths.unit, 'utf8'), unitText(paths));
  assert.equal(fs.readFileSync(paths.tunnelDropIn, 'utf8'), tunnelDropInText());
  assert.equal(
    fs.readFileSync(paths.tunnelUnit, 'utf8'),
    '[Service]\nExecStart=/home/x/.local/bin/cloudflared tunnel run\n',
    "the tunnel's own unit, written by hand with its secrets' paths, is left as it is",
  );
  assert.deepEqual(calls.splice(0), ['daemon-reload'], 'a reload applies the weights to the running units');

  assert.deepEqual(syncPriority(paths, systemctl), [], 'already so: nothing written');
  assert.deepEqual(calls, []);
});
