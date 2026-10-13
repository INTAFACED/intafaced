import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeCbor, type CborValue } from './cbor.js';
import {
  ChallengeStore,
  SqlChallengeStore,
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  StoredWebAuthnCredential,
  b64urlDecode,
  b64urlEncode,
  buildAuthenticatorData,
  buildClientDataJSON,
  coseKeyFromJwk,
  createAuthenticationOptions,
  createRegistrationOptions,
  generateChallenge,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  WebAuthnError,
  type ChallengeKind,
} from './webauthn.js';

const config = {
  rpID: 'localhost',
  rpName: 'INTAFACED',
  origin: 'http://localhost:3000',
};

function makeKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string; kty: string; crv: string };
  const privateJwk = privateKey.export({ format: 'jwk' });
  return {
    privateKey: createPrivateKey({ key: privateJwk, format: 'jwk' }),
    publicKey: createPublicKey({ key: jwk, format: 'jwk' }),
    jwk,
    cose: coseKeyFromJwk(jwk),
  };
}

/**
 * Sign exactly like a real authenticator: WebAuthn ES256 assertion signatures
 * are ASN.1 DER (a SEQUENCE of two INTEGERs), never raw r||s. Signing in
 * P1363 here is what hid the real-device failure before.
 */
function signAssertion(privateKey: ReturnType<typeof createPrivateKey>, authData: Buffer, clientDataJSON: Buffer): Buffer {
  const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
  const signed = Buffer.concat([authData, clientDataHash]);
  return cryptoSign('SHA256', signed, { key: privateKey, dsaEncoding: 'der' });
}

/** The old (wrong) encoding, kept only to prove it is now refused. */
function signAssertionP1363(privateKey: ReturnType<typeof createPrivateKey>, authData: Buffer, clientDataJSON: Buffer): Buffer {
  const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
  return cryptoSign('SHA256', Buffer.concat([authData, clientDataHash]), { key: privateKey, dsaEncoding: 'ieee-p1363' });
}

function noneAttestation(authData: Buffer): Buffer {
  return Buffer.from(
    encodeCbor(
      new Map<unknown, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', new Uint8Array(authData)],
      ]),
    ),
  );
}

describe('base64url', () => {
  it('round-trips', () => {
    const raw = Buffer.from([0, 1, 2, 250, 255]);
    expect(b64urlDecode(b64urlEncode(raw)).equals(raw)).toBe(true);
  });
});

describe('ChallengeStore (in-memory)', () => {
  it('returns a matching challenge once, then never again', async () => {
    const store = new ChallengeStore(60_000);
    await store.put('registration', 'chal-1', 'user-1');
    expect(await store.take('chal-1', 'registration')).toMatchObject({ userId: 'user-1', kind: 'registration' });
    expect(await store.take('chal-1', 'registration')).toBeNull();
  });

  it('refuses a challenge used for the wrong ceremony', async () => {
    const store = new ChallengeStore(60_000);
    await store.put('registration', 'chal-2', 'user-1');
    expect(await store.take('chal-2', 'authentication')).toBeNull();
  });

  it('refuses an expired challenge and does not accept after TTL', async () => {
    const store = new ChallengeStore(60_000);
    await store.put('authentication', 'chal-exp', 'user-1', 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(await store.take('chal-exp', 'authentication')).toBeNull();
    expect(store.size).toBe(0);
  });

  it('accepts null userId (unknown authentication target)', async () => {
    const store = new ChallengeStore(60_000);
    await store.put('authentication', 'chal-null', null);
    expect(await store.take('chal-null', 'authentication')).toMatchObject({ userId: null, kind: 'authentication' });
  });
});

/**
 * In-memory stand-in for Postgres so SqlChallengeStore can be unit-tested
 * without a live database. Two store instances share the same map → multi-pod.
 */
function makeSharedChallengeSql() {
  type Row = { challenge: string; kind: ChallengeKind; user_id: string | null; expires_at: Date };
  const table = new Map<string, Row>();

  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim().toLowerCase();

      // DELETE expired (prune)
      if (text.startsWith('delete from webauthn_challenges where expires_at < now()')) {
        const now = Date.now();
        for (const [k, v] of table) {
          if (v.expires_at.getTime() < now) table.delete(k);
        }
        return [];
      }

      // take: DELETE … WHERE challenge = ? RETURNING …
      if (text.startsWith('delete from webauthn_challenges where challenge =')) {
        const challenge = values[0] as string;
        const row = table.get(challenge);
        if (!row) return [];
        table.delete(challenge);
        return [row];
      }

      // put: INSERT … ON CONFLICT
      if (text.startsWith('insert into webauthn_challenges')) {
        const challenge = values[0] as string;
        const kind = values[1] as ChallengeKind;
        const userId = values[2] as string | null;
        const expiresAt = values[3] as Date;
        table.set(challenge, { challenge, kind, user_id: userId, expires_at: expiresAt });
        return [];
      }

      throw new Error(`unexpected sql in mock: ${text}`);
    },
    { json: (v: unknown) => v },
  );

  return { sql: sql as unknown as import('postgres').Sql, table };
}

