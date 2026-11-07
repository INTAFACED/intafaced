import { z } from 'zod';

/**
 * Wire types for the embedded login's key export (RC-dex-protocol-05), version 1: svc-protocol's `embedded.status` and
 * `embedded.markExported`. The key is made and held on the person's device, wrapped by their passkey; it never reaches the
 * server in any request, log or error. The server keeps one fact per account: that its key was shown, and when. After
 * that, an export request on any device refuses `wallet.export_spent` and returns no key.
 */
export const PROTOCOL_EMBEDDED_CONTRACT_VERSION = 1 as const;

export const EMBEDDED_EXPORT_SPENT = 'wallet.export_spent' as const;
export const EMBEDDED_EXPORT_NOT_OWNER = 'wallet.export_not_owner' as const;

/** The message the embedded key signs to say its own export happened. It names the account and the chain; nothing else. */
export function embeddedExportMessage(account: string, chainId: number): string {
  return `INTAFACED embedded login\nThe key of ${account.toLowerCase()} was shown to its owner once.\nChain: ${chainId}`;
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const protocolEmbeddedStatusInputSchema = z.object({ account: address });
export const protocolEmbeddedStatusSchema = z.object({
  account: z.string(),
  chainId: z.number().int(),
  exported: z.boolean(),
  exportedAt: z.string().nullable(),
});
export const protocolEmbeddedMarkInputSchema = z.object({
  account: address,
  /** The embedded key's signature over `embeddedExportMessage(account, chainId)`: proof the caller holds that key. */
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export type ProtocolEmbeddedStatus = z.infer<typeof protocolEmbeddedStatusSchema>;
