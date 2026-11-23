// volt-room: /uc/trading-permissions
import { useState, type ReactNode } from 'react';
import { usePolled } from '../../protocol';
import { defineCopy } from '../../../shared/i18n';
import { displayAmount, parseAmount } from '../../../shared/money';
import { Button } from '@intafaced/ui/lit';
import { SettingsTemplate, Skeleton, type RoomState } from '@intafaced/ui/lit/templates';
import { useSession } from '../../session';
import { useVenueMode } from '../use-venue-mode';
import { draftId, keys, type VenueUp } from '../venue-api';
import { useOwner, useVenueActions, useVenueApi, type ActionResult } from '../venue/VenueKit';
import { VENUE_POLL_MS } from '../venue/poll';
import { AsOfLine, OutcomeLine, TestMark, VenueFrame, WalletBar } from './venue-parts';

// English source only. A venue is named as it reports itself; no partner is named here.
const copy = defineCopy('trade.trading-permissions', {
  title: 'Trading permissions',
  lead: 'The most each venue lets us charge as our builder fee on your orders there, as the venue itself reports it, beside the fee we publish. You gave each approval with your own wallet, and you can revoke it here at any time.',
  signedOutTitle: 'Sign in to see your trading permissions',
  signedOutBody: 'Your approvals are read from each venue for the wallet you connect.',
  signIn: 'Sign in',
  checking: 'Reading the venues…',
  venueOff: 'Venue trading is not switched on here, so there is no venue approval to show.',
  venueUnavailable: 'The venues can’t be reached: {detail}. Nothing shown here is current.',
  connectFirst: 'Connect your main wallet to read the approvals you gave on each venue.',
  colVenue: 'Venue',
  colApproved: 'Most you approved',
  colPublished: 'Our published fee',
  colState: 'State',
  colAction: 'Action',
  bps: '{bps} bps of each order',
  none: 'None',
  unknown: 'Unknown',
  notSet: 'Not set',
  stateApproved: 'Approved',
  stateNone: 'No approval',
  stateRevoked: 'Revoked',
  stateUnknown: 'Unknown: {detail}',
  reading: 'Reading…',
  revoke: 'Revoke',
  revokeTitle: 'Revoke our builder fee on {venue}',
  revokeWords:
    'Your main wallet {owner} signs one revoke on {venue}. The venue then lets us charge no builder fee on your orders there, and your next order there asks for your approval again first. An agent key can’t sign a revoke, and we never revoke or approve for you.',
  revokeInWallet: 'Revoke in wallet',
  cancel: 'Cancel',
  revokeNeedsMain:
    'Not revoked: a revoke needs your main wallet’s signature, and an agent key can’t sign it. Nothing was sent; the approval stays as {venue} reports it.',
  revokeRefused: 'Not revoked: {detail}. Nothing was sent; the approval stays as {venue} reports it.',
  revoked: 'Revoked on {venue}: the venue now reports no approval for us.',
  addressNotPublished: 'Our builder address is not published, so no approval can be read or revoked.',
  sectionsLabel: 'Trading permissions sections',
  explain:
    'An approval is the most a venue lets us charge as our builder fee on your orders there, as the venue reports it. A revoke is signed by your main wallet only; nothing is sent without it, and no money moves.',
});
type T = ReturnType<typeof copy.useCopy>['t'];

interface VenueRef {
  readonly id: string;
  readonly name: string;
  readonly test: boolean;
}

/** Every venue the door connects, the primary first; an older door names only the primary. */
function venuesOf(status: VenueUp): VenueRef[] {
  const listed = (status.venues ?? [])
    .filter((v): v is typeof v & { venueId: string } => v.venueId !== null)
    .map((v) => ({ id: v.venueId, name: v.displayName ?? v.venueId, test: v.test }));
  return listed.length > 0 ? listed : [{ id: status.venue.id, name: status.venue.displayName, test: status.test }];
}

