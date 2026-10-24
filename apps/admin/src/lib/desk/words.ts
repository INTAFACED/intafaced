/**
 * Plain words for the raw strings a service puts in a field, so a founder never reads `p2p.moderation_unprobed` or a bare
 * identity UUID on a desk. Pure: the same words on the server and in the browser.
 */

const CODE_WORDS: Readonly<Record<string, string>> = {
  'p2p.moderation_unprobed': 'Moderators are configured; the service cannot tell whether anyone is watching the queue',
  'p2p.moderation_unreachable': 'No moderators are set up',
  not_built: 'Not switched on for this deployment',
  utilisation_not_recorded: 'Not recorded by svc-bank',
  ledger_unavailable: 'The ledger could not be read',
  handle_unresolved: 'The directory could not name this person',
  no_heartbeat: 'The service gives no heartbeat',
  fee_unconfigured: 'No fee is configured',
  window_size_unconfigured: 'No window size is configured',
  served_by_p2p_ops: 'Counted on the P2P desk; svc-bank gives no P2P figure',
  failures_not_recorded: 'svc-bank does not record a refused one-off send, so it has no failure figure',
  standing_order: 'Standing order',
  one_off: 'One-off send',
  'socket.psp-partners': 'A payment-service partner is not connected',
  not_attached: 'Not attached to a verification',
};

/** Prefixes of the typed codes our own services use. Free text and ordinary values (a currency, a domain) never match. */
const SERVICE_PREFIX =
  /^(p2p|pay|ops|edge|admin|bank|ledger|identity|chain|protocol|academy|notify|support|market|kyb|guest|scope|mfa|operator)\.[a-z0-9_.]+$/;

/** A known code in words; any other service code as its last part in words ("pay.halt_store_unavailable" is "Halt store unavailable"); anything else unchanged. */
export function codeWords(value: string): string {
  if (Object.hasOwn(CODE_WORDS, value)) return CODE_WORDS[value]!;
  // A hostname such as pay.intafaced.com has no underscore, a typed code does; only a code is reworded.
  if (!SERVICE_PREFIX.test(value) || !value.includes('_')) return value;
  const last = value.slice(value.lastIndexOf('.') + 1).replace(/_/g, ' ');
  return last.charAt(0).toUpperCase() + last.slice(1);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who did something, when only an identity id is known: `Account, id ends …1f3a`. It is labelled as an id and is short, so
 * it is a reference and not a UUID dump. Text that is not an id (a system name such as `reconciliation`) is kept as given.
 */
export function actorRef(actor: string | null | undefined): string {
  if (!actor) return '—';
  return UUID.test(actor) ? `Account, id ends …${actor.slice(-4)}` : actor;
}
