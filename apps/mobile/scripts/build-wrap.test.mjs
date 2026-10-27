import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, cpSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./build-wrap.mjs', import.meta.url));
const verify = (origin) =>
  spawnSync(process.execPath, [script, '--verify'], {
    env: { ...process.env, MOBILE_CUSTOMER_ORIGIN: origin },
    encoding: 'utf8',
  });
const mobile = dirname(dirname(script));
const customerDist = fileURLToPath(new URL('../../customer/dist/', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const cliConfig = join(dirname(require.resolve('@capacitor/cli/package.json')), 'dist/config.js');
const cli = join(dirname(cliConfig), '../bin/capacitor');

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options);
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('native staging refuses an absent API/customer origin before touching assets', () => {
  const result = verify('');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MOBILE_CUSTOMER_ORIGIN.*required/);
});

test('native staging refuses an unreachable HTTPS deployment', () => {
  const result = verify('https://127.0.0.1:1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verify.*customer deployment/);
});

test('native staging rejects unsafe origins without making HTTP requests', () => {
  for (const origin of [
    'http://localhost:8090',
    'https://name:secret@customer.invalid',
    'https://customer.invalid/bank',
    'https://customer.invalid?x=1',
    'https://customer.invalid#x',
  ]) {
    const result = verify(origin);
    assert.equal(result.status, 1, origin);
    assert.match(result.stderr, /HTTPS origin/);
  }
});

test(
  'verified HTTPS React deployment stages assets and the actual Capacitor loader binds the same origin',
  {
    skip:
      process.env.MOBILE_STAGING_SMOKE !== '1' &&
      'Set MOBILE_STAGING_SMOKE=1 after building apps/customer for the production-bundle/native-copy smoke',
  },
  async () => {
    const temp = mkdtempSync(join(tmpdir(), 'intafaced-native-stage-'));
    const key = join(temp, 'key.pem'),
      cert = join(temp, 'cert.pem');
    const generated = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        key,
        '-out',
        cert,
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(generated.status, 0, generated.stderr);
    assert.ok(existsSync(join(customerDist, 'index.html')), 'build apps/customer first');
    let mode = 'react';
    const requests = [];
    const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      requests.push(req.url);
      if (mode === 'redirect') {
        res.writeHead(302, { location: 'https://different.invalid/' });
        res.end();
        return;
      }
      if (req.url === '/customer-deployment.json') {
        res.setHeader('content-type', 'application/json');
        res.end(mode === 'legacy' ? '{"frontend":"vue"}' : readFileSync(join(customerDist, 'customer-deployment.json')));
      } else {
        res.setHeader('content-type', 'text/html');
        res.end(readFileSync(join(customerDist, 'index.html')));
      }
    });
    await new Promise((resolve) => server.listen(0, 'localhost', resolve));
    const origin = `https://localhost:${server.address().port}`;
    const env = { ...process.env, MOBILE_CUSTOMER_ORIGIN: origin, NODE_EXTRA_CA_CERTS: cert };
    const output = join(temp, 'native/www');
    try {
      const result = await run([script, '--output', output], { env });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(requests, ['/customer-deployment.json', '/', '/bank/transfers']);
      assert.deepEqual(readFileSync(join(output, 'index.html')), readFileSync(join(customerDist, 'index.html')));
      assert.ok(existsSync(join(output, 'native-unavailable.html')));
      const receipt = JSON.parse(readFileSync(join(output, 'native-stage.json')));
      assert.equal(receipt.customerOrigin, origin);
      const before = readFileSync(join(output, 'native-stage.json'));
      mode = 'legacy';
      const legacy = await run([script, '--output', output], { env });
      assert.equal(legacy.status, 1);
      assert.match(legacy.stderr, /not the React customer deployment/);
      assert.deepEqual(readFileSync(join(output, 'native-stage.json')), before);
      mode = 'redirect';
      assert.equal((await run([script, '--verify'], { env })).status, 1);

      // Use the installed Capacitor loader, with an isolated native project.
      const fixture = join(temp, 'native');
      for (const file of ['capacitor.config.js', 'capacitor.config.json', 'package.json']) cpSync(join(mobile, file), join(fixture, file));
      mkdirSync(join(fixture, 'scripts'));
      cpSync(join(mobile, 'scripts/native-origin.cjs'), join(fixture, 'scripts/native-origin.cjs'));
      symlinkSync(join(mobile, 'node_modules'), join(fixture, 'node_modules'), 'dir');
      const loader = `require(${JSON.stringify(cliConfig)}).loadConfig().then(c=>console.log(JSON.stringify(c.app.extConfig)))`;
      const loaded = await run(['-e', loader], { env, cwd: fixture });
      assert.equal(loaded.status, 0, loaded.stderr);
      const config = JSON.parse(loaded.stdout);
      assert.equal(config.appId, 'app.intafaced.mobile');
      assert.deepEqual(config.server, { url: origin, cleartext: false, errorPath: 'native-unavailable.html' });
      cpSync(join(mobile, 'android'), join(fixture, 'android'), { recursive: true });
      cpSync(join(mobile, 'ios'), join(fixture, 'ios'), { recursive: true });
      const copied = await run([cli, 'copy'], { env, cwd: fixture });
      assert.equal(copied.status, 0, copied.stderr + copied.stdout);
      for (const path of ['android/app/src/main/assets/capacitor.config.json', 'ios/App/App/capacitor.config.json']) {
        const platform = JSON.parse(readFileSync(join(fixture, path)));
        assert.equal(platform.appId, 'app.intafaced.mobile');
        assert.equal(platform.server.url, origin);
        assert.equal(platform.server.cleartext, false);
      }
      for (const path of ['android/app/src/main/assets/public/index.html', 'ios/App/App/public/index.html']) {
        assert.deepEqual(readFileSync(join(fixture, path)), readFileSync(join(customerDist, 'index.html')));
      }
      const wrong = await run(['-e', loader], { env: { ...env, MOBILE_CUSTOMER_ORIGIN: 'https://other.invalid' }, cwd: fixture });
      assert.equal(wrong.status, 1);
      assert.match(wrong.stderr + wrong.stdout, /does not match/);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test('native targets hold the phone floor the light look needs (iOS 16.4, Android web view 111)', () => {
  const read = (path) => readFileSync(join(mobile, path), 'utf8');
  assert.match(read('ios/App/Podfile'), /platform :ios, '16\.4'/);
  const targets = read('ios/App/App.xcodeproj/project.pbxproj').match(/IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;/g);
  assert.deepEqual([...new Set(targets)], ['IPHONEOS_DEPLOYMENT_TARGET = 16.4;']);
  assert.equal(JSON.parse(read('capacitor.config.json')).android.minWebViewVersion, 111);
  assert.match(read('native-unavailable.html'), /iOS 16\.4.*web view at version 111/);
});
