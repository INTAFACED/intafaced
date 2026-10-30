import { useMemo, useState } from 'react';
import {
  protocolListingChallengeOutputSchema,
  protocolListingVerifyOutputSchema,
  type ProtocolListingChallenge,
  type ProtocolListingProof,
} from '@intafaced/contracts/protocol-listing';
import type { ApiResult } from '../../../shared/api';
import { Button, Dialog, Failure, Loading } from '../../../shared/ui';
import { useApi } from '../../session/session';
import { createProtocolApi, type RepresentationStatus } from '../api';
import { RepresentationPanel, type RepresentationEnd } from '../wallet/RepresentationPanel';
import { useWallet } from '../wallet/WalletProvider';
import type { TokensTranslate } from './copy';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type State =
  | { step: 'loading' }
  | { step: 'refused'; failure: Refusal }
  | { step: 'challenge'; challenge: ProtocolListingChallenge; problem?: string }
  | { step: 'representation'; challenge: ProtocolListingChallenge; address: string; status: RepresentationStatus }
  | { step: 'checking'; challenge: ProtocolListingChallenge }
  | { step: 'proven'; proof: ProtocolListingProof };

/**
 * Request an info update for a token (D-launch-listing-01): the token's owner first proves control by signing a one-time
 * challenge from svc-protocol with the wallet the token contract names as owner. The service checks the signer against the
 * owner it reads from the chain and stores the proof; every refusal (not the owner, no readable owner, a used or expired
 * challenge, an unreachable chain) is shown in its own words.
 */
export function InfoUpdate({ token, t }: { token: string; t: TokensTranslate }) {
  const api = useApi();
  const wallet = useWallet();
  const protocol = useMemo(() => createProtocolApi(api), [api]);
  const [state, setState] = useState<State | null>(null);
  const listing = useMemo(
    () => ({
      challenge: () => api.mutate('protocol', 'listing.ownershipChallenge', { token }, protocolListingChallengeOutputSchema),
      verify: (nonce: string, signature: string) =>
        api.mutate('protocol', 'listing.verifyOwnership', { nonce, signature }, protocolListingVerifyOutputSchema),
    }),
    [api, token],
  );

  async function open() {
    setState({ step: 'loading' });
    const result = await listing.challenge();
    setState(result.ok ? { step: 'challenge', challenge: result.data } : { step: 'refused', failure: result });
  }

  async function sign(challenge: ProtocolListingChallenge) {
    if (!wallet.address) return;
    // The first signing action asks for the representation once per version, as every other signing form does. The gate
    // never fails open: a refusal or a service that does not answer stops here, before the wallet is asked.
    const representation = await protocol.representationStatus(wallet.address);
    if (!representation.ok) return setState({ step: 'refused', failure: representation });
    if (!representation.data.accepted)
      return setState({ step: 'representation', challenge, address: wallet.address, status: representation.data });
    const signed = await wallet.sign({ kind: 'message', message: challenge.message });
    if (signed.status !== 'signed') {
      setState({
        step: 'challenge',
        challenge,
        problem: signed.status === 'rejected' ? t('updateRejected') : signed.status === 'failed' ? signed.message : undefined,
      });
      return;
    }
    setState({ step: 'checking', challenge });
    const result = await listing.verify(challenge.nonce, signed.signature);
    setState(result.ok ? { step: 'proven', proof: result.data } : { step: 'refused', failure: result });
  }

  return (
    <>
      <Button variant="secondary" onClick={() => void open()}>
        {t('updateRequest')}
      </Button>
      {state && (
        <Dialog title={t('updateRequest')} onClose={() => setState(null)}>
          {state.step === 'loading' && <Loading label={t('updateRequest')} />}
          {state.step === 'refused' && <Failure result={state.failure} />}
          {(state.step === 'challenge' || state.step === 'checking') && (
            <>
              <p>{t('updateSignIntro')}</p>
              <pre className="tokens-challenge" data-testid="token-update-challenge">
                {state.challenge.message}
              </pre>
              {state.step === 'challenge' && state.problem && <p role="alert">{state.problem}</p>}
              {wallet.address ? (
                <Button disabled={state.step === 'checking'} onClick={() => void sign(state.challenge)}>
                  {t('updateSign')}
                </Button>
              ) : (
                <p>
                  {t('updateConnect')} <a href="/wallet">{t('updateOpenWallet')}</a>
                </p>
              )}
            </>
          )}
          {state.step === 'representation' && (
            <RepresentationPanel
              address={state.address}
              status={state.status}
              api={protocol}
              onEnd={(end: RepresentationEnd) => {
                if (end.kind === 'accepted') void sign(state.challenge);
                else
                  setState({
                    step: 'challenge',
                    challenge: state.challenge,
                    problem: end.kind === 'rejected' ? t('updateRejected') : end.kind === 'failed' ? end.message : t('updateRegion'),
                  });
              }}
            />
          )}
          {state.step === 'proven' && (
            <div role="status">
              <p>{t('updateProven', { signer: state.proof.signer, block: state.proof.blockNumber })}</p>
              <p className="muted" data-blocker="owner.decision">
                {t('updateFormBlocked')}
              </p>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
