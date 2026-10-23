/**
 * MC-blueprint-01. A share per card, who opened it, and revoke at once.
 * Open-log retention is not swept here: no refusal code names a window, and none is invented.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { BlueprintProfile } from '@intafaced/contracts';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { UnconfiguredCardRenderer, type CardRenderer } from './card/card-renderer.js';
import { BlueprintError, BlueprintService } from './blueprint-service.js';
import { MockNeuralEngine } from './engine/mock-engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const OWNER = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';
const MATE = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';
const CREW = '55555555-5555-4555-8555-555555555555';
const MISSING = '66666666-6666-4666-8666-666666666666';

const profile: BlueprintProfile = {
  decisionStyle: 'analytical',
  riskTemperament: 'measured',
  energyRhythm: 'steady',
  learningMode: 'systematic',
  crewRole: 'anchor',
  curriculumPath: 'foundations',
  toneRegister: 'direct',
  guardrails: { maxLeverage: 1, dailyLossPromptPct: 5, confirmBeforeMarketOrder: true, copyTradingVisible: false },
};

const raw = process.env.TEST_DATABASE_URL;
const available = raw ? await postgresAvailable(raw) : await postgresAvailable();

if (!available) {
  describe.skip('MC-blueprint-01 card shares (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'blueprint', ...(raw ? { url: raw } : {}), migrations });

  const service = (limits: { sharesPerOwner?: number; opensListLimit?: number } = { sharesPerOwner: 2, opensListLimit: 20 }) =>
    new BlueprintService(db.sql, new MockNeuralEngine(), new MemoryEventBus('svc-blueprint'), new UnconfiguredCardRenderer(), {
      crewCapacity: 4,
      mentorShortlistSize: 3,
      season: 1,
      ...limits,
    });

  async function seed(visibility: 'private' | 'crew' | 'public', userId = OWNER): Promise<void> {
    await db.sql`
      INSERT INTO blueprint.blueprints (user_id, engine_version, profile, visibility)
      VALUES (${userId}, 'test', ${db.sql.json(profile)}, ${visibility})
    `;
  }

  async function sameCrew(userIds: readonly string[]): Promise<void> {
    await db.sql`
      INSERT INTO blueprint.crews (id, name, season, capacity) VALUES (${CREW}, 'TEST crew', 1, 6)
    `;
    for (const userId of userIds) {
      await db.sql`
        INSERT INTO blueprint.crew_members (crew_id, user_id, role) VALUES (${CREW}, ${userId}, 'anchor')
      `;
    }
  }

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.truncateAll();
  });

  describe('card shares (MC-blueprint-01)', () => {
    it('creates one share, counts a second open on the same row, and returns no account id', async () => {
      await seed('public');
      const blueprint = service();
      const share = await blueprint.createShare({ userId: OWNER, size: 'portrait' });
      expect(share.state).toBe('active');
      expect(await blueprint.createShare({ userId: OWNER, size: 'portrait' })).toMatchObject({ id: share.id });

      const card = await blueprint.cardFor({ viewerId: VIEWER, shareId: share.id, size: 'landscape' });
      expect(card.size).toBe('portrait');
      expect(card.width).toBe(1080);
      await blueprint.cardFor({ viewerId: VIEWER, shareId: share.id, size: 'portrait' });

      const openers = await blueprint.shareOpeners({ userId: OWNER, shareId: share.id });
      expect(openers).toEqual([expect.objectContaining({ kind: 'signed-in account', openCount: 2 })]);
      expect(JSON.stringify(openers)).not.toContain(VIEWER);
      const rows = await db.sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM blueprint.card_opens WHERE share_id = ${share.id}
      `;
      expect(rows[0]?.n).toBe(1);

      const exported = await blueprint.export({ userId: OWNER });
      expect(exported.shares).toHaveLength(1);
      expect(exported.shares[0]?.openers).toHaveLength(1);
      expect(JSON.stringify(exported.shares)).not.toContain(VIEWER);
    });

    it('names a crew member when the viewer shares a crew', async () => {
      await seed('crew');
      await seed('crew', MATE);
      await sameCrew([OWNER, MATE]);
      const blueprint = service();
      const share = await blueprint.createShare({ userId: OWNER, size: 'portrait' });
      await blueprint.cardFor({ viewerId: MATE, shareId: share.id, size: 'portrait' });
      expect(await blueprint.shareOpeners({ userId: OWNER, shareId: share.id })).toEqual([
        expect.objectContaining({ kind: 'crew member', openCount: 1 }),
      ]);
    });

    it('refuses a viewer the visibility rule excludes and writes no open row', async () => {
      await seed('private');
      const blueprint = service();
      const share = await blueprint.createShare({ userId: OWNER, size: 'portrait' });
      await expect(blueprint.cardFor({ viewerId: VIEWER, shareId: MISSING, size: 'portrait' })).rejects.toMatchObject({
        code: 'blueprint.not_found',
        message: 'No Blueprint to render a card for — run the Blueprint session first',
      });
      await expect(blueprint.cardFor({ viewerId: VIEWER, shareId: share.id, size: 'portrait' })).rejects.toMatchObject({
        code: 'blueprint.not_found',
        message: 'No Blueprint to render a card for — run the Blueprint session first',
      });
      const opens = await db.sql`SELECT 1 FROM blueprint.card_opens WHERE share_id = ${share.id}`;
      expect(opens).toHaveLength(0);
    });

    it('revoke is idempotent and the next read, including one already waiting, is not found', async () => {
      await seed('public');
      const blueprint = service();
      const share = await blueprint.createShare({ userId: OWNER, size: 'portrait' });
      await blueprint.cardFor({ viewerId: VIEWER, shareId: share.id, size: 'portrait' });

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = db.sql.begin(async (tx) => {
        await tx`SELECT id FROM blueprint.card_shares WHERE id = ${share.id} FOR UPDATE`;
        locked();
        await gate;
      });
      await held;

      const revoking = blueprint.revokeShare({ userId: OWNER, shareId: share.id });
      const probe = postgres(db.url, { max: 1, onnotice: () => undefined });
      const deadline = Date.now() + 3_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const rows = await probe<Array<{ ok: number }>>`
          SELECT 1 AS ok FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query ILIKE '%card_shares%' AND pid <> pg_backend_pid()
           LIMIT 1
        `;
        if (rows[0]) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);

      const reading = blueprint.cardFor({ viewerId: STRANGER, shareId: share.id, size: 'portrait' });
      release();
      await holder;
      const revoked = await revoking;
      await expect(reading).rejects.toMatchObject({ code: 'blueprint.not_found' });
      expect(await blueprint.revokeShare({ userId: OWNER, shareId: share.id })).toMatchObject({
        state: 'revoked',
        revokedAt: revoked.revokedAt,
      });
      const opens = await db.sql<Array<{ open_count: number }>>`
        SELECT open_count FROM blueprint.card_opens WHERE share_id = ${share.id}
      `;
      expect(opens).toEqual([{ open_count: 1 }]);
      await probe.end({ timeout: 1 });
    });

    it('hides another account share and refuses a blank limit before writing', async () => {
      await seed('public');
      const blueprint = service();
      const share = await blueprint.createShare({ userId: OWNER, size: 'portrait' });
      await expect(blueprint.shareOpeners({ userId: VIEWER, shareId: share.id })).rejects.toMatchObject({
        code: 'blueprint.not_found',
      });
      await expect(blueprint.revokeShare({ userId: VIEWER, shareId: share.id })).rejects.toMatchObject({
        code: 'blueprint.not_found',
      });

      const unset = service({});
      await expect(unset.createShare({ userId: OWNER, size: 'landscape' })).rejects.toMatchObject({
        code: 'blueprint.share_limit_unset',
      });
      await expect(unset.shareOpeners({ userId: OWNER, shareId: share.id })).rejects.toMatchObject({
        code: 'blueprint.opens_list_limit_unset',
      });
      const sizes = await db.sql<Array<{ size: string }>>`
        SELECT size FROM blueprint.card_shares WHERE owner_user_id = ${OWNER} ORDER BY size
      `;
      expect(sizes.map((row) => row.size)).toEqual(['portrait']);
    });

    it('refuses a second active size once the published cap is full', async () => {
      await seed('public');
      const blueprint = service({ sharesPerOwner: 1, opensListLimit: 20 });
      await blueprint.createShare({ userId: OWNER, size: 'portrait' });
      await expect(blueprint.createShare({ userId: OWNER, size: 'landscape' })).rejects.toBeInstanceOf(BlueprintError);
      await expect(blueprint.createShare({ userId: OWNER, size: 'landscape' })).rejects.toMatchObject({
        code: 'blueprint.share_limit_reached',
      });
    });

    it('fails the read closed when the open row cannot be written', async () => {
      await seed('public');
      const blueprint = service();
      const share = await blueprint.createShare({ userId: OWNER, size: 'portrait' });
      await db.sql`
        CREATE OR REPLACE FUNCTION blueprint.mc_blueprint_01_fail_open() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'open log refused'; END $$
      `;
      await db.sql`
        CREATE TRIGGER mc_blueprint_01_fail_open
        BEFORE INSERT ON blueprint.card_opens
        FOR EACH ROW EXECUTE FUNCTION blueprint.mc_blueprint_01_fail_open()
      `;
      try {
        await expect(blueprint.cardFor({ viewerId: VIEWER, shareId: share.id, size: 'portrait' })).rejects.toMatchObject({
          code: 'blueprint.open_log_unavailable',
        });
      } finally {
        await db.sql`DROP TRIGGER IF EXISTS mc_blueprint_01_fail_open ON blueprint.card_opens`;
        await db.sql`DROP FUNCTION IF EXISTS blueprint.mc_blueprint_01_fail_open()`;
      }
      expect(await db.sql`SELECT 1 FROM blueprint.card_opens WHERE share_id = ${share.id}`).toHaveLength(0);
    });

    it('a revoke that commits after the open insert would have been written, and before the response, returns blueprint.not_found and leaves no open row', async () => {
      await seed('public');
      const opening = service();
      const share = await opening.createShare({ userId: OWNER, size: 'portrait' });
      // The share is FOR UPDATE for the whole read, so another connection cannot
      // commit a revoke until this transaction ends. The trigger revokes in that
      // same transaction, after the open insert and before the response. The
      // re-read must roll the open back. rendered proves the insert ran first.
      let rendered = false;
      const renderer: CardRenderer = {
        id: 'revoke-during-open',
        async rasterize() {
          rendered = true;
          return {
            status: 'unavailable',
            code: 'blueprint.card_renderer_unconfigured',
            reason: 'Share revoked during render',
          };
        },
      };
      const blueprint = new BlueprintService(db.sql, new MockNeuralEngine(), new MemoryEventBus('svc-blueprint'), renderer, {
        crewCapacity: 4,
        mentorShortlistSize: 3,
        season: 1,
        sharesPerOwner: 2,
        opensListLimit: 20,
      });
      await db.sql`DROP TRIGGER IF EXISTS mc_blueprint_01_revoke_during_open ON blueprint.card_opens`;
      await db.sql`DROP FUNCTION IF EXISTS blueprint.mc_blueprint_01_revoke_during_open()`;
      await db.sql`
        CREATE FUNCTION blueprint.mc_blueprint_01_revoke_during_open() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE blueprint.card_shares
             SET revoked_at = now()
           WHERE id = NEW.share_id AND revoked_at IS NULL;
          RETURN NEW;
        END $$
      `;
      await db.sql`
        CREATE TRIGGER mc_blueprint_01_revoke_during_open
        AFTER INSERT ON blueprint.card_opens
        FOR EACH ROW EXECUTE FUNCTION blueprint.mc_blueprint_01_revoke_during_open()
      `;
      try {
        await expect(blueprint.cardFor({ viewerId: VIEWER, shareId: share.id, size: 'portrait' })).rejects.toMatchObject({
          code: 'blueprint.not_found',
          message: 'No Blueprint to render a card for — run the Blueprint session first',
        });
      } finally {
        await db.sql`DROP TRIGGER IF EXISTS mc_blueprint_01_revoke_during_open ON blueprint.card_opens`;
        await db.sql`DROP FUNCTION IF EXISTS blueprint.mc_blueprint_01_revoke_during_open()`;
      }
      expect(rendered).toBe(true);
      expect(await db.sql`SELECT 1 FROM blueprint.card_opens WHERE share_id = ${share.id}`).toHaveLength(0);
      const stored = await db.sql<Array<{ revoked_at: Date | null }>>`
        SELECT revoked_at FROM blueprint.card_shares WHERE id = ${share.id}
      `;
      expect(stored[0]?.revoked_at).toBeNull();
    });

    it('exports the shares, then erase removes the viewer row and the owner shares', async () => {
      await seed('public');
      await seed('public', VIEWER);
      const blueprint = service();
      const share = await blueprint.createShare({ userId: OWNER, size: 'portrait' });
      await blueprint.cardFor({ viewerId: VIEWER, shareId: share.id, size: 'portrait' });
      expect((await blueprint.export({ userId: OWNER })).shares[0]?.openCount).toBe(1);

      const viewerReceipt = await blueprint.erase({ userId: VIEWER });
      expect(viewerReceipt.removed.cardOpens).toBe(1);
      expect(await blueprint.shareOpeners({ userId: OWNER, shareId: share.id })).toEqual([]);

      const ownerReceipt = await blueprint.erase({ userId: OWNER });
      expect(ownerReceipt.removed.shares).toBe(1);
      expect(await db.sql`SELECT 1 FROM blueprint.card_shares WHERE owner_user_id = ${OWNER}`).toHaveLength(0);
      expect(await db.sql`SELECT 1 FROM blueprint.card_opens`).toHaveLength(0);
    });
  });
}
