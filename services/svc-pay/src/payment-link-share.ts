/**
 * Payment link share (M-adv-payments-core-19).
 *
 * A deactivated link can carry the merchant's own message. A confirmation is
 * either that message or an https redirect. A blank message or a non-https
 * redirect is refused. An embed snippet exists only for a stored checkout path
 * and a fixed amount: no host and no price is invented here.
 */

const MESSAGE_MAX = 500;
const URL_MAX = 2048;

export type LinkConfirmation = { kind: 'message'; message: string } | { kind: 'redirect'; url: string };

export type LinkShareCode = 'pay.link_confirmation_unset' | 'pay.link_redirect_not_https';

export function parseLinkConfirmation(
  input: LinkConfirmation | undefined,
): { ok: true; message: string | null; url: string | null } | { ok: false; code: LinkShareCode } {
  if (input === undefined) return { ok: true, message: null, url: null };
  if (input.kind === 'message') {
    const message = input.message.trim();
    if (!message) return { ok: false, code: 'pay.link_confirmation_unset' };
    if (message.length > MESSAGE_MAX) return { ok: false, code: 'pay.link_confirmation_unset' };
    return { ok: true, message, url: null };
  }
  const url = input.url.trim();
  if (!url) return { ok: false, code: 'pay.link_confirmation_unset' };
  if (url.length > URL_MAX) return { ok: false, code: 'pay.link_redirect_not_https' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: 'pay.link_redirect_not_https' };
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) return { ok: false, code: 'pay.link_redirect_not_https' };
  return { ok: true, message: null, url };
}

/** Blank or whitespace is no message. A message over the cap is refused. */
export function parseInactiveMessage(
  raw: string | undefined,
): { ok: true; message: string | null } | { ok: false; code: 'pay.link_confirmation_unset' } {
  if (raw === undefined) return { ok: true, message: null };
  const message = raw.trim();
  if (!message) return { ok: true, message: null };
  if (message.length > MESSAGE_MAX) return { ok: false, code: 'pay.link_confirmation_unset' };
  return { ok: true, message };
}

/** Stable fingerprint fragment. Omitted confirmation is not part of the body. */
export function confirmationFingerprint(message: string | null, url: string | null): string {
  if (url) return `redirect:${url}`;
  return `message:${message ?? ''}`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Button that opens the hosted page. Null unless the link has a stored path
 * and a fixed amount. The amount is the one stored on the link.
 */
export function paymentLinkEmbedSnippet(input: {
  checkoutUrl: string | null;
  amount: string | null;
  currency: string | null;
  label: string;
}): string | null {
  if (!input.checkoutUrl || input.amount === null) return null;
  const asset = input.currency ? ` data-asset="${escapeAttr(input.currency)}"` : '';
  return `<a href="${escapeAttr(input.checkoutUrl)}" data-amount="${escapeAttr(input.amount)}"${asset}>${escapeText(input.label)}</a>`;
}
