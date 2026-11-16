import { useState } from 'react';
import type { VenueStatementJob, VenueUp } from '../../../features/trade/venue-api';
import { useVenueApi } from '../../../features/trade/venue/VenueKit';
import { deskCopy } from './copy';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  refusalCopy,
} from './deps';
import { sha256Hex, statementRange, todayEnd } from './ledger';
import { clockMinutes } from './time';
import { spotVenueCopy } from './venue-copy';

type Asked = { status: 'idle' } | { status: 'busy' } | { status: 'job'; job: VenueStatementJob } | { status: 'refused'; text: string };

/**
 * The statement export on the launch model (J-cex-spot-07 #5): pick the days, ask once, then save the file svc-trade built
 * from the venue's own records of this venue account (orders, trades and money movements). Asking again from the same
 * dialog is the same request key, so the same job and the same file.
 */
export function VenueStatement({ status, owner }: { status: VenueUp; owner: string | null }) {
  const { t } = spotVenueCopy.useCopy();
  const d = deskCopy.useCopy().t;
  const venue = useVenueApi();
  const [open, setOpen] = useState(false);
  // The minute the dialog opened: a range that ends today ends here, so asking twice is the same range.
  const [asOf, setAsOf] = useState(() => new Date());
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [asked, setAsked] = useState<Asked>({ status: 'idle' });
  const [saved, setSaved] = useState<string | null>(null);

  async function ask() {
    if (!owner) return;
    setSaved(null);
    const picked = statementRange(fromDay, toDay, asOf);
    if (!picked.ok) {
      setAsked({
        status: 'refused',
        text: picked.why === 'future' ? d('Statement not over') : picked.why === 'order' ? d('Statement order') : d('Statement days'),
      });
      return;
    }
    setAsked({ status: 'busy' });
    const { from, to, requestKey } = picked.range;
    const result = await venue.statement({ owner, from, to, requestKey: `venue:${owner.toLowerCase()}:${requestKey}` });
    if (result.ok) setAsked({ status: 'job', job: result.data });
    else setAsked({ status: 'refused', text: result.code ? refusalCopy(result.code).title : d('Statement refused') });
  }

  async function save(job: VenueStatementJob) {
    const result = await venue.statementFile(job.id);
    if (!result.ok) return setSaved(d('Statement save failed'));
    // The file must be the one the job fingerprinted; anything else is not saved.
    if (result.data.sha256 !== job.sha256 || (await sha256Hex(result.data.csv)) !== job.sha256)
      return setSaved(d('Statement save mismatch'));
    const url = URL.createObjectURL(new Blob([result.data.csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = result.data.filename;
    link.click();
    URL.revokeObjectURL(url);
    setSaved(d('Statement saved', { name: result.data.filename }));
  }

  const job = asked.status === 'job' ? asked.job : null;
  return (
    <>
      <Button
        variant="secondary"
        size={32}
        disabled={!owner}
        onClick={() => {
          setAsOf(new Date());
          setAsked({ status: 'idle' });
          setSaved(null);
          setOpen(true);
        }}
      >
        {t('Statement open')}
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => setOpen(next)}>
        {open ? (
          <AlertDialogContent className="dk-review">
            <AlertDialogHeader>
              <AlertDialogTitle>{t('Statement title')}</AlertDialogTitle>
              <AlertDialogDescription>{t('Statement intro', { venue: status.venue.displayName })}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="dk-statement-days">
              <label>
                <span>{d('Statement from')}</span>
                <input type="date" value={fromDay} onChange={(event) => setFromDay(event.target.value)} />
              </label>
              <label>
                <span>{d('Statement to')}</span>
                <input type="date" value={toDay} onChange={(event) => setToDay(event.target.value)} />
              </label>
            </div>
            <p className="dk-note">{d('Statement today', { time: clockMinutes(todayEnd(asOf).getTime(), 'UTC') })}</p>
            {asked.status === 'refused' ? (
              <p className="dk-note dk-note--bad" role="alert">
                {asked.text}
              </p>
            ) : null}
            {job ? (
              <p className={job.status === 'failed' ? 'dk-note dk-note--bad' : 'dk-note'} role="status">
                {job.status === 'finished' && job.rows
                  ? t('Statement ready', { orders: job.rows.orders, trades: job.rows.trades, movements: job.rows.movements, id: job.id })
                  : job.status === 'failed'
                    ? t('Statement failed', { reason: job.error ? refusalCopy(job.error).title : d('Statement refused') })
                    : d('Statement pending')}
              </p>
            ) : null}
            {job?.sha256 ? <p className="dk-note dk-note-ref">{d('Statement fingerprint', { sha: job.sha256 })}</p> : null}
            {saved ? (
              <p className="dk-note" role="status">
                {saved}
              </p>
            ) : null}
            <AlertDialogFooter>
              <Button variant="secondary" size={40} onClick={() => setOpen(false)}>
                {d('Dead man close')}
              </Button>
              {job?.status === 'finished' ? (
                <Button variant="secondary" size={40} onClick={() => void save(job)}>
                  {d('Statement download')}
                </Button>
              ) : null}
              <Button variant="primary" shape="pill" size={40} loading={asked.status === 'busy'} onClick={() => void ask()}>
                {job?.status === 'pending' ? d('Statement check again') : d('Statement request')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </>
  );
}
