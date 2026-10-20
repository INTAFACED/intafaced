import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceSigner, createServiceVerifier, type Keyring } from '@intafaced/contracts';
import {
  EmptyAcademyCurriculumSource,
  FixedAcademyCurriculumSource,
  createAcademyCurriculumSource,
  parseAcademyCurriculumPayload,
} from './academy-curriculum-source.js';

const SECRET = 'an-agents-curriculum-source-test-secret-32';
const SPINE = [{ slug: 'foundations-risk-first', title: 'Risk first' }];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseAcademyCurriculumPayload — never invent titles', () => {
  it('reads slug+title from an items envelope', () => {
    expect(parseAcademyCurriculumPayload({ items: SPINE })).toEqual({
      items: SPINE,
      licensedLibraryImported: false,
    });
  });

  it('reads a raw summary array (academy catalog shape)', () => {
    expect(parseAcademyCurriculumPayload([{ slug: 'foundations-risk-first', title: 'Risk first', kind: 'playbook' }])).toEqual({
      items: SPINE,
      licensedLibraryImported: false,
    });
  });

  it('drops rows missing slug or title rather than filling them in', () => {
    expect(parseAcademyCurriculumPayload({ items: [{ slug: 'x' }, { title: 'Y' }, SPINE[0]] })).toEqual({
      items: SPINE,
      licensedLibraryImported: false,
    });
  });

  it('empty items stay empty — chatbot refuse, not a guessed library', () => {
    expect(parseAcademyCurriculumPayload({ items: [] })).toEqual({ items: [], licensedLibraryImported: false });
  });

  it('unreadable payload is empty, and licensed dump is never claimed from the wire', () => {
    expect(parseAcademyCurriculumPayload({ licensedLibraryImported: true, catalog: SPINE })).toEqual({
      items: [],
      licensedLibraryImported: false,
    });
  });
});

describe('Fixed / Empty sources', () => {
  it('EmptyAcademyCurriculumSource is an empty catalog', async () => {
    expect(await new EmptyAcademyCurriculumSource().load()).toEqual({ items: [], licensedLibraryImported: false });
  });

  it('FixedAcademyCurriculumSource returns injected spine with licensed false', async () => {
    expect(await new FixedAcademyCurriculumSource(SPINE).load()).toEqual({
      items: SPINE,
      licensedLibraryImported: false,
    });
  });
});

describe('createAcademyCurriculumSource — fail closed', () => {
  it('GETs /internal/curriculum with service credentials', async () => {
    let seenUrl = '';
    let seen: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seenUrl = url;
        seen = init.headers as Record<string, string>;
        return new Response(JSON.stringify({ items: SPINE }), { status: 200 });
      }),
    );

    const grounding = await createAcademyCurriculumSource('http://svc-academy:4016/', SECRET).load();
    expect(seenUrl).toBe('http://svc-academy:4016/internal/curriculum');
    expect(Object.keys(seen).some((k) => k.toLowerCase().includes('service'))).toBe(true);
    expect(grounding.items).toEqual(SPINE);
    expect(grounding.licensedLibraryImported).toBe(false);
  });

  it('401 (unsigned / forbidden) is empty catalog, not invented titles', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    );
    const grounding = await createAcademyCurriculumSource('http://svc-academy:4016', SECRET).load();
    expect(grounding).toEqual({ items: [], licensedLibraryImported: false });
  });

  it('empty academy catalog stays empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
    );
    const grounding = await createAcademyCurriculumSource('http://svc-academy:4016', SECRET).load();
    expect(grounding.items).toEqual([]);
  });

  it('transport failure is empty catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const grounding = await createAcademyCurriculumSource('http://svc-academy:4016', SECRET).load();
    expect(grounding).toEqual({ items: [], licensedLibraryImported: false });
  });
});

describe('createAcademyCurriculumSource — signs with svc-agents own key when it has one', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyring: Keyring = [
    {
      kid: 'svc-agents.a',
      svc: 'svc-agents',
      use: 's2s',
      x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    },
  ];
  const signer = createServiceSigner({
    service: 'svc-agents',
    kid: 'svc-agents.a',
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    keyring,
  });

  function capture() {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({ items: SPINE }), { status: 200 });
    }) as typeof fetch;
    return { seen, fetchImpl };
  }

  it('dual: sends a key-signed call that svc-academy would accept, beside the shared-secret form', async () => {
    const { seen, fetchImpl } = capture();
    const grounding = await createAcademyCurriculumSource('http://svc-academy:4016/', SECRET, fetchImpl, { signer, mode: 'dual' }).load();
    expect(grounding.items).toEqual(SPINE);
    const { headers, url } = seen[0]!;
    const target = new URL(url);
    const verdict = createServiceVerifier({ self: 'svc-academy', keyring, bootSecond: 0 }).verify({
      method: 'GET',
      url: target.pathname + target.search,
      headers,
      rawBody: { retained: true, bytes: Buffer.alloc(0) },
    });
    expect(verdict).toMatchObject({ status: 'accepted', service: 'svc-agents' });
    expect(headers['x-intafaced-service-sig']).toBeDefined();
  });

  it('keypair: sends no shared-secret form at all', async () => {
    const { seen, fetchImpl } = capture();
    await createAcademyCurriculumSource('http://svc-academy:4016', SECRET, fetchImpl, { signer, mode: 'keypair' }).load();
    expect(seen[0]!.headers['x-intafaced-s2s-sig']).toBeDefined();
    expect(Object.keys(seen[0]!.headers).some((h) => h.startsWith('x-intafaced-service'))).toBe(false);
  });

  it('a transport failure is still the empty catalog', async () => {
    const fetchImpl = (async () => {
      throw new Error('socket hang up');
    }) as typeof fetch;
    const grounding = await createAcademyCurriculumSource('http://svc-academy:4016', SECRET, fetchImpl, { signer, mode: 'dual' }).load();
    expect(grounding).toEqual({ items: [], licensedLibraryImported: false });
  });

  it('without a signer it is exactly the shared-secret call', async () => {
    const { seen, fetchImpl } = capture();
    await createAcademyCurriculumSource('http://svc-academy:4016', SECRET, fetchImpl).load();
    expect(Object.keys(seen[0]!.headers).some((h) => h.startsWith('x-intafaced-s2s'))).toBe(false);
    expect(seen[0]!.headers['x-intafaced-service']).toBe('svc-agents');
  });
});
