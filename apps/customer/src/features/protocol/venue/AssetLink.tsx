import { useState, type FormEvent } from 'react';
import type { ProtocolAssetLinkReview } from '@intafaced/contracts/protocol-venue-funds';
import { useResource } from '../../../shared/resource';
import { Button, Failure, Field, Loading, Panel } from '../../../shared/ui';
import type { createProtocolApi } from '../api';
import type { protocolCopy } from '../copy';

type Translate = ReturnType<typeof protocolCopy.forLocale>['t'];
type Api = ReturnType<typeof createProtocolApi>;

/** A service refusal reads "protocol.<code>: <sentence>"; the person sees the sentence. */
const sentence = (message: string) => message.replace(/^protocol\.[a-z_.]+:\s*/, '');

const READS_ID = 'contract-read-docs';

type Review =
  | { status: 'idle' }
  | { status: 'reviewing' }
  | { status: 'ready'; review: ProtocolAssetLinkReview }
  | { status: 'refused'; message: string };

/**
 * The asset link review (D-bridge-chain-04, J-dex-protocol-05 #10): whether a token is one of the trading venue's own two
 * assets, with its decimals, read by svc-protocol from the token and the venue contract at one block. Nothing is stored.
 */
export function AssetLinkReview({ api, t }: { api: Api; t: Translate }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [state, setState] = useState<Review>({ status: 'idle' });

  async function request(event: FormEvent) {
    event.preventDefault();
    if (state.status === 'reviewing') return;
    setState({ status: 'reviewing' });
    const result = await api.assetLinkReview(token.trim());
    setState(result.ok ? { status: 'ready', review: result.data } : { status: 'refused', message: sentence(result.message) });
  }

  return (
    <Panel title={t('linkTitle')}>
      <p className="muted">{t('linkLead')}</p>
      {open ? (
        <form className="protocol-quote" aria-label={t('linkTitle')} onSubmit={(event) => void request(event)}>
          <Field
            label={t('linkToken')}
            value={token}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setToken(event.target.value);
              setState({ status: 'idle' });
            }}
          />
          <Button type="submit" disabled={token.trim() === '' || state.status === 'reviewing'}>
            {state.status === 'reviewing' ? t('linkRequesting') : t('linkRequest')}
          </Button>
          {state.status === 'refused' && (
            <p className="protocol-refuse" role="alert">
              {state.message}
            </p>
          )}
        </form>
      ) : (
        <Button onClick={() => setOpen(true)}>{t('linkOpen')}</Button>
      )}
      {state.status === 'ready' && (
        <section aria-label={t('linkResult')} className="protocol-quote__result">
          <h3>{t('linkResult')}</h3>
          <p>
            {state.review.token.symbol ?? state.review.token.address} ·{' '}
            {t('linkDecimals', { decimals: String(state.review.token.decimals) })}
          </p>
          <p>
            <strong>{t('linkVerdict', { verdict: state.review.verdict === 'linked' ? t('linkLinked') : t('linkNotLinked') })}</strong>
          </p>
          <p>{state.review.reason}</p>
          <p className="muted">{t('linkAt', { venue: state.review.venue, block: state.review.blockNumber })}</p>
        </section>
      )}
      <p>
        <a href={`#${READS_ID}`}>{t('readsLink')}</a>
      </p>
    </Panel>
  );
}

/** The contract-read docs: the venue's public getters, each with an example aimed at the configured venue. */
export function VenueReadDocs({ api, t }: { api: Api; t: Translate }) {
  const docs = useResource((signal) => api.venueReads(signal), 'protocol-room:venue-reads');
  const { resource } = docs;
  return (
    <Panel id={READS_ID} aria-label={t('readsTitle')} title={t('readsTitle')}>
      {resource.status === 'loading' ? (
        <Loading />
      ) : resource.status === 'failed' ? (
        <Failure result={resource.failure} retry={docs.reload} />
      ) : (
        <>
          <p className="muted">{t('readsLead', { venue: resource.data.venue, chainId: String(resource.data.chainId) })}</p>
          {resource.data.calls.map((call) => (
            <article key={call.name}>
              <h4>
                <code>{call.signature}</code>
              </h4>
              <p>{call.description}</p>
              <pre>
                <code>{call.example}</code>
              </pre>
            </article>
          ))}
        </>
      )}
      <p className="muted">{t('readsCore')}</p>
    </Panel>
  );
}
