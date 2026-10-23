import { QUANT_SHARE_SEQ_STALE, QuantError } from '../errors.js';
import {
  resultShareKey,
  type ShareCreateInput,
  type ShareLink,
  type ShareOpenInput,
  type ShareOpened,
  type ShareRepository,
} from './repository.js';
import { newShareToken, shareHashEquals, shareTokenHash } from './token.js';

interface ReadMark {
  readonly bucket: string;
  readonly atMs: number;
}

/**
 * In-memory share links for tests and for a router that was not given a database. Production passes Postgres.
 * One chain of work, so two creates of the same run cannot both become active.
 */
export function createMemoryShareRepository(): ShareRepository {
  const links: ShareLink[] = [];
  const reads: ReadMark[] = [];
  let tail: Promise<void> = Promise.resolve();

  function lock<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function ofRun(accountId: string, runId: string): ShareLink[] {
    return links.filter((link) => link.accountId === accountId && link.runId === runId);
  }

  return {
    async list(input) {
      return ofRun(input.accountId, input.runId).map((link) => ({ ...link }));
    },

    create(input) {
      return lock(async () => createOne(links, input));
    },

    revoke(input) {
      return lock(async () => {
        const index = links.findIndex(
          (link) => link.accountId === input.accountId && link.runId === input.runId && link.revokedAt === null,
        );
        if (index >= 0) {
          const current = links[index]!;
          links[index] = { ...current, revokedAt: input.now };
        }
        return { links: ofRun(input.accountId, input.runId).length };
      });
    },

    async matchActive(input) {
      const presented = shareTokenHash(input.token);
      const active = ofRun(input.accountId, input.runId).find((link) => link.revokedAt === null) ?? null;
      const matches = shareHashEquals(active?.tokenHash ?? null, presented);
      return matches && active ? { ...active } : null;
    },

    openPublic(input) {
      return lock(async () => openOne(links, reads, input));
    },
  };
}

function createOne(links: ShareLink[], input: ShareCreateInput) {
  const rows = links.filter((link) => link.accountId === input.accountId && link.runId === input.runId);
  const key = resultShareKey(input.runId, input.seq);
  const existing = rows.find((link) => link.key === key);
  if (existing) return { link: { ...existing }, links: rows.length, token: null };
  const active = rows.find((link) => link.revokedAt === null);
  if (active) return { link: { ...active }, links: rows.length, token: null };
  if (input.seq !== rows.length) {
    throw new QuantError(QUANT_SHARE_SEQ_STALE, 'seq — the number of links the screen read is not the number stored');
  }
  const token = newShareToken();
  const link: ShareLink = {
    runId: input.runId,
    accountId: input.accountId,
    seq: input.seq,
    key,
    tokenHash: shareTokenHash(token),
    createdAt: input.now,
    revokedAt: null,
  };
  links.push(link);
  return { link: { ...link }, links: rows.length + 1, token };
}

function openOne(links: ShareLink[], reads: ReadMark[], input: ShareOpenInput): ShareOpened {
  const presented = shareTokenHash(input.token);
  const active = links.find((link) => link.revokedAt === null && shareHashEquals(link.tokenHash, presented)) ?? null;
  const bucket = active ? active.tokenHash : 'unknown';
  const from = input.nowMs - input.windowMs;
  const kept = reads.filter((mark) => mark.atMs >= from);
  reads.length = 0;
  reads.push(...kept);
  const used = reads.filter((mark) => mark.bucket === bucket).length;
  if (used >= input.rate) return { kind: 'limited' };
  reads.push({ bucket, atMs: input.nowMs });
  return active ? { kind: 'ok', link: { ...active } } : { kind: 'missing' };
}