/**
 * Settings, Trading permissions (J-derivatives-30 #1 #2 #3): on each venue, the most the person let us charge as our
 * builder fee, as the venue reports it, beside the fee the owner published, and a revoke signed by their main wallet.
 * A revoke is the venue's own approval of zero; an agent key never signs it (the door refuses one), and nothing is sent
 * without the main wallet's signature. Nothing moves: the ledger posts nothing.
 */
export function TradingPermissions() {
  const { t } = copy.useCopy();
  const mode = useVenueMode();
  const { userId } = useSession();
  if (!userId)
    return (
      <Shell
        state={{
          kind: 'empty',
          title: t('signedOutTitle'),
          body: t('signedOutBody'),
          action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent('/uc/trading-permissions')}` },
        }}
      />
    );
  if (mode.mode === 'checking')
    return (
      <Shell
        state={{ kind: 'ready' }}
        sections={
          <div role="status">
            <Skeleton shape="rows" count={2} />
            <span className="lt-hint">{t('checking')}</span>
          </div>
        }
      />
    );
  if (mode.mode === 'off') return <Shell state={{ kind: 'empty', title: t('title'), body: t('venueOff') }} />;
  const status = mode.status;
  return (
    <VenueFrame mode={mode}>
      <Shell
        state={{ kind: 'ready' }}
        sections={
          <section data-testid="trading-permissions" aria-labelledby="trading-permissions-title">
            <h2 id="trading-permissions-title">
              {t('title')} {status.available ? <TestMark test={status.test} /> : null}
            </h2>
            <p className="lt-hint">{t('lead')}</p>
            {status.available ? (
              <>
                <WalletBar />
                <Owned t={t}>{(owner) => <Approvals status={status} owner={owner} />}</Owned>
              </>
            ) : (
              <p className="lt-refusal" role="alert">
                {t('venueUnavailable', { detail: status.refusal.detail ?? status.refusal.code })}
              </p>
            )}
          </section>
        }
      />
    </VenueFrame>
  );
}

/** The room on its settings template: the template draws the title; the sections are the room's own. */
function Shell({ state, sections }: { state: RoomState; sections?: ReactNode }) {
  const { t } = copy.useCopy();
  return (
    <SettingsTemplate
      title={t('title')}
      state={state}
      index={
        <nav aria-label={t('sectionsLabel')}>
          <ul>
            <li>
              <a className="lt-link" href="#trading-permissions-title">
                {t('title')}
              </a>
            </li>
          </ul>
        </nav>
      }
      sections={sections ?? null}
      explain={<p>{t('explain')}</p>}
    />
  );
}

function Owned({ t, children }: { t: T; children: (owner: string) => ReactNode }) {
  const owner = useOwner();
  if (!owner) return <p className="lt-hint">{t('connectFirst')}</p>;
  return <>{children(owner)}</>;
}

function Approvals({ status, owner }: { status: VenueUp; owner: string }) {
  const { t } = copy.useCopy();
  const builder = status.builderAddress ?? status.builder?.address ?? null;
  if (!builder) return <p className="lt-refusal">{t('addressNotPublished')}</p>;
  const published = status.builder?.feeBps ?? null;
  return (
    <div tabIndex={0} role="region" aria-label={t('title')}>
      <table className="lt-table">
        <thead>
          <tr>
            {[t('colVenue'), t('colApproved'), t('colPublished'), t('colState'), t('colAction')].map((head) => (
              <th key={head} scope="col">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {venuesOf(status).map((v) => (
            <ApprovalRow key={v.id} venue={v} owner={owner} builder={builder} published={published} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

type RowState = 'reading' | 'approved' | 'none' | 'revoked' | 'unknown';

function ApprovalRow({ venue, owner, builder, published }: { venue: VenueRef; owner: string; builder: string; published: string | null }) {
  const { t } = copy.useCopy();
  const api = useVenueApi();
  const { run } = useVenueActions(owner);
  const read = usePolled((signal) => api.builderFeeApproval(owner, signal, venue.id), `permissions:${venue.id}:${owner}`, VENUE_POLL_MS);
  // The revoke being asked: its draft is minted when Revoke is pressed, so a double press or a lost answer is the same one.
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [revokedHere, setRevokedHere] = useState(false);

  const approved = read.data ? read.data.value : null;
  const active = approved !== null && parseAmount(approved) > 0n;
  const state: RowState = read.failure ? 'unknown' : approved === null ? 'reading' : active ? 'approved' : revokedHere ? 'revoked' : 'none';

  async function revoke() {
    if (!asking || busy) return;
    setBusy(true);
    try {
      const answer = await run(
        { kind: 'approve_builder_fee', builder, maxFeeBps: '0' },
        { actionKey: keys.builderRevoke(owner, venue.id, builder, asking), venueId: venue.id },
      );
      setResult(answer);
      if (answer.kind === 'outcome' && answer.outcome.accepted) {
        setRevokedHere(true);
        setAsking(null);
      }
      read.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr data-venue={venue.id} data-state={state} data-testid="trading-permission-row">
        <td>
          {venue.name} <TestMark test={venue.test} />
        </td>
        <td data-align="end" data-cell="approved">
          {state === 'unknown'
            ? t('unknown')
            : approved === null
              ? t('reading')
              : active
                ? t('bps', { bps: displayAmount(approved) })
                : t('none')}
        </td>
        <td data-align="end" data-cell="published">
          {published === null ? t('notSet') : t('bps', { bps: displayAmount(published) })}
        </td>
        <td data-cell="state">
          {stateWords(t, state, read.failure?.message ?? '')}
          {read.data && !read.failure ? <AsOfLine asOf={read.data.asOf} /> : null}
        </td>
        <td>
          {state === 'approved' ? (
            <Button
              tone="secondary"
              disabled={busy || asking !== null}
              onClick={() => {
                setResult(null);
                setAsking(draftId());
              }}
            >
              {t('revoke')}
            </Button>
          ) : null}
        </td>
      </tr>
      {asking !== null || result !== null ? (
        <tr data-venue={venue.id} data-testid="trading-permission-revoke-row">
          <td colSpan={5}>
            {asking !== null ? (
              <section role="dialog" aria-label={t('revokeTitle', { venue: venue.name })} data-testid="trading-permission-revoke">
                <h3>{t('revokeTitle', { venue: venue.name })}</h3>
                <p data-line="revoke-words">{t('revokeWords', { venue: venue.name, owner })}</p>
                <Button tone="primary" disabled={busy} onClick={() => void revoke()}>
                  {t('revokeInWallet')}
                </Button>{' '}
                <Button tone="secondary" disabled={busy} onClick={() => setAsking(null)}>
                  {t('cancel')}
                </Button>
              </section>
            ) : null}
            <RevokeOutcome t={t} result={result} venue={venue} owner={owner} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function stateWords(t: T, state: RowState, detail: string): string {
  switch (state) {
    case 'reading':
      return t('reading');
    case 'approved':
      return t('stateApproved');
    case 'none':
      return t('stateNone');
    case 'revoked':
      return t('stateRevoked');
    case 'unknown':
      return t('stateUnknown', { detail });
  }
}

/** What the revoke came to: revoked, refused before anything was sent, or an answer still to be read back. */
function RevokeOutcome({ t, result, venue, owner }: { t: T; result: ActionResult | null; venue: VenueRef; owner: string }) {
  if (!result) return null;
  if (result.kind === 'outcome' && result.outcome.accepted)
    return (
      <p role="status" data-testid="trading-permission-revoked">
        {t('revoked', { venue: venue.name })}
      </p>
    );
  if (result.kind === 'rejected' || result.kind === 'wallet_failed')
    return (
      <p className="lt-refusal" role="alert" data-testid="trading-permission-refused">
        {t('revokeNeedsMain', { venue: venue.name })}
      </p>
    );
  if (result.kind === 'refused')
    return (
      <p className="lt-refusal" role="alert" data-testid="trading-permission-refused" data-code={result.code ?? ''}>
        {t('revokeRefused', { venue: venue.name, detail: result.message })}
      </p>
    );
  return <OutcomeLine result={result} owner={owner} venueId={venue.id} />;
}
