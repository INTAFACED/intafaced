import { randomUUID } from 'node:crypto';
import type { QuotaGate } from '../quota/quota.js';
import {
  grantActive,
  lockLive,
  type StoredCollaborator,
  type StoredGrant,
  type StoredLock,
  type StoredRead,
  type TeamRepository,
} from './repository.js';

/** The in-memory store unit tests use. The race at the plan limit is proven on Postgres (team.pg.test.ts). */
export function createMemoryTeamRepository(gate?: QuotaGate): TeamRepository {
  const members: StoredCollaborator[] = [];
  const locks = new Map<string, StoredLock>();
  const grants: StoredGrant[] = [];
  const reads: StoredRead[] = [];
  const find = (strategyId: string, memberId: string) =>
    members.findIndex((row) => row.strategyId === strategyId && row.memberId === memberId);
  return {
    async collaborators(strategyId) {
      return members.filter((row) => row.strategyId === strategyId);
    },
    async membership({ strategyId, memberId }) {
      return members[find(strategyId, memberId)] ?? null;
    },
    async sharedWith(memberId) {
      return members.filter((row) => row.memberId === memberId);
    },
    async upsert(input) {
      const at = input.at.toISOString();
      const index = find(input.strategyId, input.memberId);
      if (index >= 0) {
        const row = { ...members[index]!, role: input.role, liveControl: input.liveControl, updatedAt: at };
        members[index] = row;
        return row;
      }
      if (gate) {
        const used = BigInt(members.filter((row) => row.strategyId === input.strategyId).length);
        await gate.check(null, input.ownerId, [{ resource: 'collaborators', used, adding: 1n }]);
      }
      const row: StoredCollaborator = {
        strategyId: input.strategyId,
        ownerId: input.ownerId,
        memberId: input.memberId,
        role: input.role,
        liveControl: input.liveControl,
        addedAt: at,
        updatedAt: at,
      };
      members.push(row);
      return row;
    },
    async remove({ strategyId, memberId }) {
      const index = find(strategyId, memberId);
      if (index >= 0) members.splice(index, 1);
      if (locks.get(strategyId)?.holderId === memberId) locks.delete(strategyId);
    },
    async mostCollaborators(ownerId) {
      const per = new Map<string, number>();
      for (const row of members) if (row.ownerId === ownerId) per.set(row.strategyId, (per.get(row.strategyId) ?? 0) + 1);
      return BigInt(Math.max(0, ...per.values()));
    },
    async lock(strategyId) {
      return locks.get(strategyId) ?? null;
    },
    async takeLock({ strategyId, holderId, at, ttlMs }) {
      const held = locks.get(strategyId) ?? null;
      if (lockLive(held, at) && held.holderId !== holderId) return { taken: false, lock: held };
      const lock = { strategyId, holderId, takenAt: at.toISOString(), expiresAt: new Date(at.getTime() + ttlMs).toISOString() };
      locks.set(strategyId, lock);
      return { taken: true, lock };
    },
    async releaseLock({ strategyId, holderId }) {
      if (locks.get(strategyId)?.holderId === holderId) locks.delete(strategyId);
    },
    async grants(strategyId) {
      return grants.filter((row) => row.strategyId === strategyId).reverse();
    },
    async createGrant({ strategyId, ownerId, key, at, seconds }) {
      const prior = grants.find((row) => row.ownerId === ownerId && row.key === key);
      if (prior) return prior;
      const row: StoredGrant = {
        id: randomUUID(),
        strategyId,
        ownerId,
        key,
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + seconds * 1000).toISOString(),
      };
      grants.push(row);
      return row;
    },
    async recordRead({ strategyId, reader, at }) {
      const active = grants.filter((row) => row.strategyId === strategyId && grantActive(row, at)).at(-1) ?? null;
      reads.push({ strategyId, grantId: active?.id ?? null, reader, granted: active !== null, readAt: at.toISOString() });
      return active;
    },
    async reads(strategyId) {
      return reads.filter((row) => row.strategyId === strategyId);
    },
  };
}
