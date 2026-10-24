import { Button } from '../../shared/ui';
import { decimalSchema, parseAmount } from '../../shared/money';
import type { Space } from './client';
import { date, funds, iso, startsField, type ActionSpec } from './components';
import { spaceLockStateSchema } from './contracts';
import { spaceLockCopy } from './space-lock-copy';

/** Whether a space is locked now, as the bank last said. An early unlock that took effect already came back as no lock. */
export const lockedNow = (space: Pick<Space, 'lockedUntil'>, now = Date.now()) =>
  space.lockedUntil !== null && Date.parse(space.lockedUntil) > now;

/**
 * Goal and lock of one of the person's own named spaces (BK-pots-02, J-bank-07 #1 and #2): set or clear the goal, lock it
 * or keep it locked longer, ask to unlock it early, and withdraw that ask. Each goes through the review and is the bank's
 * answer; a lock never gets shorter here, and when an early unlock opens is the bank's waiting time, shown once it has
 * the request.
 */
export function SpaceLockActions({ space, open }: { space: Space; open: (spec: ActionSpec) => void }) {
  const { t } = spaceLockCopy.useCopy();
  if (space.kind !== 'named') return null;
  const locked = lockedNow(space);
  const waiting = locked && !!space.unlocksAt;
  const facts = (): [string, string][] => [[t('space'), space.name]];
  const outcome = (data: unknown): [string, string][] | null => {
    const state = spaceLockStateSchema.safeParse(data);
    if (!state.success) return null;
    const rows: [string, string][] = [
      [t('goalNow'), state.data.goalTarget === null ? t('goalCleared') : funds(state.data.goalTarget, space.assetId)],
      [t('lockField'), date(state.data.lockedUntil)],
    ];
    if (state.data.unlocksAt) rows.push([t('opensAt'), date(state.data.unlocksAt)]);
    return rows;
  };
  return (
    <>
      <Button
        variant="ghost"
        onClick={() =>
          open({
            title: t('goalTitle'),
            procedure: 'spaces.setGoal',
            facts: [...facts(), [t('goalNow'), space.goalTarget === null ? t('goalCleared') : funds(space.goalTarget, space.assetId)]],
            fields: [
              {
                name: 'goalTarget',
                label: t('goalField'),
                unit: space.assetId,
                hint: t('goalHint'),
                optional: true,
                validate: (value) => (decimalSchema.safeParse(value).success && parseAmount(value) > 0n ? null : t('goalInvalid')),
              },
            ],
            notes: [t('goalNote')],
            input: (values) => ({ spaceId: space.id, goalTarget: values.goalTarget ? values.goalTarget : null }),
            describeOutcome: outcome,
          })
        }
      >
        {t('setGoal')}
      </Button>
      <Button
        variant="ghost"
        onClick={() =>
          open({
            title: t('lockTitle'),
            procedure: 'spaces.setLock',
            facts: locked ? [...facts(), [t('lockNow'), date(space.lockedUntil)]] : facts(),
            fields: [{ ...startsField, name: 'lockedUntil', label: t('lockField') }],
            notes: [t('lockNote'), ...(locked ? [t('lockLongerNote')] : []), ...(waiting ? [t('lockEndsEarlyUnlock')] : [])],
            input: (values) => ({ spaceId: space.id, lockedUntil: iso(values.lockedUntil ?? '') }),
            describeOutcome: outcome,
          })
        }
      >
        {locked ? t('lockLonger') : t('lock')}
      </Button>
      {locked && !waiting && (
        <Button
          variant="ghost"
          onClick={() =>
            open({
              title: t('unlockTitle'),
              procedure: 'spaces.requestUnlock',
              facts: [...facts(), [t('lockNow'), date(space.lockedUntil)]],
              notes: [t('unlockNote'), t('unlockWhen')],
              input: () => ({ spaceId: space.id }),
              submit: t('unlockConfirm'),
              describeOutcome: outcome,
            })
          }
        >
          {t('unlockEarly')}
        </Button>
      )}
      {waiting && (
        <Button
          variant="ghost"
          onClick={() =>
            open({
              title: t('keepTitle'),
              procedure: 'spaces.cancelUnlock',
              facts: [...facts(), [t('lockNow'), date(space.lockedUntil)], [t('opensAt'), date(space.unlocksAt ?? null)]],
              notes: [t('keepNote')],
              input: () => ({ spaceId: space.id }),
              describeOutcome: outcome,
            })
          }
        >
          {t('keepLocked')}
        </Button>
      )}
    </>
  );
}

/** When a space asked to unlock early opens, as a detail row. Nothing when no early unlock waits. */
export function EarlyUnlock({ space }: { space: Space }) {
  const { t } = spaceLockCopy.useCopy();
  if (!space.unlocksAt || !lockedNow(space)) return null;
  return (
    <div className="money-selected-unlock" data-testid="space-early-unlock" data-opens={space.unlocksAt}>
      <dt>{t('opensAt')}</dt>
      <dd>{date(space.unlocksAt)}</dd>
      <dd className="money-caption">{t('opensNote')}</dd>
    </div>
  );
}
