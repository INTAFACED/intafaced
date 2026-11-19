import { useMemo, useState } from 'react';
import { Button, KeyValue } from '@intafaced/ui';
import { add, dec, str } from '../../../data/decimal';
import { displayAmount } from '../../../shared/money';
import { useResource } from '../../../shared/resource';
import { useWallet } from '../../../features/protocol/wallet/WalletProvider';
import { TestMark, WalletBar, useOwner, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { keys, preparedAnswerSchema, walletTypedData, type PreparedAnswer, type VenueUp } from '../../../features/trade/venue-api';
import type { ApiResult } from '../../../shared/api';
import type { createRoomApi, GridBot, GridRequest } from './api';
import { roomCopy } from './copy';
import type { Failure } from './guard';
import { InfoNote, RefusalNote } from './parts';

/**
 * The spot grid on the person's own venue account (J-copy-bots-otc-14; svc-trade src/grid/venue-grid.ts). INTAFACED holds
 * and moves nothing: every level is a venue order on the person's own account, placed by the grid agent permission their
 * wallet signs once (it can place and cancel orders there, never withdraw). Our builder fee rides on every sell, so the
 * wallet approves it once on the account if the service says it is not approved yet.
 */

type RoomApi = ReturnType<typeof createRoomApi>;
type Typed = PreparedAnswer['prepared']['typedData'];
const failed = (code: string): Failure => ({ ok: false, reason: 'error', message: '', code });
/** A signature the wallet did not give ends nothing on the service: the same request key is the same bot next time. */
export const WALLET_CODES: ReadonlySet<string> = new Set(['trade.bots_grid_wallet_rejected', 'trade.bots_grid_wallet_failed']);

/** The wallet's answer to one payload, as a refusal the room shows, or its signature. */
type Signed = { ok: true; signature: string } | { ok: false; failure: Failure };

function useSigner() {
  const wallet = useWallet();
  return async (typed: Typed): Promise<Signed> => {
    const signed = await wallet.sign({ kind: 'typedData', typedData: walletTypedData(typed) });
    if (signed.status === 'signed') return { ok: true, signature: signed.signature };
    return {
      ok: false,
      failure: failed(signed.status === 'rejected' ? 'trade.bots_grid_wallet_rejected' : 'trade.bots_grid_wallet_failed'),
    };
  };
}

/** The grid agent permission a signing bot asks for: the wallet signs it, and the bot sends it once and starts. */
export async function signPermission(
  api: RoomApi,
  sign: (typed: Typed) => Promise<Signed>,
  bot: GridBot,
  owner: string,
): Promise<ApiResult<GridBot>> {
  const next = bot.next;
  if (!next) return { ok: true, data: bot };
  // The service's payload, read as the venue door's own typed-data shape: one that does not parse is not signed.
  const typed = preparedAnswerSchema.shape.prepared.shape.typedData.safeParse(next.typedData);
  if (!typed.success) return failed('trade.bots_grid_wallet_failed');
  const signed = await sign(typed.data);
  if (!signed.ok) return signed.failure;
  const sent = await api.gridSubmitPermission({
    botId: bot.botId,
    actionKey: next.actionKey,
    signature: { digest: next.digest, signature: signed.signature, signedBy: owner },
  });
  return sent.ok ? { ok: true, data: sent.data as GridBot } : sent;
}

/**
 * What the wizard needs on the venue: the venue's spot markets, its mid for the chosen one, and the create that asks the
 * wallet for what the service needs (our builder fee approved once, then the grid agent permission) before anything rests.
 */
export function useVenueGrid(api: RoomApi, status: VenueUp, symbol: string) {
  const venue = useVenueApi();
  const owner = useOwner();
  const sign = useSigner();
  const markets = useResource((signal) => venue.markets(signal), 'grid-venue-markets');
  const spot = useMemo(
    () =>
      markets.resource.status === 'ready'
        ? markets.resource.data.value
            .filter((m) => m.kind === 'spot')
            .map((m) => ({ symbol: m.symbol, base: m.baseAsset, quote: m.quoteAsset, precision: { price: m.tickSize, amount: m.lotSize } }))
        : [],
    [markets.resource],
  );
  const prices = useResource((signal) => venue.bestPrices(symbol, signal), `grid-venue-best:${symbol}`);
  const best = prices.resource.status === 'ready' ? prices.resource.data.value : null;
  // The mid of the venue's best bid and ask, in scaled decimals (never a float).
  const bid = dec(best?.bid);
  const ask = dec(best?.ask);
  const last = bid !== null && ask !== null ? str(add(bid, ask) / 2n) : null;

  /** Our builder fee, approved once on the account by the wallet, under the venue desk's own key. */
  async function approveBuilder(): Promise<Failure | null> {
    const builder = status.builder;
    if (!builder || !owner) return failed('trade.bots_grid_builder_fee_unapproved');
    const prepared = await venue.prepare({
      owner,
      intent: { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps },
      actionKey: keys.builderApproval(owner, builder.address, builder.feeBps),
    });
    if (!prepared.ok) return prepared;
    if (prepared.data.lastOutcome?.definite && prepared.data.lastOutcome.accepted) return null;
    const signed = await sign(prepared.data.prepared.typedData);
    if (!signed.ok) return signed.failure;
    const sent = await venue.submit(prepared.data.actionKey, {
      digest: prepared.data.prepared.digest,
      signature: signed.signature,
      signedBy: owner,
    });
    if (!sent.ok) return sent;
    return sent.data.outcome.definite && sent.data.outcome.accepted ? null : failed('trade.bots_grid_builder_fee_unapproved');
  }

  const create = async (input: GridRequest): Promise<ApiResult<GridBot>> => {
    if (!owner) return failed('trade.bots_grid_wallet_required');
    let made = await api.gridCreate({ ...input, owner });
    if (!made.ok && made.code === 'trade.bots_grid_builder_fee_unapproved') {
      const refused = await approveBuilder();
      if (refused) return refused;
      made = await api.gridCreate({ ...input, owner });
    }
    if (!made.ok) return made;
    return signPermission(api, sign, made.data, owner);
  };
  return { owner, markets: spot, last, create, sign };
}

/** The wallet bar the grid needs on the venue: the bot trades on the account of the wallet connected here. */
export function GridWallet({ status }: { status: VenueUp }) {
  const { t } = roomCopy.useCopy();
  return (
    <>
      <InfoNote>
        {t(
          'The bot trades on your own {venue} account, under an agent permission your wallet signs once. It can place and cancel orders there, never withdraw.',
          {
            venue: status.venue.displayName,
          },
        )}{' '}
        <TestMark test={status.test} />
      </InfoNote>
      <WalletBar />
    </>
  );
}

/** A venue grid's account and permission, and, while it is signing, the wallet's signature it waits for. */
export function VenueGridFacts({ bot, api, onDone }: { bot: GridBot; api: RoomApi; onDone: () => void }) {
  const { t } = roomCopy.useCopy();
  const owner = useOwner();
  const sign = useSigner();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const venue = bot.venue;
  if (!venue) return null;
  const signNow = async () => {
    if (!owner || busy) return;
    setBusy(true);
    const sent = await signPermission(api, sign, bot, owner);
    setBusy(false);
    if (!sent.ok) return setFailure(sent);
    setFailure(null);
    onDone();
  };
  return (
    <>
      <KeyValue
        items={[
          { label: t('Trades on'), value: t('Your {venue} account {owner}', { venue: venue.name, owner: venue.owner }) },
          { label: t('Agent permission'), value: `${venue.agentName} ${venue.agentAddress}` },
        ]}
      />
      <TestMark test={venue.test} />
      {bot.status === 'signing' ? (
        <div className="cb-action-row">
          <InfoNote>{t('Nothing is placed until your wallet signs the agent permission.')}</InfoNote>
          <Button onClick={() => void signNow()} disabled={!owner || busy}>
            {t('Sign the agent permission')}
          </Button>
        </div>
      ) : null}
      {failure ? <RefusalNote failure={failure} /> : null}
    </>
  );
}

/** The venue fees on the bot's fills, by asset: the venue's own and our builder fee, as the venue charged them. */
export function venueFeeItems(bot: GridBot, t: ReturnType<typeof roomCopy.useCopy>['t']) {
  const fees = bot.fees ?? [];
  if (fees.length === 0) return [{ label: t('Fees'), value: t('None') }];
  return fees.flatMap((f) => [
    { label: t('Venue fees ({asset})', { asset: f.asset }), value: `${displayAmount(f.venueFee)} ${f.asset}` },
    { label: t('Our builder fee ({asset})', { asset: f.asset }), value: `${displayAmount(f.builderFee)} ${f.asset}` },
  ]);
}

/** CB-bots-05 on the venue: a bot can't withdraw. The service's refusal is shown in its words, and nothing moves. */
export function VenueGridWithdraw({ bot, api }: { bot: GridBot; api: RoomApi }) {
  const { t } = roomCopy.useCopy();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    setBusy(true);
    const answer = await api.gridWithdraw({
      botId: bot.botId,
      requestId: `grid-withdraw-${Date.now().toString(36)}`,
      asset: bot.quoteAsset,
      amount: '',
      stepUpApprovalId: null,
    });
    setBusy(false);
    setFailure(answer.ok ? failed('trade.bots_grid_withdraw_not_permitted') : answer);
  };
  return (
    <section aria-label={t('Withdraw')}>
      <InfoNote>{t('You withdraw from the venue with your own wallet. The bot’s agent permission can’t withdraw.')}</InfoNote>
      <div className="cb-action-row">
        <Button variant="secondary" onClick={() => void ask()} disabled={busy}>
          {t('Withdraw through the bot')}
        </Button>
      </div>
      {failure ? <RefusalNote failure={failure} /> : null}
    </section>
  );
}
