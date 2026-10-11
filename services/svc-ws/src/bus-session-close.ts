/**
 * End one bus session.
 * Drop-copy and the private order hub both stop advertising the bus as up
 * before the tape, orders, fills, positions, and drop-copy subscriptions drop.
 * A later successful private attach may call `announceBus(true)` again.
 */
export async function closeBusSession(input: {
  readonly privateHub: { announceBus(bus: boolean): void };
  readonly dropCopyHub: { announceBus(bus: boolean): void };
  readonly unsubscribe: readonly (() => Promise<unknown>)[];
  readonly disconnect: () => Promise<unknown>;
}): Promise<void> {
  input.dropCopyHub.announceBus(false);
  input.privateHub.announceBus(false);
  for (const step of input.unsubscribe) {
    await step().catch(() => undefined);
  }
  await input.disconnect().catch(() => undefined);
}

/** An attachment finishing after session closure never advertises that dead bus as ready. */
export async function attachBusHalf<T>(input: {
  readonly attach: () => Promise<T | null>;
  readonly isClosed: () => boolean;
  readonly unsubscribe: (attachment: T) => Promise<unknown>;
  readonly announce: () => void;
}): Promise<T | null> {
  if (input.isClosed()) return null;
  const attachment = await input.attach();
  if (attachment === null) return null;
  if (input.isClosed()) {
    await input.unsubscribe(attachment).catch(() => undefined);
    return null;
  }
  input.announce();
  return attachment;
}
