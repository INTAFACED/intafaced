import { useMemo, useState } from 'react';
import { Button, Field, QrMark } from '@intafaced/ui/lit';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { encodeQr, qrPath } from '../../../shared/qr';
import type { PersonalPayApi } from '../pay-api';
import type { Offer } from '../schemas';
import { shareCopy } from '../personal/p2p-share-copy';
import { shareUrl } from '../personal/p2p-share';
import { Failure, State, Time } from './parts';

/** The longest life a person can type, in hours: a year, the most svc-p2p takes. The owner's own longest may be less. */
const LINK_HOURS_MAX = 8760;

/**
 * The kit view of `../personal/p2p-share.tsx` (P-ads-merchant-07, J-p2p-05 #3), on the maker's own open ad: who sees
 * it, a new link with its QR code (the token is shown once), and the links made so far, each withdrawn on request.
 */
export function OfferSharing({ pay, offer, onChanged }: { pay: PersonalPayApi; offer: Offer; onChanged: (offer: Offer) => void }) {
  const { Copy, t } = shareCopy.useCopy();
  const [visibility, setVisibility] = useState(offer.visibility ?? 'public');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [revision, setRevision] = useState(0);
  const [made, setMade] = useState<{ url: string; expiresAt: string } | null>(null);
  // Blank: the longest the owner allows. A shorter life is the person's choice; the service never goes past the owner's.
  const [hours, setHours] = useState('');
  const [hoursProblem, setHoursProblem] = useState(false);
  const links = useResource((signal) => pay.shareLinks(offer.id, signal), `pay:share-links:${offer.id}:${revision}`);
  const change = async (next: 'public' | 'private') => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await pay.setOfferVisibility(offer.id, next);
    setBusy(false);
    if (!result.ok) return setFailure(result);
    setVisibility(next);
    onChanged(result.data);
  };
  const share = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const whole = hours.trim() === '' ? null : Number(hours.trim());
    if (whole !== null && !(Number.isInteger(whole) && whole >= 1 && whole <= LINK_HOURS_MAX)) {
      setBusy(false);
      setHoursProblem(true);
      return;
    }
    setHoursProblem(false);
    const result = await pay.createShareLink(offer.id, crypto.randomUUID(), whole === null ? undefined : whole * 3600);
    setBusy(false);
    if (!result.ok) return setFailure(result);
    setMade({ url: shareUrl(offer.id, result.data.token), expiresAt: result.data.expiresAt });
    setRevision((n) => n + 1);
  };
  const revoke = async (linkId: string) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await pay.revokeShareLink(linkId);
    setBusy(false);
    if (!result.ok) return setFailure(result);
    setRevision((n) => n + 1);
  };
  return (
    <section data-testid="offer-sharing" data-visibility={visibility}>
      <h3>
        <Copy k="visibilityTitle" />
      </h3>
      <p data-testid="offer-visibility">
        <strong>{t(visibility)}</strong> · {t(visibility === 'public' ? 'publicBody' : 'privateBody')}
      </p>
      <Button disabled={busy} onClick={() => void change(visibility === 'public' ? 'private' : 'public')}>
        <Copy k={visibility === 'public' ? 'makePrivate' : 'makePublic'} />
      </Button>
      <h3>
        <Copy k="shareTitle" />
      </h3>
      <p className="lt-hint">
        <Copy k="shareBody" />
      </p>
      <Field
        label={t('linkLife')}
        inputMode="numeric"
        value={hours}
        placeholder={t('linkLifeLongest')}
        onChange={(event) => setHours(event.target.value)}
      />
      {hoursProblem ? <p className="lt-hint">{t('linkLifeInvalid', { max: String(LINK_HOURS_MAX) })}</p> : null}
      <Button disabled={busy} onClick={() => void share()}>
        <Copy k={busy ? 'makingLink' : 'makeLink'} />
      </Button>
      {made ? <MadeLink url={made.url} expiresAt={made.expiresAt} /> : null}
      {failure ? <Failure result={failure} /> : null}
      <h3>
        <Copy k="linksTitle" />
      </h3>
      <State resource={links.resource} retry={links.reload} empty={t('linksNone')}>
        {(rows) => (
          <ul data-testid="share-links">
            {rows.map((link) => {
              const ended = Date.parse(link.expiresAt) <= Date.now();
              return (
                <li key={link.id} data-link-id={link.id} data-state={link.revokedAt ? 'withdrawn' : ended ? 'ended' : 'live'}>
                  {link.revokedAt ? (
                    <Copy k="linkWithdrawn" />
                  ) : (
                    <>
                      <Copy k={ended ? 'linkEnded' : 'linkEnds'} /> <Time value={link.expiresAt} />{' '}
                      {ended ? null : (
                        <Button tone="quiet" disabled={busy} onClick={() => void revoke(link.id)}>
                          <Copy k="withdraw" />
                        </Button>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </State>
    </section>
  );
}

function MadeLink({ url, expiresAt }: { url: string; expiresAt: string }) {
  const { Copy, t } = shareCopy.useCopy();
  const [copied, setCopied] = useState(false);
  const drawn = useMemo(() => {
    try {
      return qrPath(encodeQr(url, 'M'), 2);
    } catch {
      return null;
    }
  }, [url]);
  return (
    <div role="status" data-testid="share-link-made">
      <p>
        <Copy k="linkMade" />
      </p>
      <code className="lt-mono" lang="zxx" data-testid="share-link-url">
        {url}
      </code>
      <p className="lt-hint" data-testid="share-link-ends">
        <Copy k="linkEnds" /> <Time value={expiresAt} />
      </p>
      <Button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        <Copy k={copied ? 'copied' : 'copyLink'} />
      </Button>
      {drawn ? <QrMark d={drawn.d} size={drawn.size} label={t('qrLabel')} /> : null}
    </div>
  );
}
