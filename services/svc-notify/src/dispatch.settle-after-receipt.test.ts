import { describe, expect, it } from 'vitest';
import { InAppChannel, UnconfiguredChannel } from './channels/gateway.js';
import { ChannelRegistry } from './channels/registry.js';
import { ChannelDeliveryError, type DeliveryReceipt, type NotificationChannel, type OutboundMessage } from './channels/channel.js';
import { MemoryDeliveryStore, MemoryTargetStore, type NoteReceiptInput, type SettleInput } from './channel-store.js';
import { NotificationDispatcher } from './dispatch.js';
import type { Notification } from './store.js';

/**
 * A gateway receipt and the row that records it are different writes.
 *
 * `attempt` claims, asks the adapter to deliver, then settles `accepted`.
 * If the settle throws after the adapter has already returned a receipt, that
 * error is a bookkeeping failure. Recording it as a transport failure releases
 * the claim, and the next pass sends the same message again.
 */

const USER = 'user-1';
const RECEIPT = 'gw-receipt-1';

class EmailChannel implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly unavailableReason = null;
  readonly sent: OutboundMessage[] = [];

  constructor(private readonly reference: string | null = RECEIPT) {}

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    this.sent.push(message);
    return { reference: this.reference };
  }
}

/** Gateway was down. No receipt. */
class FlakyEmail implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly unavailableReason = null;
  readonly sent: OutboundMessage[] = [];

  async deliver(message: OutboundMessage): Promise<DeliveryReceipt> {
    this.sent.push(message);
    throw new ChannelDeliveryError('email', 'gateway responded 503', { retryable: true, status: 503 });
  }
}

/**
 * The first email `noteReceipt` throws before the row changes.
 * A later call persists the handle the gateway already returned.
 */
class EmailNoteThrowsBeforeWrite extends MemoryDeliveryStore {
  private thrown = false;

  override async noteReceipt(input: NoteReceiptInput): Promise<void> {
    const row = (await this.listRecent(20)).find((r) => r.id === input.id);
    if (row?.channel === 'email' && !this.thrown) {
      this.thrown = true;
      throw new Error('receipt row write failed');
    }
    await super.noteReceipt(input);
  }
}

/** Every email `noteReceipt` throws before the row changes. */
class EmailNoteNeverLands extends MemoryDeliveryStore {
  override async noteReceipt(input: NoteReceiptInput): Promise<void> {
    const row = (await this.listRecent(20)).find((r) => r.id === input.id);
    if (row?.channel === 'email') throw new Error('receipt row write failed');
    await super.noteReceipt(input);
  }
}

/**
 * Email `noteReceipt` never writes. The first accepted settle for `needle`
 * throws before the row changes. The next one persists.
 */
class EmailNoteNeverLandsSettleMissesOnce extends EmailNoteNeverLands {
  private thrown = false;

  constructor(
    opts: { leaseMs?: number; now?: () => Date },
    private readonly needle: string | null,
  ) {
    super(opts);
  }

  override async settle(input: SettleInput): Promise<void> {
    if (!this.thrown && input.status === 'accepted' && input.reference === this.needle) {
      this.thrown = true;
      throw new Error('accepted row write failed');
    }
    await super.settle(input);
  }
}

/** The email receipt is on the row, then the client sees a throw. Later calls persist. */
class EmailNoteWritesThenThrows extends MemoryDeliveryStore {
  private thrown = false;

  override async noteReceipt(input: NoteReceiptInput): Promise<void> {
    const row = (await this.listRecent(20)).find((r) => r.id === input.id);
    await super.noteReceipt(input);
    if (row?.channel === 'email' && !this.thrown) {
      this.thrown = true;
      throw new Error('receipt row write failed after commit');
    }
  }
}

/** The first `accepted` settle whose reference matches `needle` throws. Later ones persist. */
class AcceptedSettleFailsOnce extends MemoryDeliveryStore {
  private thrown = false;

  constructor(
    opts: { leaseMs?: number; now?: () => Date },
    private readonly needle: string | null,
  ) {
    super(opts);
  }

  override async settle(input: SettleInput): Promise<void> {
    if (!this.thrown && input.status === 'accepted' && input.reference === this.needle) {
      this.thrown = true;
      throw new Error('accepted row write failed');
    }
    await super.settle(input);
  }
}

