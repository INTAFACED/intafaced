import type { z } from 'zod';
import { type ApiResult } from '../../shared/api';
import { DepthPanel, DisabledAction, Fact, ChannelSwitch } from './DepthParts';
import { cardDepthCopy } from './card-depth-copy';
import { Button } from '../../shared/ui';
import { funds, type ActionField, type ActionSpec } from './components';
import { bankReads, type cardSchema } from './contracts';
import { maskedPan } from './card-controls';
import {
  buildChannelsInput,
  buildLimitsInput,
  CHANNEL_KEYS,
  channelsMatch,
  channelsOf,
  limitMove,
  limitsMatch,
  limitsOf,
  limitsUnchanged,
  limitValueProblem,
  loosensCard,
  sameSettings,
  type ChannelKey,
  type LimitKey,
} from './card-limits';
import { t as copyText } from './copy';
import { useSession } from '../session/session';
import './bank-depth.css';

type CardRecord = z.infer<typeof cardSchema>;

/** The newest cards the customer has, read again just before a change is sent. */
export function freshCardCheck(
  read: () => Promise<ApiResult<CardRecord[]>>,
  card: CardRecord,
  copy: { t: (key: 'cardUnreadable' | 'cardChanged') => string },
) {
  return async (keys: readonly (LimitKey | ChannelKey)[]): Promise<ApiResult<null>> => {
    const fresh = await read();
    if (!fresh.ok) return { ok: false, reason: 'error', code: 'money.review_read_unavailable', message: copy.t('cardUnreadable') };
    const current = fresh.data.find((row) => row.id.toLowerCase() === card.id.toLowerCase());
    if (!sameSettings(current, card, keys) || current?.status === 'closed')
      return { ok: false, reason: 'error', code: 'money.review_changed', message: copy.t('cardChanged') };
    return { ok: true, data: null };
  };
}

function useFreshCard(card: CardRecord) {
  const { api } = useSession();
  const copy = cardDepthCopy.useCopy();
  return freshCardCheck(() => api.query('bank', 'cards.list', { limit: 200 }, bankReads['cards.list']), card, copy);
}

/** A limit as the customer reads it: the exact figure in the card's asset, or "No limit" for a cap that is not set. */
function limitText(value: string | null, asset: string, none: string): string {
  return value === null ? none : asset ? funds(value, asset) : '—';
}

const LIMIT_LABEL = {
  perAuthorizationLimit: 'limitPerPurchase',
  dailyLimit: 'limitDaily',
  monthlyLimit: 'limitMonthly',
  cashLimit: 'limitCash',
} as const;

type CardCopy = ReturnType<typeof cardDepthCopy.forLocale>;
type Fresh = (keys: readonly (LimitKey | ChannelKey)[]) => Promise<ApiResult<null>>;
const LIMIT_KEYS_ALL = Object.keys(LIMIT_LABEL) as LimitKey[];

/** The confirmation for changing a card's limits: every cap, from what to what, before anything is sent. */
export function limitsSpec(card: CardRecord, copy: CardCopy, freshCard: Fresh): ActionSpec {
  const { t } = copy;
  const none = t('limitNone');
  const field = (key: LimitKey, optional: boolean): ActionField => ({
    name: key,
    label: `${t(LIMIT_LABEL[key])} (${card.assetId})`,
    hint: optional ? t('limitOptionalHint') : t('limitPerHint'),
    optional,
    validate: (value) => (limitValueProblem(value, optional) ? t('limitInvalid') : null),
  });
  return {
    title: t('limitEditTitle'),
    procedure: 'cards.setLimits',
    initial: Object.fromEntries(LIMIT_KEYS_ALL.map((key) => [key, card[key] ?? ''])),
    fields: [field('perAuthorizationLimit', false), field('dailyLimit', true), field('monthlyLimit', true), field('cashLimit', true)],
    facts: [
      [copyText('rooms.card'), maskedPan(card.panTail)],
      [t('fundingLabel'), card.assetId],
    ],
    // What is about to change, from what to what, worked out from exactly what has been typed.
    liveRows: (values) => {
      const next = buildLimitsInput(card.id, 'review', values);
      return LIMIT_KEYS_ALL.flatMap((key): [string, string][] => {
        const typed = next[key];
        if (typed !== null && limitValueProblem(typed, key !== 'perAuthorizationLimit')) return [];
        if (limitMove(card[key], typed) === 'same') return [];
        return [
          [
            t('limitChangeLabel', { limit: t(LIMIT_LABEL[key]) }),
            t('limitChangeRow', { from: limitText(card[key], card.assetId, none), to: limitText(typed, card.assetId, none) }),
          ],
        ];
      });
    },
    notes: [t('limitsCheckedNote'), t('limitsLoosenNote')],
    submit: t('limitsSave'),
    validate: (input) =>
      limitsUnchanged(limitsOf(card), {
        perAuthorizationLimit: String(input.perAuthorizationLimit),
        dailyLimit: input.dailyLimit as string | null,
        monthlyLimit: input.monthlyLimit as string | null,
        cashLimit: input.cashLimit as string | null,
      })
        ? t('limitNoChange')
        : null,
    preflight: () => freshCard(LIMIT_KEYS_ALL),
    // The request id is the command id, so sending this same change again is recognised and applied once.
    input: (values, requestId) => buildLimitsInput(card.id, requestId, values),
    verifyOutcome: limitsMatch,
    describeOutcome: (data) => {
      const saved = data as CardRecord;
      return LIMIT_KEYS_ALL.map((key): [string, string] => [t(LIMIT_LABEL[key]), limitText(saved[key], saved.assetId, none)]);
    },
  };
}

