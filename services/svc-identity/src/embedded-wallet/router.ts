import { IDENTITY_EMBEDDED_WALLET_PROVISION } from '@intafaced/contracts/identity-embedded-wallet-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { codedRefusal } from '../record-refusal.js';
import { ProviderRefusedError, ProviderUnavailableError, type EmbeddedWalletMaker } from './turnkey.js';

const refused = (code: 'PRECONDITION_FAILED' | 'SERVICE_UNAVAILABLE' | 'CONFLICT', refusal: string, message: string) =>
  new TRPCError({ code, message, cause: { code: refusal } });

/**
 * `embeddedWallet.provision` (J-wallet-22): the signed-in person's one wallet at the owner's provider, bound to their
 * passkey. The person is the request's own principal, never an input, so no one can have a wallet made for someone else.
 * Nothing is stored here: svc-protocol records the wallet's address and id.
 */
export function createEmbeddedWalletRouter(maker: EmbeddedWalletMaker | null) {
  return router({
    embeddedWallet: router({
      provision: mountRecord(
        IDENTITY_EMBEDDED_WALLET_PROVISION,
        async ({ ctx, input }) => {
          if (!maker)
            throw refused('PRECONDITION_FAILED', 'wallet.embedded_provider_unset', 'No wallet provider is set here. Nothing was made.');
          const ownerRef = ctx.principal.userId;
          try {
            const wallet = await maker.createWallet({ ownerRef, passkey: input.passkey });
            if (wallet.ownerRef !== ownerRef)
              throw refused(
                'CONFLICT',
                'wallet.embedded_wallet_mismatch',
                'The provider returned a wallet that is not yours. Nothing was made.',
              );
            return { walletId: wallet.walletId, address: wallet.address, ownerRef };
          } catch (err) {
            if (err instanceof ProviderRefusedError)
              throw refused(
                'CONFLICT',
                'wallet.embedded_wallet_mismatch',
                'The provider would not make a wallet with this passkey. Nothing was made.',
              );
            if (err instanceof ProviderUnavailableError)
              throw refused('SERVICE_UNAVAILABLE', 'wallet.embedded_provider_down', 'The provider is not answering. Nothing was made.');
            throw err;
          }
        },
        codedRefusal,
      ),
    }),
  });
}
