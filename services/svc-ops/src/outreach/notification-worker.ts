import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { crmSubmissionSchema, guestNotificationSendInputSchema, type GuestNotificationReceipt } from '@intafaced/contracts';
import { OutreachNotificationError, type OutreachNotificationPort } from './notification-client.js';
import { privacyReadLock } from './privacy.js';

const retryableRefusals = new Set(['guest.notification_unconfigured', 'guest.configuration_unverified', 'guest.address_rate_limited']);

/** Durable ingress retries use the same immutable business key. Notify owns provider-attempt uncertainty. */
export class OutreachNotificationWorker {
  constructor(
    private readonly sql: Sql,
    private readonly notify: OutreachNotificationPort,
  ) {}

  async runOnce(): Promise<boolean> {
    if (!this.notify.configured) return false;
    const claimed = await transaction(
      this.sql,
      async (tx) => {
        await privacyReadLock(tx);
        const rows = await tx`SELECT * FROM ops.crm_outbox WHERE status IN ('pending','unconfigured')
        AND NOT EXISTS (SELECT 1 FROM ops.crm_erasure_intents e WHERE ops.crm_outbox.submission_id=ANY(e.submission_ids))
        AND retry_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
        ORDER BY retry_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        const row = rows[0];
        if (!row) return null;
        let wire: unknown = row.dispatch_payload;
        if (!wire) {
          const submissions = await tx`SELECT record FROM ops.crm_submissions WHERE id=${row.submission_id}`;
          const original = crmSubmissionSchema.parse(submissions[0]?.record);
          wire = {
            businessKey: row.business_key,
            contactId: original.contactId,
            submissionId: original.submissionId,
            recipientEmail: original.contact.email,
            message: { kind: 'enquiry_acknowledgement' },
          };
          if (row.kind !== 'enquiry_acknowledgement') throw new Error('ops.crm.dispatch_payload_missing');
        }
        const input = guestNotificationSendInputSchema.parse(wire),
          token = randomUUID();
        await tx`UPDATE ops.crm_outbox SET dispatch_payload=${tx.json(input)},lease_token=${token},
        lease_until=clock_timestamp()+interval '10 seconds',attempts=attempts+1,updated_at=clock_timestamp() WHERE id=${row.id}`;
        return { id: String(row.id), token, input, attempts: Number(row.attempts) };
      },
      { isolation: 'read committed' },
    );
    if (!claimed) return false;
    let receipt: GuestNotificationReceipt | null = null;
    let failureCode: string | null = null;
    try {
      if (claimed.attempts > 0) receipt = await this.notify.get(claimed.input.businessKey);
      if (receipt === null || (receipt.status === 'refused' && receipt.code !== null && retryableRefusals.has(receipt.code))) {
        receipt = null;
        receipt = await this.notify.send(claimed.input);
      }
    } catch (error) {
      if (error instanceof OutreachNotificationError) failureCode = error.code;
      /* The next ingress retry must retain the exact original wire. */
    }
    let status = 'pending',
      code: string | null = 'ops.crm.notification_acceptance_unknown',
      reference: string | null = null;
    let delay = 5;
    if (failureCode) {
      code = failureCode;
      if (failureCode === 'guest.request_conflict' || failureCode === 'guest.submission_erased') status = 'failed';
      if (failureCode === 'guest.notification_unconfigured' || failureCode === 'guest.configuration_unverified') status = 'unconfigured';
      delay = 60;
    }
    if (receipt) {
      code = receipt.code;
      if (receipt.status === 'accepted') {
        status = 'accepted';
        reference = receipt.reference;
      }
      if (receipt.status === 'unresolved') status = 'unresolved';
      if (receipt.status === 'refused') {
        status = 'failed';
        if (receipt.code === 'guest.notification_unconfigured' || receipt.code === 'guest.configuration_unverified')
          status = 'unconfigured';
        if (receipt.code === 'guest.address_rate_limited') status = 'pending';
        delay = 60;
      }
    }
    await this.sql`UPDATE ops.crm_outbox SET status=${status},error_code=${code},acceptance_ref=${reference},
      notification_receipt=${receipt ? this.sql.json(receipt) : null},lease_token=NULL,lease_until=NULL,
      retry_at=clock_timestamp()+${delay}*interval '1 second',updated_at=clock_timestamp()
      WHERE id=${claimed.id} AND lease_token=${claimed.token}`;
    return true;
  }
}