/** The four caps on a card, shown exactly, with the change flow behind one button. */
export function CardLimitsPanel({ card, open }: { card: CardRecord; open: (spec: ActionSpec) => void }) {
  const copy = cardDepthCopy.useCopy();
  const { t } = copy;
  const freshCard = useFreshCard(card);
  const closed = card.status === 'closed';
  const none = t('limitNone');
  return (
    <DepthPanel title={t('limitsTitle')} lead={t('limitsLead')}>
      <dl className="bd-facts">
        {LIMIT_KEYS_ALL.map((key) => (
          <Fact key={key} label={t(LIMIT_LABEL[key])}>
            <span className="numeric" lang="zxx" dir="ltr">
              {limitText(card[key], card.assetId, none)}
            </span>
          </Fact>
        ))}
      </dl>
      {closed ? (
        <DisabledAction label={t('limitEdit')} reason={t('limitEditClosedReason')} />
      ) : (
        <div className="actions">
          <Button variant="secondary" onClick={() => open(limitsSpec(card, copy, freshCard))}>
            {t('limitEdit')}
          </Button>
        </div>
      )}
    </DepthPanel>
  );
}

const CHANNEL_LABEL = {
  online: 'channelOnline',
  contactless: 'channelContactless',
  atm: 'channelAtm',
  abroad: 'channelAbroad',
} as const;

/** The confirmation for turning one channel on or off: what it is now, what it becomes, and what that means. */
export function channelSpec(card: CardRecord, key: ChannelKey, copy: CardCopy, freshCard: Fresh): ActionSpec {
  const { t } = copy;
  const turningOn = !card[key];
  const name = t(CHANNEL_LABEL[key]);
  return {
    title: turningOn ? t('channelTurnOnTitle', { channel: name }) : t('channelTurnOffTitle', { channel: name }),
    procedure: 'cards.setChannels',
    // Turning a channel off only protects the card, so its confirmation is short: one row and one line, one button.
    // Turning one on loosens the card, so it keeps the full confirmation.
    facts: turningOn
      ? [
          [copyText('rooms.card'), maskedPan(card.panTail)],
          [t('channelFactLabel'), name],
          [t('channelFactState'), `${t('channelStateOff')} → ${t('channelStateOn')}`],
        ]
      : [[t('channelFactLabel'), name]],
    notes: [turningOn ? t('channelOnNote') : t('channelOffNote')],
    submit: turningOn ? t('channelsConfirm') : t('channelTurnOffSubmit'),
    // All four switches are sent together, so the card is read again first: a change made elsewhere is never overwritten.
    preflight: () => freshCard(CHANNEL_KEYS),
    // The request id is the command id, so sending this same change again is recognised and applied once.
    input: (_values, requestId) => buildChannelsInput(card.id, requestId, channelsOf(card), key, turningOn),
    verifyOutcome: channelsMatch,
    describeOutcome: (data) => {
      const saved = data as CardRecord;
      return CHANNEL_KEYS.map((each): [string, string] => [
        t(CHANNEL_LABEL[each]),
        saved[each] ? t('channelStateOn') : t('channelStateOff'),
      ]);
    },
  };
}

/** Where the card works. Each switch shows the real state and asks for a confirmation before it changes it. */
export function CardChannelsPanel({ card, open }: { card: CardRecord; open: (spec: ActionSpec) => void }) {
  const copy = cardDepthCopy.useCopy();
  const { t } = copy;
  const freshCard = useFreshCard(card);
  const closed = card.status === 'closed';
  return (
    <DepthPanel title={t('channelsTitle')} lead={t('channelsLead')}>
      {CHANNEL_KEYS.map((key) => (
        <ChannelSwitch
          key={key}
          label={t(CHANNEL_LABEL[key])}
          on={card[key]}
          state={card[key] ? t('channelStateOn') : t('channelStateOff')}
          disabled={closed}
          onToggle={() => open(channelSpec(card, key, copy, freshCard))}
        />
      ))}
      {closed && <p className="money-caption">{t('channelsClosedReason')}</p>}
    </DepthPanel>
  );
}