describe('SqlChallengeStore (shared backend — multi-pod simulation)', () => {
  it('put on instance A is takeable on instance B (same sql)', async () => {
    const { sql } = makeSharedChallengeSql();
    const a = new SqlChallengeStore(sql, 60_000);
    const b = new SqlChallengeStore(sql, 60_000);

    await a.put('registration', 'cross-pod-1', 'user-a');
    const held = await b.take('cross-pod-1', 'registration');
    expect(held).toMatchObject({ userId: 'user-a', kind: 'registration', challenge: 'cross-pod-1' });
    // single-use across pods
    expect(await a.take('cross-pod-1', 'registration')).toBeNull();
  });

  it('refuses wrong kind and expired; prunes on put', async () => {
    const { sql, table } = makeSharedChallengeSql();
    const store = new SqlChallengeStore(sql, 60_000);

    await store.put('step-up', 'kind-check', 'user-b');
    expect(await store.take('kind-check', 'authentication')).toBeNull();

    await store.put('authentication', 'ttl-check', 'user-b', 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(await store.take('ttl-check', 'authentication')).toBeNull();

    // prune drops expired leftovers
    table.set('stale', {
      challenge: 'stale',
      kind: 'registration',
      user_id: 'x',
      expires_at: new Date(Date.now() - 1000),
    });
    await store.put('registration', 'fresh', 'user-b');
    expect(table.has('stale')).toBe(false);
    expect(table.has('fresh')).toBe(true);
  });
});

describe('registration ceremony', () => {
  it('rejects duplicate attestation format and appended CBOR at the credential verifier', () => {
    const challenge = generateChallenge();
    const keys = makeKeyPair();
    const credId = randomBytes(16);
    const clientDataJSON = buildClientDataJSON({ type: 'webauthn.create', challenge, origin: config.origin });
    const authData = buildAuthenticatorData({
      rpID: config.rpID,
      counter: 0,
      credential: { id: credId, publicKeyCose: keys.cose },
    });
    const valid = noneAttestation(authData);
    const duplicate = Buffer.concat([
      Buffer.from([0xa4]),
      Buffer.from(encodeCbor('fmt')),
      Buffer.from(encodeCbor('packed')),
      valid.subarray(1),
    ]);
    const response = (attestation: Buffer): RegistrationResponseJSON => ({
      id: b64urlEncode(credId),
      rawId: b64urlEncode(credId),
      type: 'public-key',
      response: { clientDataJSON: b64urlEncode(clientDataJSON), attestationObject: b64urlEncode(attestation) },
    });
    expect(verifyRegistrationResponse(config, challenge, response(valid)).credentialId).toBe(b64urlEncode(credId));
    expect(() => verifyRegistrationResponse(config, challenge, response(duplicate))).toThrow(/duplicate map key/);
    expect(() => verifyRegistrationResponse(config, challenge, response(Buffer.concat([valid, Buffer.from([0])])))).toThrow(
      /trailing bytes/,
    );
  });

  it('accepts a well-formed none-attestation credential and returns a stored shape', () => {
    const challenge = generateChallenge();
    const keys = makeKeyPair();
    const credId = randomBytes(16);

    const clientDataJSON = buildClientDataJSON({
      type: 'webauthn.create',
      challenge,
      origin: config.origin,
    });
    const authData = buildAuthenticatorData({
      rpID: config.rpID,
      counter: 0,
      credential: { id: credId, publicKeyCose: keys.cose },
    });

    const response: RegistrationResponseJSON = {
      id: b64urlEncode(credId),
      rawId: b64urlEncode(credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        attestationObject: b64urlEncode(noneAttestation(authData)),
        transports: ['internal'],
      },
    };

    const stored = verifyRegistrationResponse(config, challenge, response);
    expect(stored.credentialId).toBe(b64urlEncode(credId));
    expect(stored.counter).toBe(0);
    expect(stored.transports).toEqual(['internal']);
    expect(stored.publicKey.length).toBeGreaterThan(16);
  });

  it('rejects a wrong challenge', () => {
    const keys = makeKeyPair();
    const credId = Buffer.alloc(16, 7);
    const clientDataJSON = buildClientDataJSON({
      type: 'webauthn.create',
      challenge: generateChallenge(),
      origin: config.origin,
    });
    const authData = buildAuthenticatorData({
      rpID: config.rpID,
      counter: 0,
      credential: { id: credId, publicKeyCose: keys.cose },
    });

    const response: RegistrationResponseJSON = {
      id: b64urlEncode(credId),
      rawId: b64urlEncode(credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        attestationObject: b64urlEncode(noneAttestation(authData)),
      },
    };

    expect(() => verifyRegistrationResponse(config, generateChallenge(), response)).toThrow(WebAuthnError);
  });

  it('rejects a foreign origin', () => {
    const challenge = generateChallenge();
    const keys = makeKeyPair();
    const credId = Buffer.alloc(16, 3);
    const clientDataJSON = buildClientDataJSON({
      type: 'webauthn.create',
      challenge,
      origin: 'https://evil.example',
    });
    const authData = buildAuthenticatorData({
      rpID: config.rpID,
      counter: 0,
      credential: { id: credId, publicKeyCose: keys.cose },
    });
    const response: RegistrationResponseJSON = {
      id: b64urlEncode(credId),
      rawId: b64urlEncode(credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        attestationObject: b64urlEncode(noneAttestation(authData)),
      },
    };
    expect(() => verifyRegistrationResponse(config, challenge, response)).toThrow(/origin/);
  });
});

describe('authentication ceremony', () => {
  function enrolled(): {
    keys: ReturnType<typeof makeKeyPair>;
    credential: StoredWebAuthnCredential;
    credId: Buffer;
  } {
    const keys = makeKeyPair();
    const credId = randomBytes(16);
    return {
      keys,
      credId,
      credential: {
        credentialId: b64urlEncode(credId),
        publicKey: b64urlEncode(keys.cose),
        counter: 1,
        createdAt: new Date().toISOString(),
      },
    };
  }

  it('accepts a valid assertion and returns the new counter', async () => {
    const { keys, credential, credId } = enrolled();
    const challenge = generateChallenge();
    const clientDataJSON = buildClientDataJSON({
      type: 'webauthn.get',
      challenge,
      origin: config.origin,
    });
    const authData = buildAuthenticatorData({ rpID: config.rpID, counter: 2 });
    const signature = signAssertion(keys.privateKey, authData, clientDataJSON);

    const response: AuthenticationResponseJSON = {
      id: b64urlEncode(credId),
      rawId: b64urlEncode(credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(signature),
      },
    };

    const result = await verifyAuthenticationResponse(config, challenge, credential, response);
    expect(result.newCounter).toBe(2);
  });

  it('rejects presence-only assertions (userVerification required)', async () => {
    const { keys, credential, credId } = enrolled();
    const challenge = generateChallenge();
    const clientDataJSON = buildClientDataJSON({
      type: 'webauthn.get',
      challenge,
      origin: config.origin,
    });
    const authData = buildAuthenticatorData({ rpID: config.rpID, counter: 2, userVerified: false });
    const signature = signAssertion(keys.privateKey, authData, clientDataJSON);
    const response: AuthenticationResponseJSON = {
      id: b64urlEncode(credId),
      rawId: b64urlEncode(credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(signature),
      },
    };
    await expect(verifyAuthenticationResponse(config, challenge, credential, response)).rejects.toThrow(/user verification/i);
  });

  it('rejects a signature from a different key', async () => {
    const { credential, credId } = enrolled();
    const impostor = makeKeyPair();
    const challenge = generateChallenge();
    const clientDataJSON = buildClientDataJSON({
      type: 'webauthn.get',
      challenge,
      origin: config.origin,
    });
    const authData = buildAuthenticatorData({ rpID: config.rpID, counter: 2 });
    const signature = signAssertion(impostor.privateKey, authData, clientDataJSON);

    const response: AuthenticationResponseJSON = {
      id: b64urlEncode(credId),
      rawId: b64urlEncode(credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(signature),
      },
    };

    await expect(verifyAuthenticationResponse(config, challenge, credential, response)).rejects.toThrow(/signature/);
  });

  it('rejects a counter that did not advance', async () => {
    const { keys, credential, credId } = enrolled();
    const challenge = generateChallenge();
    const clientDataJSON = buildClientDataJSON({
      type: 'webauthn.get',
      challenge,
      origin: config.origin,
    });
    // stored counter is 1; present 1 again
    const authData = buildAuthenticatorData({ rpID: config.rpID, counter: 1 });
    const signature = signAssertion(keys.privateKey, authData, clientDataJSON);
    const response: AuthenticationResponseJSON = {
      id: b64urlEncode(credId),
      rawId: b64urlEncode(credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(signature),
      },
    };
    await expect(verifyAuthenticationResponse(config, challenge, credential, response)).rejects.toThrow(/counter/);
  });
});

describe('authenticator extension boundaries', () => {
  const extension = Buffer.from(encodeCbor(new Map([['credProtect', 2]])));

  function fixture() {
    const keys = makeKeyPair();
    const id = randomBytes(16);
    const challenge = generateChallenge();
    const registrationClient = buildClientDataJSON({ type: 'webauthn.create', challenge, origin: config.origin });
    const registrationData = buildAuthenticatorData({ rpID: config.rpID, counter: 0, credential: { id, publicKeyCose: keys.cose } });
    const registration = (data: Buffer, fmt = 'none'): RegistrationResponseJSON => ({
      id: b64urlEncode(id),
      rawId: b64urlEncode(id),
      type: 'public-key',
      response: {
        clientDataJSON: b64urlEncode(registrationClient),
        attestationObject: b64urlEncode(
          encodeCbor(
            new Map<string, CborValue>([
              ['fmt', fmt],
              ['attStmt', new Map()],
              ['authData', new Uint8Array(data)],
            ]),
          ),
        ),
      },
    });
    const credential: StoredWebAuthnCredential = {
      credentialId: b64urlEncode(id),
      publicKey: b64urlEncode(keys.cose),
      counter: 0,
      createdAt: new Date().toISOString(),
    };
    const assertion = (data: Buffer): AuthenticationResponseJSON => {
      const client = buildClientDataJSON({ type: 'webauthn.get', challenge, origin: config.origin });
      return {
        id: b64urlEncode(id),
        rawId: b64urlEncode(id),
        type: 'public-key',
        response: {
          clientDataJSON: b64urlEncode(client),
          authenticatorData: b64urlEncode(data),
          signature: b64urlEncode(signAssertion(keys.privateKey, data, client)),
        },
      };
    };
    return { keys, challenge, registrationData, registration, credential, assertion };
  }

  function withExtensions(data: Buffer, suffix = extension): Buffer {
    const flagged = Buffer.from(data);
    flagged[32] = flagged[32]! | 0x80;
    return Buffer.concat([flagged, suffix]);
  }

  it('accepts standard ED registration and stores exactly the COSE key', () => {
    const f = fixture();
    const stored = verifyRegistrationResponse(config, f.challenge, f.registration(withExtensions(f.registrationData)));
    expect(b64urlDecode(stored.publicKey)).toEqual(f.keys.cose);
  });

  it('uses the encoded COSE boundary even when a key label has a wider integer encoding', async () => {
    const f = fixture();
    const cose = Buffer.concat([f.keys.cose.subarray(0, 1), Buffer.from([0x18, 0x01]), f.keys.cose.subarray(2)]);
    const data = buildAuthenticatorData({
      rpID: config.rpID,
      counter: 0,
      credential: { id: b64urlDecode(f.credential.credentialId), publicKeyCose: cose },
    });
    const stored = verifyRegistrationResponse(config, f.challenge, f.registration(withExtensions(data)));
    expect(b64urlDecode(stored.publicKey)).toEqual(cose);
    expect(
      (
        await verifyAuthenticationResponse(
          config,
          f.challenge,
          stored,
          f.assertion(buildAuthenticatorData({ rpID: config.rpID, counter: 1 })),
        )
      ).newCounter,
    ).toBe(1);
  });

  it('reads a previously stored key plus extension map without rewriting it', async () => {
    const f = fixture();
    const legacy = { ...f.credential, publicKey: b64urlEncode(Buffer.concat([f.keys.cose, extension])) };
    const snapshot = { ...legacy };
    const data = buildAuthenticatorData({ rpID: config.rpID, counter: 1 });
    expect((await verifyAuthenticationResponse(config, f.challenge, legacy, f.assertion(data))).newCounter).toBe(1);
    expect(legacy).toEqual(snapshot);
  });

  it('accepts a valid signed assertion carrying ED extensions with a key-only credential', async () => {
    const f = fixture();
    const data = withExtensions(buildAuthenticatorData({ rpID: config.rpID, counter: 1 }));
    expect((await verifyAuthenticationResponse(config, f.challenge, f.credential, f.assertion(data))).newCounter).toBe(1);
  });

  it.each([Buffer.alloc(0), Buffer.from([0x01]), Buffer.concat([extension, Buffer.from([0])]), Buffer.from([0xa1, 0x01, 0x02])])(
    'rejects missing, non-map, extra or nontext extension data in registration and signed assertion',
    async (suffix) => {
      const f = fixture();
      expect(() => verifyRegistrationResponse(config, f.challenge, f.registration(withExtensions(f.registrationData, suffix)))).toThrow(
        WebAuthnError,
      );
      const data = withExtensions(buildAuthenticatorData({ rpID: config.rpID, counter: 1 }), suffix);
      await expect(verifyAuthenticationResponse(config, f.challenge, f.credential, f.assertion(data))).rejects.toThrow(WebAuthnError);
    },
  );

  it('rejects extension bytes when ED is absent and attested data in an assertion', async () => {
    const f = fixture();
    expect(() => verifyRegistrationResponse(config, f.challenge, f.registration(Buffer.concat([f.registrationData, extension])))).toThrow(
      WebAuthnError,
    );
    const data = Buffer.concat([buildAuthenticatorData({ rpID: config.rpID, counter: 1 }), extension]);
    await expect(verifyAuthenticationResponse(config, f.challenge, f.credential, f.assertion(data))).rejects.toThrow(WebAuthnError);
    await expect(verifyAuthenticationResponse(config, f.challenge, f.credential, f.assertion(f.registrationData))).rejects.toThrow(
      WebAuthnError,
    );
  });

  it.each([
    Buffer.from([0]),
    Buffer.concat([extension, Buffer.from([0])]),
    Buffer.concat([extension, extension]),
    Buffer.from([0xa1, 0x01, 0x02]),
  ])('refuses legacy stored key suffixes that are not exactly one text-keyed extension map', async (suffix) => {
    const f = fixture();
    const stored = { ...f.credential, publicKey: b64urlEncode(Buffer.concat([f.keys.cose, suffix])) };
    const data = buildAuthenticatorData({ rpID: config.rpID, counter: 1 });
    await expect(verifyAuthenticationResponse(config, f.challenge, stored, f.assertion(data))).rejects.toThrow(WebAuthnError);
  });

  it('keeps packed attestation unsupported with valid extension boundaries', () => {
    const f = fixture();
    expect(() => verifyRegistrationResponse(config, f.challenge, f.registration(withExtensions(f.registrationData), 'packed'))).toThrow(
      /not accepted/,
    );
  });

  it.each([
    Buffer.from('a2617801617802', 'hex'),
    Buffer.from('a161ff01', 'hex'),
    Buffer.concat([Buffer.from('a16178', 'hex'), Buffer.alloc(33, 0x81), Buffer.from([0])]),
  ])('retains duplicate-key, UTF-8 and depth refusal for every extension reader', async (suffix) => {
    const f = fixture();
    expect(() => verifyRegistrationResponse(config, f.challenge, f.registration(withExtensions(f.registrationData, suffix)))).toThrow(
      WebAuthnError,
    );
    const data = withExtensions(buildAuthenticatorData({ rpID: config.rpID, counter: 1 }), suffix);
    await expect(verifyAuthenticationResponse(config, f.challenge, f.credential, f.assertion(data))).rejects.toThrow(WebAuthnError);
    const legacy = { ...f.credential, publicKey: b64urlEncode(Buffer.concat([f.keys.cose, suffix])) };
    await expect(
      verifyAuthenticationResponse(config, f.challenge, legacy, f.assertion(buildAuthenticatorData({ rpID: config.rpID, counter: 1 }))),
    ).rejects.toThrow(WebAuthnError);
  });
});

describe('real-device-style ES256 assertion (ASN.1 DER)', () => {
  /**
   * Fixed vector. No recorded hardware capture exists in this repo, so this was
   * generated once with node:crypto (fresh P-256 key, ECDSA-SHA256, DER output
   * of 71 bytes — a length the old raw r||s reader could never accept) over a
   * Touch-ID-shaped authenticatorData (UP+UV flags, counter 7, no extensions)
   * for rpID intafaced.com / origin https://app.intafaced.com. Signing is
   * randomised, so the signature is recorded here instead of regenerated.
   */
  const vector = {
    rpID: 'intafaced.com',
    origin: 'https://app.intafaced.com',
    x: 'RmYxpCizHcuyurMIcq2627sWtmYTmqtcKVv7Rl8wFWw',
    y: 'jASu8IndVNwfRsO51_LRn8-v2jCC9ANa79Ews91O29w',
    challenge: 'aW50YWZhY2VkLWZpeGVkLXRlc3QtdmVjdG9yLWNoYWxsZW5nZS0wMQ',
    credId: 'ASNFZ4mrze8BI0VniavN7w',
    clientDataJSON:
      'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiYVc1MFlXWmhZMlZrTFdacGVHVmtMWFJsYzNRdGRtVmpkRzl5TFdOb1lXeHNaVzVuWlMwd01RIiwib3JpZ2luIjoiaHR0cHM6Ly9hcHAuaW50YWZhY2VkLmNvbSIsImNyb3NzT3JpZ2luIjpmYWxzZX0',
    authenticatorData: 'HaTt62pe30GzJLrVfiRu_dksUs8EKGiBx4-jvqTSsFIFAAAABw',
    signature: 'MEUCIQDM9_8VaJDSCMw2RonCtoTKeHh5kUUcVPxItBf2LqE5KwIgTACoTerJ3EMGl4UO5n47RxtpLzjlvKEfBc3xg3WgMwg',
  };
  const vectorConfig = { rpID: vector.rpID, rpName: 'INTAFACED', origin: vector.origin };
  const credential = (counter = 6): StoredWebAuthnCredential => ({
    credentialId: vector.credId,
    publicKey: b64urlEncode(coseKeyFromJwk({ x: vector.x, y: vector.y })),
    counter,
    createdAt: '2026-10-13T00:00:00.000Z',
  });
  const response = (over: Partial<AuthenticationResponseJSON['response']> = {}): AuthenticationResponseJSON => ({
    id: vector.credId,
    rawId: vector.credId,
    type: 'public-key',
    response: {
      clientDataJSON: vector.clientDataJSON,
      authenticatorData: vector.authenticatorData,
      signature: vector.signature,
      ...over,
    },
  });

  it('the recorded signature really is DER, not raw r||s', () => {
    const sig = b64urlDecode(vector.signature);
    expect(sig[0]).toBe(0x30);
    expect(sig.length).not.toBe(64);
  });

  it('accepts the recorded DER assertion and returns its counter', async () => {
    await expect(verifyAuthenticationResponse(vectorConfig, vector.challenge, credential(), response())).resolves.toEqual({
      newCounter: 7,
    });
  });

  it('refuses a replay of the same assertion once the counter is stored', async () => {
    await expect(verifyAuthenticationResponse(vectorConfig, vector.challenge, credential(7), response())).rejects.toMatchObject({
      code: 'webauthn.counter',
    });
  });

  it('refuses the vector from a different origin or relying party', async () => {
    await expect(
      verifyAuthenticationResponse({ ...vectorConfig, origin: 'https://evil.example' }, vector.challenge, credential(), response()),
    ).rejects.toMatchObject({ code: 'webauthn.origin' });
    await expect(
      verifyAuthenticationResponse({ ...vectorConfig, rpID: 'other.example' }, vector.challenge, credential(), response()),
    ).rejects.toMatchObject({ code: 'webauthn.invalid' });
  });

  it('refuses a tampered signature and a wrong challenge', async () => {
    const sig = Buffer.from(b64urlDecode(vector.signature));
    sig[sig.length - 1] = (sig[sig.length - 1] ?? 0) ^ 0x01;
    await expect(
      verifyAuthenticationResponse(vectorConfig, vector.challenge, credential(), response({ signature: b64urlEncode(sig) })),
    ).rejects.toThrow(WebAuthnError);
    await expect(verifyAuthenticationResponse(vectorConfig, 'another-challenge', credential(), response())).rejects.toMatchObject({
      code: 'webauthn.challenge',
    });
  });

  it('refuses a raw r||s (P1363) signature: that encoding is not WebAuthn', async () => {
    const keys = makeKeyPair();
    const credId = randomBytes(16);
    const stored: StoredWebAuthnCredential = {
      credentialId: b64urlEncode(credId),
      publicKey: b64urlEncode(keys.cose),
      counter: 0,
      createdAt: new Date().toISOString(),
    };
    const challenge = generateChallenge();
    const clientDataJSON = buildClientDataJSON({ type: 'webauthn.get', challenge, origin: config.origin });
    const authData = buildAuthenticatorData({ rpID: config.rpID, counter: 1 });
    const make = (signature: Buffer): AuthenticationResponseJSON => ({
      id: b64urlEncode(credId),
      rawId: b64urlEncode(credId),
      type: 'public-key',
      response: {
        clientDataJSON: b64urlEncode(clientDataJSON),
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(signature),
      },
    });
    await expect(
      verifyAuthenticationResponse(config, challenge, stored, make(signAssertionP1363(keys.privateKey, authData, clientDataJSON))),
    ).rejects.toThrow(WebAuthnError);
    await expect(
      verifyAuthenticationResponse(config, challenge, stored, make(signAssertion(keys.privateKey, authData, clientDataJSON))),
    ).resolves.toEqual({ newCounter: 1 });
  });

  it('accepts a passkey that always reports counter 0 (iCloud Keychain, Touch ID)', async () => {
    const keys = makeKeyPair();
    const credId = randomBytes(16);
    const stored: StoredWebAuthnCredential = {
      credentialId: b64urlEncode(credId),
      publicKey: b64urlEncode(keys.cose),
      counter: 0,
      createdAt: new Date().toISOString(),
    };
    const challenge = generateChallenge();
    const clientDataJSON = buildClientDataJSON({ type: 'webauthn.get', challenge, origin: config.origin });
    const authData = buildAuthenticatorData({ rpID: config.rpID, counter: 0 });
    await expect(
      verifyAuthenticationResponse(config, challenge, stored, {
        id: b64urlEncode(credId),
        rawId: b64urlEncode(credId),
        type: 'public-key',
        response: {
          clientDataJSON: b64urlEncode(clientDataJSON),
          authenticatorData: b64urlEncode(authData),
          signature: b64urlEncode(signAssertion(keys.privateKey, authData, clientDataJSON)),
        },
      }),
    ).resolves.toEqual({ newCounter: 0 });
  });
});

describe('options builders', () => {
  it('exclude already-registered credentials on registration', async () => {
    const existing: StoredWebAuthnCredential[] = [
      { credentialId: 'abc', publicKey: 'pk', counter: 0, createdAt: new Date().toISOString(), transports: ['usb'] },
    ];
    const opts = createRegistrationOptions(
      config,
      { id: '11111111-1111-4111-8111-111111111111', name: 'alice', displayName: 'Alice' },
      existing,
      'chal',
    );
    expect(opts.excludeCredentials).toEqual([{ type: 'public-key', id: 'abc', transports: ['usb'] }]);
    expect(opts.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
    expect(opts.attestation).toBe('none');
  });

  it('lists allowCredentials on authentication', async () => {
    const opts = createAuthenticationOptions(
      config,
      [{ credentialId: 'xyz', publicKey: 'pk', counter: 0, createdAt: new Date().toISOString() }],
      'chal',
    );
    expect(opts.allowCredentials).toEqual([{ type: 'public-key', id: 'xyz' }]);
    expect(opts.rpId).toBe('localhost');
  });
});
