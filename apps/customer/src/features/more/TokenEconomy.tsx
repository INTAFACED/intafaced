// hand-declared-ok: svc-token's emissionSchedule, treasury and yieldHistory outputs are declared in its router; packages/contracts has no token schemas yet
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { decimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { DataTable, EmptyState, Panel } from '../../shared/ui';
import { Details, Read } from './common';
import { tokenEconomyCopy } from './token-economy-copy';

const paramsReason = z.enum(['token.params_unset', 'token.params_missing', 'token.params_invalid']);

/** The token service's `emissionSchedule` read: the owner's parameters and the next epochs' rewards, or why they are blank. */
export const emissionScheduleSchema = z
  .object({
    params: z
      .object({
        initialEpochReward: decimalSchema,
        halvingIntervalEpochs: z.number().int().positive(),
        maxSupply: decimalSchema,
      })
      .nullable(),
    epochs: z.array(z.object({ epoch: z.number().int().nonnegative(), reward: decimalSchema })).nullable(),
    missing: z.string().nullable(),
    reason: paramsReason.nullable(),
  })
  .refine((r) => (r.params === null) === (r.reason !== null), 'emission schedule is neither set nor refused');

/** Only `minted` of the treasury read is drawn here: the lifetime sum of closed mints, null when none closed. */
export const mintedSchema = z.object({ minted: decimalSchema.nullable() });

/** The token service's `yieldHistory` read: this account's real-yield payouts, one row per weekly window. */
export const yieldHistorySchema = z.object({
  items: z.array(
    z.object({
      windowId: z.string().min(1),
      amount: decimalSchema.nullable(),
      assetId: z.string().nullable(),
      ledgerTxId: z.string().nullable(),
      reason: z.literal('ledger_tx_unread').nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export type EmissionScheduleRead = z.infer<typeof emissionScheduleSchema>;
export type MintedRead = z.infer<typeof mintedSchema>;
export type YieldHistoryRead = z.infer<typeof yieldHistorySchema>;
type Loaded<T> = { resource: Resource<T>; reload: () => void };

const EPOCHS = 12;
const YIELD_LIMIT = 50;

/** Emission epochs, halvings and the minter rule (J-more-catalogue-20 #4), read from the token service. */
export function EmissionSchedule() {
  const api = useApi();
  const { userId } = useSession();
  const schedule = useResource(
    (signal) => api.query('token', 'emissionSchedule', { count: EPOCHS }, emissionScheduleSchema, { signal }),
    `token-emission-schedule:${userId}`,
  );
  const minted = useResource((signal) => api.query('token', 'treasury', undefined, mintedSchema, { signal }), `token-minted:${userId}`);
  return <EmissionScheduleView schedule={schedule} minted={minted} />;
}

/** A blank owner value reads "not set" with no figure; an unreadable one is not called blank. */
export function EmissionScheduleView({ schedule, minted }: { schedule: Loaded<EmissionScheduleRead>; minted: Loaded<MintedRead> }) {
  const { hideBalances } = usePreferences();
  const { Copy, t } = tokenEconomyCopy.useCopy();
  const shown = (value: string) => (hideBalances ? '••••' : displayAmount(value));
  return (
    <Panel title={t('emissionTitle')} aria-label={t('emissionTitle')}>
      <p className="muted">
        <Copy k="emissionBody" />
      </p>
      <Read resource={schedule.resource} retry={schedule.reload}>
        {(data) => {
          const blank = data.reason === 'token.params_invalid' ? t('unreadable') : t('notSet');
          const epochs = data.epochs ?? [];
          return (
            <>
              <div data-testid="emission-params">
                <Details
                  items={[
                    [t('initialReward'), data.params ? shown(data.params.initialEpochReward) : blank],
                    [t('halving'), data.params ? t('halvingEvery', { epochs: data.params.halvingIntervalEpochs }) : blank],
                    [t('cap'), data.params ? shown(data.params.maxSupply) : blank],
                  ]}
                />
              </div>
              {data.params === null && (
                <p role="status" data-testid="emission-blank">
                  {data.reason === 'token.params_invalid' ? t('scheduleUnreadable') : t('scheduleUnset')}
                </p>
              )}
              <DataTable headers={[t('epoch'), t('reward'), t('change')]} label={t('epochsTitle')}>
                {epochs.map((row, i) => {
                  const halved = i > 0 && parseAmount(row.reward) < parseAmount(epochs[i - 1]!.reward);
                  return (
                    <tr key={row.epoch}>
                      <td>{row.epoch}</td>
                      <td className="numeric">{shown(row.reward)}</td>
                      <td>{halved ? t('halvedHere') : ''}</td>
                    </tr>
                  );
                })}
              </DataTable>
              {epochs.length === 0 && <EmptyState title={t('noEpochs')} />}
            </>
          );
        }}
      </Read>
      <Read resource={minted.resource} retry={minted.reload}>
        {(data) => (
          <p data-testid="emission-minted">{data.minted === null ? t('mintedNone') : t('minted', { amount: shown(data.minted) })}</p>
        )}
      </Read>
      <p data-testid="emission-minter">
        <Copy k="minterRule" />
      </p>
    </Panel>
  );
}

/** This account's weekly real-yield share per window (J-more-catalogue-20 #2), as the token service paid it. */
export function YieldHistory() {
  const api = useApi();
  const { userId } = useSession();
  const read = useResource(
    (signal) => api.query('token', 'yieldHistory', { limit: YIELD_LIMIT }, yieldHistorySchema, { signal }),
    `token-yield-history:${userId}`,
  );
  return <YieldHistoryView read={read} />;
}

/** A payout whose ledger posting cannot be read shows no amount; it is never guessed. */
export function YieldHistoryView({ read }: { read: Loaded<YieldHistoryRead> }) {
  const { hideBalances } = usePreferences();
  const { Copy, t } = tokenEconomyCopy.useCopy();
  return (
    <Panel title={t('yieldTitle')} aria-label={t('yieldTitle')}>
      <p className="muted">
        <Copy k="yieldBody" /> {t('yieldLatest', { limit: YIELD_LIMIT })}
      </p>
      <Read resource={read.resource} retry={read.reload}>
        {(data) => (
          <>
            <DataTable headers={[t('window'), t('paid'), t('posting')]} label={t('yieldTable')}>
              {data.items.map((row) => (
                <tr key={row.windowId}>
                  <td>{row.windowId}</td>
                  <td className="numeric">{row.amount === null ? t('amountUnread') : hideBalances ? '••••' : displayAmount(row.amount)}</td>
                  <td>{row.ledgerTxId ?? t('postingUnread')}</td>
                </tr>
              ))}
            </DataTable>
            {data.items.length === 0 && <EmptyState title={t('noYield')} />}
          </>
        )}
      </Read>
    </Panel>
  );
}
