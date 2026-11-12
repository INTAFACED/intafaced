import { useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Field, Input, Switch } from '@intafaced/ui';
import { displayAmount } from '../../../shared/money';
import type { createRoomApi, GridBot } from './api';
import { roomCopy } from './copy';
import type { Failure } from './guard';
import { RefusalNote } from './parts';

// One key per top-up intent: kept while a reply is lost, so a resend is the same top-up; renewed after any answer.
const newRequestKey = () => `topup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The service's own words for a refusal that names a figure (the free balance a top-up was checked against). */
function FigureNote({ failure }: { failure: Failure }) {
  if (failure.code !== 'trade.bots_grid_topup_exceeds_free') return null;
  return <p className="cb-note-body">{failure.message}</p>;
}

/**
 * Top up a running grid's quote (CB-bots-04; J-copy-bots-otc-15 #1). The investment, which is the bot's cap, rises by
 * the amount and the grid re-plans its levels once; the service checks the amount against the person's free balance
 * less every other bot and copy, and refuses a top-up in the base coin. Nothing is moved: the bot only sets more aside.
 */
export function GridTopUp({ bot, api, onDone }: { bot: GridBot; api: ReturnType<typeof createRoomApi>; onDone: () => void }) {
  const { t } = roomCopy.useCopy();
  const [open, setOpen] = useState(false);
  const [asset, setAsset] = useState(bot.quoteAsset);
  const [amount, setAmount] = useState('');
  const [requestId, setRequestId] = useState(newRequestKey);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<{ amount: string; investment: string } | null>(null);

  const reset = () => {
    setAsset(bot.quoteAsset);
    setAmount('');
    setRequestId(newRequestKey());
    setFailure(null);
    setDone(null);
  };

  async function send() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await api.gridTopUp({ botId: bot.botId, requestId, asset, amount });
    setBusy(false);
    if (result.ok) {
      setDone({ amount: result.data.amount, investment: result.data.investmentAfter });
      setRequestId(newRequestKey());
      onDone();
      return;
    }
    setFailure(result);
    if (result.reason !== 'uncertain') setRequestId(newRequestKey());
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('Top up')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent className="cb-dialog">
          <DialogHeader>
            <DialogTitle>{t('Top up this grid')}</DialogTitle>
            <DialogDescription>
              {t(
                'The bot may use more of your free {asset}: its investment rises by the amount and its levels are planned again. Nothing is moved.',
                {
                  asset: bot.quoteAsset,
                },
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="cb-form">
            <label className="cb-selectfield">
              <span className="cb-label">{t('Asset')}</span>
              <select value={asset} onChange={(e) => setAsset(e.target.value)} disabled={busy}>
                <option value={bot.quoteAsset}>{bot.quoteAsset}</option>
                <option value={bot.baseAsset}>{bot.baseAsset}</option>
              </select>
            </label>
            <Field label={t('Amount')}>
              <Input kind="decimal" value={amount} onValueChange={setAmount} precision={8} trailing={asset} disabled={busy} />
            </Field>
            <p className="cb-note-body">
              {t('Investment now: {amount} {asset}', { amount: displayAmount(bot.investment), asset: bot.quoteAsset })}
            </p>
            <Button disabled={busy} onClick={() => void send()}>
              {t('Top up')}
            </Button>
            {done ? (
              <p role="status" className="cb-note-body">
                {t('Topped up by {amount} {asset}. The investment is now {investment} {asset}.', {
                  amount: displayAmount(done.amount),
                  investment: displayAmount(done.investment),
                  asset: bot.quoteAsset,
                })}
              </p>
            ) : null}
            {failure ? (
              <>
                <RefusalNote failure={failure} />
                <FigureNote failure={failure} />
              </>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * A running grid's settings (CB-bots-04; J-copy-bots-otc-15 #2): trailing, its shift limit and the minimum grid count.
 * The service checks each field and names the one that is wrong; trailing itself is not built, so a request that passes
 * every check is refused with that reason and the grid keeps its range.
 */
export function GridSettings({ bot, api }: { bot: GridBot; api: ReturnType<typeof createRoomApi> }) {
  const { t } = roomCopy.useCopy();
  const [editing, setEditing] = useState(false);
  const [trailing, setTrailing] = useState(false);
  const [shiftLimit, setShiftLimit] = useState('');
  const [minCount, setMinCount] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const min = minCount.trim();
    const result = await api.gridModify({
      botId: bot.botId,
      trailing,
      shiftLimitPercent: shiftLimit,
      minGridCount: min === '' ? null : Number(min),
    });
    setBusy(false);
    if (result.ok) {
      setEditing(false);
      return;
    }
    setFailure(result);
  }

  if (!editing) {
    return (
      <Button variant="secondary" onClick={() => setEditing(true)}>
        {t('Change')}
      </Button>
    );
  }
  return (
    <section aria-label={t('Grid settings')} className="cb-form">
      <label className="cb-selectfield">
        <span className="cb-label">{t('Trailing')}</span>
        <Switch checked={trailing} onCheckedChange={setTrailing} aria-label={t('Trailing')} disabled={busy} />
      </label>
      <Field label={t('Shift limit, %')}>
        <Input kind="decimal" value={shiftLimit} onValueChange={setShiftLimit} precision={2} disabled={busy} />
      </Field>
      <Field label={t('Minimum grid count')}>
        <Input value={minCount} onValueChange={setMinCount} inputMode="numeric" disabled={busy} />
      </Field>
      <p className="cb-note-body">{t('This grid has {count} grids.', { count: String(bot.gridCount) })}</p>
      <div className="cb-action-row">
        <Button disabled={busy} onClick={() => void save()}>
          {t('Save')}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => setEditing(false)}>
          {t('Cancel')}
        </Button>
      </div>
      {failure ? <RefusalNote failure={failure} /> : null}
    </section>
  );
}
