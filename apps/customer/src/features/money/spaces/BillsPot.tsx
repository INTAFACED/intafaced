import { Button } from '@intafaced/ui/lit';
import type { Space } from '../client';
import type { ActionSpec } from '../components';
import { billsPotCopy } from '../bills-pot-copy';
import { BANK_SPACES_CLEAR_BILLS_POT, BANK_SPACES_SET_BILLS_POT } from '@intafaced/contracts/bank-spaces-procedures';

/**
 * The bills pot on one of the person's own named spaces (BK-pots-03, J-bank-07 #4): whether this pot pays their bills,
 * and whether a standing order from it that finds too little tops it up from the account first. Each change goes
 * through the review and is the bank's answer; the top-up starts off.
 */
export function BillsPotState({ space }: { space: Space }) {
  const { t } = billsPotCopy.useCopy();
  if (space.kind !== 'named') return null;
  const pot = space.billsPot ?? null;
  return (
    <div data-testid="bills-pot" data-state={pot ? (pot.fallback ? 'fallback' : 'bills') : 'none'}>
      <dt>{t('title')}</dt>
      <dd>{pot ? t('isBills') : t('notBills')}</dd>
      {pot && <dd className="lt-hint">{t(pot.fallback ? 'fallbackOn' : 'fallbackOff')}</dd>}
    </div>
  );
}

export function BillsPotActions({ space, open }: { space: Space; open: (spec: ActionSpec) => void }) {
  const { t } = billsPotCopy.useCopy();
  if (space.kind !== 'named') return null;
  const pot = space.billsPot ?? null;
  const set = (fallback: boolean, title: string, note: string, submit: string) =>
    open({
      title,
      record: BANK_SPACES_SET_BILLS_POT,
      facts: [
        [t('pot'), space.name],
        [t('topUp'), t(fallback ? 'on' : 'off')],
      ],
      notes: [note],
      input: () => ({ spaceId: space.id, fallback }),
      describeOutcome: (data) => {
        const row = BANK_SPACES_SET_BILLS_POT.output.safeParse(data);
        return row.success
          ? [
              [t('pot'), space.name],
              [t('topUp'), t(row.data.fallback ? 'on' : 'off')],
            ]
          : null;
      },
      submit,
    });
  if (!pot) {
    return (
      <Button tone="quiet" onClick={() => set(false, t('useTitle'), t('useNote'), t('use'))}>
        {t('use')}
      </Button>
    );
  }
  return (
    <>
      {pot.fallback ? (
        <Button tone="quiet" onClick={() => set(false, t('turnOffTitle'), t('turnOffNote'), t('turnOff'))}>
          {t('turnOff')}
        </Button>
      ) : (
        <Button tone="quiet" onClick={() => set(true, t('turnOnTitle'), t('turnOnNote'), t('turnOn'))}>
          {t('turnOn')}
        </Button>
      )}
      <Button
        tone="quiet"
        onClick={() =>
          open({
            title: t('stopTitle'),
            record: BANK_SPACES_CLEAR_BILLS_POT,
            facts: [[t('pot'), space.name]],
            notes: [t('stopNote')],
            input: () => ({ spaceId: space.id }),
            submit: t('stop'),
          })
        }
      >
        {t('stop')}
      </Button>
    </>
  );
}
