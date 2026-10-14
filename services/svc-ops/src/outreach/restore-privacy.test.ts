import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase } from '@intafaced/db';
import { describe, expect, it } from 'vitest';
import { migrateOutreach } from '../db/migrate.js';
import { OutreachCrm } from './crm.js';
import type { OutreachNotificationPort } from './notification-client.js';
import { exportErasureArchive, applyErasureArchive, reapplyCompletedErasures } from './restore-privacy.js';

const execute = promisify(execFile);
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('owned pg_dump/pg_restore and privacy reconciliation', () => {
  it('restores original decimals, aliases, tasks, audit and outbox; reapplies later erasures before restored data is served', async () => {
    const source = await createTestDatabase({ service: 'ops' }),
      destination = await createTestDatabase({ service: 'ops' }),
      directory = await mkdtemp(join(tmpdir(), 'intafaced-owned-restore-'));
    try {
      await migrateOutreach(source.sql);
      const founders: [string, string] = [randomUUID(), randomUUID()];
      const config = {
        founders,
        initialOwnerUserId: founders[0],
        continuationTtlSeconds: 3600,
        timeZone: 'Asia/Makassar',
        businessWeekdays: [1, 2, 3, 4, 5],
        reviewHour: 9,
        reviewMinute: 15,
      };
      const notify: OutreachNotificationPort = {
        configured: true,
        send: async () => null,
        get: async () => null,
        eraseSubmission: async (input) => ({ ...input, erasedCount: 1, erasedAt: new Date().toISOString() }),
      };
      const crm = new OutreachCrm(source.sql, config, undefined, notify);
      const capture = async (email: string) => {
        const input = {
          requestId: randomUUID(),
          continuationToken: randomBytes(32).toString('base64url'),
          contact: { name: 'Restore prospect', email, interests: ['investor' as const], marketingOptIn: false },
        };
        const receipt = await crm.capture(input, randomUUID());
        const opportunity = (await crm.listOpportunities({ limit: 100 })).items.find((o) => o.submissionId === receipt.submissionId)!;
        return { input, receipt, opportunity };
      };
      const a = await capture('erase-a@example.test'),
        b = await capture('erase-b@example.test'),
        other = await capture('keep@example.test');
      await crm.answer(
        {
          requestId: randomUUID(),
          submissionId: a.receipt.submissionId,
          continuationToken: a.input.continuationToken,
          expectedRevision: 1,
          questionnaire: {
            audience: 'investor',
            version: 1,
            answers: {
              investorType: 'individual',
              participation: 'direct',
              decisionRole: 'decision_maker',
              indicativeContribution: { status: 'stated', amount: '999999999999999.000000000000000001', currency: 'USD' },
              timing: 'later',
            },
          },
        },
        randomUUID(),
      );
      await crm.mergeContacts(
        {
          requestId: randomUUID(),
          sourceContactId: a.opportunity.contactId,
          targetContactId: b.opportunity.contactId,
          sourceExpectedRevision: 1,
          targetExpectedRevision: 1,
          confirmed: true,
          reason: 'Restore original evidence',
        },
        founders[0],
      );
      await crm.addNote({ requestId: randomUUID(), opportunityId: a.opportunity.id, note: 'Original operator note' }, founders[0]);
      const exportRequest = { requestId: randomUUID(), limit: 100 };
      await crm.exportSubmissions(exportRequest, founders[0]);
      const snapshots = new Map<string, unknown>();
      for (const table of [
        'crm_contacts',
        'crm_submissions',
        'crm_contact_aliases',
        'crm_contact_merges',
        'crm_tasks',
        'crm_activities',
        'crm_workflow_audit',
        'crm_requests',
        'crm_outbox',
      ])
        snapshots.set(table, await source.sql.unsafe(`SELECT to_jsonb(t) AS row FROM ops.${table} t ORDER BY to_jsonb(t)::text`));
      const dump = join(directory, 'ops.dump');
      await execute('pg_dump', ['--dbname', source.url, '--format=custom', '--schema=ops', '--no-owner', '--no-acl', '--file', dump], {
        timeout: 20000,
      });
      await execute(
        'pg_restore',
        ['--dbname', destination.url, '--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', dump],
        { timeout: 20000 },
      );
      for (const [table, rows] of snapshots)
        expect(await destination.sql.unsafe(`SELECT to_jsonb(t) AS row FROM ops.${table} t ORDER BY to_jsonb(t)::text`)).toEqual(rows);
      const restored = new OutreachCrm(destination.sql, config, undefined, notify);
      expect(
        (await restored.resume({ submissionId: a.receipt.submissionId, continuationToken: a.input.continuationToken }, randomUUID()))
          .questionnaires[0],
      ).toMatchObject({ answers: { indicativeContribution: { amount: '999999999999999.000000000000000001', currency: 'USD' } } });
      const preview = await crm.privacy.preview({ canonicalContactId: b.opportunity.contactId }, founders[0]);
      let intent = await crm.privacy.begin(
        {
          requestId: randomUUID(),
          canonicalContactId: preview.canonicalContactId,
          expectedCanonicalRevision: preview.canonicalRevision,
          snapshot: preview.snapshot,
          confirmedEntireCluster: true,
          reason: 'confirmed_privacy_request',
        },
        founders[0],
      );
      const pendingArchive = await exportErasureArchive(source.sql);
      await applyErasureArchive(destination.sql, pendingArchive);
      expect((await restored.privacy.status({ intentId: intent.intentId }, founders[0])).status).toBe('pending_notify');
      await expect(
        restored.resume({ submissionId: a.receipt.submissionId, continuationToken: a.input.continuationToken }, randomUUID()),
      ).rejects.toMatchObject({ code: 'ops.crm.continuation_invalid' });
      while (intent.status !== 'complete')
        intent = await crm.privacy.advance(
          { requestId: randomUUID(), intentId: intent.intentId, expectedRevision: intent.revision },
          founders[0],
        );
      const archive = await exportErasureArchive(source.sql);
      expect(JSON.stringify(archive)).not.toContain('erase-a@example.test');
      await applyErasureArchive(destination.sql, archive);
      await applyErasureArchive(destination.sql, archive);
      await expect(applyErasureArchive(destination.sql, pendingArchive)).rejects.toThrow('ops.crm.restore_tombstone_conflict');
      await reapplyCompletedErasures(destination.sql);
      expect((await destination.sql`SELECT count(*)::int AS count FROM ops.crm_contacts`)[0]?.count).toBe(1);
      expect((await restored.privacy.status({ intentId: intent.intentId }, founders[0])).status).toBe('complete');
      await expect(restored.exportSubmissions(exportRequest, founders[0])).rejects.toMatchObject({ code: 'ops.crm.request_erased' });
      await expect(
        restored.resume({ submissionId: a.receipt.submissionId, continuationToken: a.input.continuationToken }, randomUUID()),
      ).rejects.toMatchObject({ code: 'ops.crm.continuation_invalid' });
      expect(
        (
          await restored.resume(
            { submissionId: other.receipt.submissionId, continuationToken: other.input.continuationToken },
            randomUUID(),
          )
        ).contact.email,
      ).toBe('keep@example.test');
      await expect(destination.sql`DELETE FROM ops.crm_activities`).rejects.toMatchObject({ message: 'ops.crm.activity_immutable' });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await destination.drop();
      await source.drop();
    }
  }, 30000);
  it('applies a current system erasure archive to an older actual dump before restored originals or mail can be used', async () => {
    const source = await createTestDatabase({ service: 'ops' }),
      destination = await createTestDatabase({ service: 'ops' }),
      directory = await mkdtemp(join(tmpdir(), 'intafaced-retention-restore-'));
    try {
      await migrateOutreach(source.sql);
      const founders: [string, string] = [randomUUID(), randomUUID()];
      const config = {
        founders,
        initialOwnerUserId: founders[0],
        continuationTtlSeconds: 2592000,
        timeZone: 'Asia/Makassar',
        businessWeekdays: [1, 2, 3, 4, 5],
        reviewHour: 9,
        reviewMinute: 15,
        retention: { publishedPolicy: 'six_calendar_months_v1', automationEnabled: true },
      };
      let now = new Date('2024-08-31T09:15:00Z');
      const notify: OutreachNotificationPort = {
        configured: true,
        send: async () => null,
        get: async () => null,
        eraseSubmission: async (input) => ({ ...input, erasedCount: 1, erasedAt: now.toISOString() }),
      };
      const crm = new OutreachCrm(source.sql, config, () => now, notify);
      const input = {
        requestId: randomUUID(),
        continuationToken: randomBytes(32).toString('base64url'),
        contact: {
          name: 'Labelled retention restore fixture',
          email: 'system-erase@example.test',
          interests: ['investor' as const],
          marketingOptIn: false,
        },
      };
      const captured = await crm.capture(input, randomUUID());
      const opportunity = (await crm.listOpportunities({ limit: 100 })).items[0]!;
      await crm.privacy.retentionReview(
        {
          requestId: randomUUID(),
          canonicalContactId: opportunity.contactId,
          expectedCanonicalRevision: 1,
          expectedReviewRevision: 0,
          state: 'inactive',
          evidenceRef: 'fixture-inactive-review',
          reason: 'Private review must not survive deletion',
        },
        founders[0],
      );
      const dump = join(directory, 'outreach.dump');
      await execute('pg_dump', ['--dbname', source.url, '--format=custom', '--schema=ops', '--no-owner', '--no-acl', '--file', dump], {
        timeout: 20000,
      });
      await execute(
        'pg_restore',
        ['--dbname', destination.url, '--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', dump],
        { timeout: 20000 },
      );
      now = new Date('2025-02-28T09:15:00Z');
      await crm.privacy.runRetentionOnce();
      const pending = await exportErasureArchive(source.sql);
      expect(pending.intents[0]).toMatchObject({ actorKind: 'system', actorUserId: null, status: 'pending_notify' });
      await applyErasureArchive(destination.sql, pending);
      const restored = new OutreachCrm(destination.sql, config, () => now, notify);
      await expect(restored.capture(input, randomUUID())).rejects.toMatchObject({ code: 'ops.crm.continuation_invalid' });
      await expect(
        restored.queueMessage(
          {
            requestId: randomUUID(),
            opportunityId: opportunity.id,
            expectedRevision: 1,
            kind: 'follow_up',
            staffText: 'Must remain frozen',
            reason: 'Fixture',
          },
          founders[0],
        ),
      ).rejects.toMatchObject({ code: 'ops.crm.erasure_pending' });
      await crm.privacy.runRetentionOnce();
      const completed = await exportErasureArchive(source.sql);
      expect(completed.intents[0]).toMatchObject({ actorKind: 'system', actorUserId: null, status: 'complete' });
      await applyErasureArchive(destination.sql, completed);
      await applyErasureArchive(destination.sql, completed);
      await expect(applyErasureArchive(destination.sql, pending)).rejects.toThrow('ops.crm.restore_tombstone_conflict');
      expect(await restored.getOpportunity({ opportunityId: opportunity.id })).toBeNull();
      expect((await restored.listOpportunities({ limit: 100 })).items).toHaveLength(0);
      await expect(
        restored.resume({ submissionId: captured.submissionId, continuationToken: input.continuationToken }, randomUUID()),
      ).rejects.toMatchObject({ code: 'ops.crm.continuation_invalid' });
      await expect(
        restored.privacy.retentionReviewStatus({ canonicalContactId: opportunity.contactId }, founders[0]),
      ).rejects.toMatchObject({ code: 'ops.crm.contact_erased' });
      expect(await destination.sql`SELECT id FROM ops.crm_retention_reviews`).toHaveLength(0);
      expect(await destination.sql`SELECT id FROM ops.crm_outbox`).toHaveLength(0);
      const tampered = { ...completed, intents: completed.intents.map((i) => ({ ...i, actorUserId: founders[0] })) };
      await expect(applyErasureArchive(destination.sql, tampered)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
      await destination.drop();
      await source.drop();
    }
  }, 30000);
});