function notification(): Notification {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: USER,
    kind: 'trade.fill',
    severity: 'info',
    titleKey: 'notify.trade.fill.title',
    bodyKey: 'notify.trade.fill.body',
    params: { side: 'buy', qty: '1', marketId: 'BTC-USDT', price: '61000.00' },
    href: null,
    readAt: null,
    sourceSubject: 'intafaced.trade.fill.settled',
    sourceIdempotencyKey: 'fill-1',
    createdAt: new Date(),
  } as Notification;
}

describe('a settle error after a receipt is not a second send', () => {
  it('finishes the accepted row on the next pass and does not deliver again', async () => {
    let nowMs = 1_000_000;
    const deliveries = new AcceptedSettleFailsOnce({ leaseMs: 10_000, now: () => new Date(nowMs) }, RECEIPT);
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: 'a'.repeat(64),
      verifyExpiresAt: new Date(nowMs + 60_000),
    });
    await targets.markVerified(USER, 'email', 'a'.repeat(64), new Date(nowMs));

    const email = new EmailChannel();
    const dispatcher = new NotificationDispatcher(
      new ChannelRegistry([
        new InAppChannel(),
        email,
        new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
        new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
      ]),
      targets,
      deliveries,
      { maxAttempts: 1, outOfAppEnabled: true },
    );
    const note = notification();

    const first = await dispatcher.dispatch(note);
    const emailOutcome = first.outcomes.find((o) => o.channel === 'email');
    expect(email.sent).toHaveLength(1);
    expect(emailOutcome?.retryable).toBe(true);
    expect(emailOutcome?.code).toBeNull();

    const afterThrow = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(afterThrow?.status).toBe('pending');
    expect(afterThrow?.reference).toBe(RECEIPT);
    expect(afterThrow?.acceptedAt).toBeNull();
    expect(afterThrow?.refusalCode).toBeNull();

    // The lease is dead. A pending row with no receipt would be reclaimed and sent again.
    nowMs += 10_001;
    const second = await dispatcher.dispatch(note);

    expect(email.sent).toHaveLength(1);
    expect(second.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'accepted',
      retryable: false,
      code: null,
    });
    const settled = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(settled?.status).toBe('accepted');
    expect(settled?.reference).toBe(RECEIPT);
    expect(settled?.acceptedAt).not.toBeNull();
    expect(second.retry).toBe(false);
  });

  it('keeps a null transport handle null and still does not deliver again', async () => {
    let nowMs = 1_000_000;
    const deliveries = new AcceptedSettleFailsOnce({ leaseMs: 10_000, now: () => new Date(nowMs) }, null);
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: 'b'.repeat(64),
      verifyExpiresAt: new Date(nowMs + 60_000),
    });
    await targets.markVerified(USER, 'email', 'b'.repeat(64), new Date(nowMs));

    const email = new EmailChannel(null);
    const dispatcher = new NotificationDispatcher(
      new ChannelRegistry([
        new InAppChannel(),
        email,
        new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
        new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
      ]),
      targets,
      deliveries,
      { maxAttempts: 1, outOfAppEnabled: true },
    );
    const note = notification();

    await dispatcher.dispatch(note);
    nowMs += 10_001;
    await dispatcher.dispatch(note);

    expect(email.sent).toHaveLength(1);
    const settled = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(settled?.status).toBe('accepted');
    expect(settled?.reference).toBeNull();
  });

  it('still retries a transport failure that returned no receipt', async () => {
    const deliveries = new MemoryDeliveryStore();
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: 'c'.repeat(64),
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    await targets.markVerified(USER, 'email', 'c'.repeat(64), new Date());

    const email = new FlakyEmail();
    const dispatcher = new NotificationDispatcher(
      new ChannelRegistry([
        new InAppChannel(),
        email,
        new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
        new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
      ]),
      targets,
      deliveries,
      { maxAttempts: 3, outOfAppEnabled: true },
    );
    const note = notification();

    const first = await dispatcher.dispatch(note);
    expect(email.sent).toHaveLength(1);
    expect(first.outcomes.find((o) => o.channel === 'email')).toMatchObject({ status: 'failed', retryable: true });
    const failed = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(failed?.status).toBe('failed');
    expect(failed?.reference).toBeNull();
    expect(failed?.acceptedAt).toBeNull();

    const second = await dispatcher.dispatch(note);
    expect(email.sent).toHaveLength(2);
    expect(second.outcomes.find((o) => o.channel === 'email')?.retryable).toBe(true);
  });

  it('finishes the accepted row when a later pass has out-of-app switched off', async () => {
    let nowMs = 1_000_000;
    const deliveries = new AcceptedSettleFailsOnce({ leaseMs: 10_000, now: () => new Date(nowMs) }, RECEIPT);
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: 'd'.repeat(64),
      verifyExpiresAt: new Date(nowMs + 60_000),
    });
    await targets.markVerified(USER, 'email', 'd'.repeat(64), new Date(nowMs));

    const email = new EmailChannel();
    const channels = new ChannelRegistry([
      new InAppChannel(),
      email,
      new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
      new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
    ]);
    const note = notification();
    await new NotificationDispatcher(channels, targets, deliveries, { maxAttempts: 1, outOfAppEnabled: true }).dispatch(note);

    nowMs += 10_001;
    const second = await new NotificationDispatcher(channels, targets, deliveries, {
      maxAttempts: 1,
      outOfAppEnabled: false,
    }).dispatch(note);

    expect(email.sent).toHaveLength(1);
    expect(second.outcomes.find((o) => o.channel === 'email')).toMatchObject({ status: 'accepted', retryable: false });
    const settled = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(settled?.status).toBe('accepted');
    expect(settled?.reference).toBe(RECEIPT);
    expect(settled?.refusalCode).toBeNull();
  });

  it('keeps the receipt when noteReceipt throws before the row updates', async () => {
    let nowMs = 1_000_000;
    const deliveries = new EmailNoteThrowsBeforeWrite({ leaseMs: 10_000, now: () => new Date(nowMs) });
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: 'e'.repeat(64),
      verifyExpiresAt: new Date(nowMs + 60_000),
    });
    await targets.markVerified(USER, 'email', 'e'.repeat(64), new Date(nowMs));

    const email = new EmailChannel();
    const dispatcher = new NotificationDispatcher(
      new ChannelRegistry([
        new InAppChannel(),
        email,
        new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
        new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
      ]),
      targets,
      deliveries,
      { maxAttempts: 3, outOfAppEnabled: true },
    );
    const note = notification();

    const first = await dispatcher.dispatch(note);
    expect(email.sent).toHaveLength(1);
    expect(first.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'failed',
      code: null,
      retryable: true,
    });
    const afterThrow = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(afterThrow?.status).toBe('pending');
    expect(afterThrow?.reference).toBe(RECEIPT);
    expect(afterThrow?.attemptedAt).not.toBeNull();
    expect(afterThrow?.acceptedAt).toBeNull();
    expect(afterThrow?.refusalCode).toBeNull();

    nowMs += 10_001;
    const second = await dispatcher.dispatch(note);

    expect(email.sent).toHaveLength(1);
    expect(second.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'accepted',
      retryable: false,
      code: null,
    });
    const settled = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(settled?.status).toBe('accepted');
    expect(settled?.reference).toBe(RECEIPT);
    expect(second.retry).toBe(false);
  });

  it('finishes accepted when noteReceipt persists the handle and then throws', async () => {
    let nowMs = 1_000_000;
    const deliveries = new EmailNoteWritesThenThrows({ leaseMs: 10_000, now: () => new Date(nowMs) });
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: 'f'.repeat(64),
      verifyExpiresAt: new Date(nowMs + 60_000),
    });
    await targets.markVerified(USER, 'email', 'f'.repeat(64), new Date(nowMs));

    const email = new EmailChannel();
    const dispatcher = new NotificationDispatcher(
      new ChannelRegistry([
        new InAppChannel(),
        email,
        new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
        new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
      ]),
      targets,
      deliveries,
      { maxAttempts: 3, outOfAppEnabled: true },
    );
    const note = notification();

    await dispatcher.dispatch(note);
    const afterThrow = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(email.sent).toHaveLength(1);
    expect(afterThrow?.status).toBe('pending');
    expect(afterThrow?.reference).toBe(RECEIPT);
    expect(afterThrow?.attemptedAt).not.toBeNull();

    nowMs += 10_001;
    const second = await dispatcher.dispatch(note);
    expect(email.sent).toHaveLength(1);
    expect(second.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'accepted',
      retryable: false,
    });
    const settled = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(settled?.status).toBe('accepted');
    expect(settled?.reference).toBe(RECEIPT);
  });

  it('stores the handle when noteReceipt never changes the pending row', async () => {
    const deliveries = new EmailNoteNeverLands();
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: '1'.repeat(64),
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    await targets.markVerified(USER, 'email', '1'.repeat(64), new Date());

    const email = new EmailChannel();
    const channels = new ChannelRegistry([
      new InAppChannel(),
      email,
      new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
      new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
    ]);
    const note = notification();
    const options = { maxAttempts: 3, outOfAppEnabled: true };

    await new NotificationDispatcher(channels, targets, deliveries, options).dispatch(note);
    const stored = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(email.sent).toHaveLength(1);
    expect(stored?.status).toBe('accepted');
    expect(stored?.reference).toBe(RECEIPT);
    expect(stored?.acceptedAt).not.toBeNull();
    expect(stored?.refusalCode).toBeNull();

    const second = await new NotificationDispatcher(channels, targets, deliveries, options).dispatch(note);
    expect(email.sent).toHaveLength(1);
    expect(second.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'already_accepted',
      retryable: false,
      code: null,
    });
    expect(second.retry).toBe(false);
  });

  it('stores a null handle when noteReceipt never changes the pending row', async () => {
    const deliveries = new EmailNoteNeverLands();
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: '2'.repeat(64),
      verifyExpiresAt: new Date(Date.now() + 60_000),
    });
    await targets.markVerified(USER, 'email', '2'.repeat(64), new Date());

    const email = new EmailChannel(null);
    const dispatcher = new NotificationDispatcher(
      new ChannelRegistry([
        new InAppChannel(),
        email,
        new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
        new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
      ]),
      targets,
      deliveries,
      { maxAttempts: 3, outOfAppEnabled: true },
    );
    const note = notification();

    await dispatcher.dispatch(note);
    await dispatcher.dispatch(note);

    expect(email.sent).toHaveLength(1);
    const settled = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(settled?.status).toBe('accepted');
    expect(settled?.reference).toBeNull();
  });

  it('finishes accepted on the next claim when the receipt never lands and acceptance throws', async () => {
    let nowMs = 1_000_000;
    const deliveries = new EmailNoteNeverLandsSettleMissesOnce({ leaseMs: 10_000, now: () => new Date(nowMs) }, RECEIPT);
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: '3'.repeat(64),
      verifyExpiresAt: new Date(nowMs + 60_000),
    });
    await targets.markVerified(USER, 'email', '3'.repeat(64), new Date(nowMs));

    const email = new EmailChannel();
    const dispatcher = new NotificationDispatcher(
      new ChannelRegistry([
        new InAppChannel(),
        email,
        new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
        new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
      ]),
      targets,
      deliveries,
      { maxAttempts: 3, outOfAppEnabled: true },
    );
    const note = notification();

    const first = await dispatcher.dispatch(note);
    expect(email.sent).toHaveLength(1);
    expect(first.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'failed',
      code: null,
      retryable: true,
    });
    const missed = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(missed?.status).toBe('pending');
    expect(missed?.reference).toBeNull();
    expect(missed?.attemptedAt).toBeNull();
    expect(missed?.acceptedAt).toBeNull();

    nowMs += 10_001;
    const second = await dispatcher.dispatch(note);

    expect(email.sent).toHaveLength(1);
    expect(second.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'accepted',
      retryable: false,
      code: null,
    });
    const settled = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(settled?.status).toBe('accepted');
    expect(settled?.reference).toBe(RECEIPT);
    expect(second.retry).toBe(false);
  });

  it('does not deliver again when the next claim is a new dispatcher', async () => {
    let nowMs = 1_000_000;
    const deliveries = new EmailNoteNeverLandsSettleMissesOnce({ leaseMs: 10_000, now: () => new Date(nowMs) }, RECEIPT);
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: '4'.repeat(64),
      verifyExpiresAt: new Date(nowMs + 60_000),
    });
    await targets.markVerified(USER, 'email', '4'.repeat(64), new Date(nowMs));

    const email = new EmailChannel();
    const channels = new ChannelRegistry([
      new InAppChannel(),
      email,
      new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
      new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
    ]);
    const note = notification();
    const options = { maxAttempts: 3, outOfAppEnabled: true };

    const first = await new NotificationDispatcher(channels, targets, deliveries, options).dispatch(note);
    expect(email.sent).toHaveLength(1);
    expect(first.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'failed',
      code: null,
      retryable: true,
    });
    const missed = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(missed?.status).toBe('pending');
    expect(missed?.reference).toBeNull();
    expect(missed?.attemptedAt).toBeNull();
    expect(missed?.acceptedAt).toBeNull();
    expect(missed?.attempts).toBe(1);

    nowMs += 10_001;
    const second = await new NotificationDispatcher(channels, targets, deliveries, options).dispatch(note);

    expect(email.sent).toHaveLength(1);
    expect(second.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'accepted',
      retryable: false,
      code: null,
    });
    const settled = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(settled?.status).toBe('accepted');
    expect(settled?.reference).toBe(RECEIPT);
    expect(settled?.attempts).toBe(1);
    expect(second.retry).toBe(false);
  });

  it.each([
    ['receipt', RECEIPT],
    ['acceptance', RECEIPT],
    ['receipt', 'other-receipt'],
    ['acceptance', 'other-receipt'],
  ])('retains an accepted gateway receipt after late %s CAS until the owner records %s', async (write, ownerReference) => {
    let nowMs = 1_000_000;
    const note = notification();
    class LateOwnershipStore extends EmailNoteNeverLands {
      private advanced = false;
      private receiptThrew = false;
      override async noteReceipt(input: NoteReceiptInput): Promise<void> {
        const row = (await this.listRecent(20)).find((record) => record.id === input.id);
        if (write !== 'receipt' || row?.channel !== 'email') return super.noteReceipt(input);
        if (!this.receiptThrew) {
          this.receiptThrew = true;
          throw new Error('first receipt write failed');
        }
        if (!this.advanced) {
          this.advanced = true;
          nowMs += 10_001;
          const winner = await this.claim(note.id, 'email', 3);
          if (!winner.claimed) throw new Error('fixture failed to reclaim the expired lease');
        }
        await MemoryDeliveryStore.prototype.noteReceipt.call(this, input);
      }
      override async settle(input: SettleInput): Promise<void> {
        if (write === 'acceptance' && !this.advanced && input.status === 'accepted' && input.reference === RECEIPT) {
          this.advanced = true;
          nowMs += 10_001;
          const winner = await this.claim(note.id, 'email', 3);
          if (!winner.claimed) throw new Error('fixture failed to reclaim the expired lease');
        }
        await super.settle(input);
      }
    }
    const deliveries = new LateOwnershipStore({ leaseMs: 10_000, now: () => new Date(nowMs) });
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: '4'.repeat(64),
      verifyExpiresAt: new Date(nowMs + 60_000),
    });
    await targets.markVerified(USER, 'email', '4'.repeat(64), new Date(nowMs));
    const email = new EmailChannel();
    const dispatcher = new NotificationDispatcher(
      new ChannelRegistry([
        new InAppChannel(),
        email,
        new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
        new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
      ]),
      targets,
      deliveries,
      { maxAttempts: 3, outOfAppEnabled: true },
    );

    const first = await dispatcher.dispatch(note);
    expect(first.outcomes.find((outcome) => outcome.channel === 'email')).toMatchObject({ status: 'failed', retryable: true });
    expect((await deliveries.listForNotification(note.id)).find((row) => row.channel === 'email')).toMatchObject({
      status: 'pending',
      attempts: 2,
      reference: null,
    });
    nowMs += 10_001;
    const second = await dispatcher.dispatch(note);
    expect(second.outcomes.find((outcome) => outcome.channel === 'email')).toMatchObject({ status: 'failed', retryable: true });
    const winningRow = (await deliveries.listForNotification(note.id)).find((row) => row.channel === 'email');
    expect(winningRow).toMatchObject({ status: 'pending', attempts: 2, reference: null });
    if (!winningRow) throw new Error('winning delivery row missing');
    await MemoryDeliveryStore.prototype.settle.call(deliveries, {
      id: winningRow.id,
      attempt: 2,
      status: 'accepted',
      reference: ownerReference,
      attempted: true,
    });
    const third = await dispatcher.dispatch(note);
    expect(third.outcomes.find((outcome) => outcome.channel === 'email')).toMatchObject(
      ownerReference === RECEIPT ? { status: 'already_accepted', retryable: false } : { status: 'failed', retryable: true },
    );
    expect((await deliveries.listForNotification(note.id)).find((row) => row.channel === 'email')).toMatchObject({
      status: 'accepted',
      attempts: 2,
      reference: ownerReference,
    });
    expect(email.sent).toHaveLength(1);
  });

  it.each([1, 3])('reconciles an in-hand receipt despite the next kill-switch and attempt budget %s', async (maxAttempts) => {
    let nowMs = 1_000_000;
    const deliveries = new EmailNoteNeverLandsSettleMissesOnce({ leaseMs: 10_000, now: () => new Date(nowMs) }, RECEIPT);
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: '4'.repeat(64),
      verifyExpiresAt: new Date(nowMs + 60_000),
    });
    await targets.markVerified(USER, 'email', '4'.repeat(64), new Date(nowMs));

    const email = new EmailChannel();
    const channels = new ChannelRegistry([
      new InAppChannel(),
      email,
      new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
      new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
    ]);
    const note = notification();
    const options = { maxAttempts, outOfAppEnabled: true };

    const first = await new NotificationDispatcher(channels, targets, deliveries, options).dispatch(note);
    expect(email.sent).toHaveLength(1);
    expect(first.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'failed',
      code: null,
      retryable: true,
    });
    const missed = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(missed?.status).toBe('pending');
    expect(missed?.reference).toBeNull();
    expect(missed?.attemptedAt).toBeNull();
    expect(missed?.acceptedAt).toBeNull();
    expect(missed?.attempts).toBe(1);

    nowMs += 10_001;
    options.outOfAppEnabled = false;
    const second = await new NotificationDispatcher(channels, targets, deliveries, options).dispatch(note);

    expect(email.sent).toHaveLength(1);
    expect(second.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'accepted',
      retryable: false,
      code: null,
    });
    const settled = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(settled?.status).toBe('accepted');
    expect(settled?.reference).toBe(RECEIPT);
    expect(settled?.attempts).toBe(1);
    expect(second.retry).toBe(false);
  });

  it('stores a null handle when the next claim is a new dispatcher', async () => {
    let nowMs = 1_000_000;
    const deliveries = new EmailNoteNeverLandsSettleMissesOnce({ leaseMs: 10_000, now: () => new Date(nowMs) }, null);
    const targets = new MemoryTargetStore();
    await targets.upsert({
      userId: USER,
      channel: 'email',
      address: 'borrower@example.com',
      locale: 'en',
      verifyTokenHash: '5'.repeat(64),
      verifyExpiresAt: new Date(nowMs + 60_000),
    });
    await targets.markVerified(USER, 'email', '5'.repeat(64), new Date(nowMs));

    const email = new EmailChannel(null);
    const channels = new ChannelRegistry([
      new InAppChannel(),
      email,
      new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
      new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
    ]);
    const note = notification();
    const options = { maxAttempts: 3, outOfAppEnabled: true };

    await new NotificationDispatcher(channels, targets, deliveries, options).dispatch(note);
    const missed = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(email.sent).toHaveLength(1);
    expect(missed?.status).toBe('pending');
    expect(missed?.reference).toBeNull();
    expect(missed?.attemptedAt).toBeNull();

    nowMs += 10_001;
    const second = await new NotificationDispatcher(channels, targets, deliveries, options).dispatch(note);

    expect(email.sent).toHaveLength(1);
    expect(second.outcomes.find((o) => o.channel === 'email')).toMatchObject({
      status: 'accepted',
      retryable: false,
      code: null,
    });
    const settled = (await deliveries.listForNotification(note.id)).find((r) => r.channel === 'email');
    expect(settled?.status).toBe('accepted');
    expect(settled?.reference).toBeNull();
  });
});
