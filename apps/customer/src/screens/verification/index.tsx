import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import './verification.css';
import {
  Button,
  Card,
  Chip,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Note,
  refusalCopy,
  Row,
  Rows,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StateBlock,
  stamp,
  StatusTag,
  TextField,
  usePreferences,
  type VerificationRecord,
} from './deps';
import { verificationScreenCopy } from './copy';
import { askable, LEVELS, levelState, type Held, type Level, type LevelState } from './levels';
import { useVerification, type Known } from './use-verification';

type Copy = ReturnType<typeof verificationScreenCopy.useCopy>['t'];

const heldTag = { none: 'working', basic: 'filled', full: 'filled', institutional: 'filled' } as const;
const recordTag = { pending: 'pending', approved: 'filled', rejected: 'failed', expired: 'cancelled' } as const;

function levelName(t: Copy, level: Held): string {
  return level === 'none' ? t('Not verified') : level === 'basic' ? t('Basic') : level === 'full' ? t('Full') : t('Institutional');
}
function summary(t: Copy, level: Held): string {
  return level === 'none'
    ? t('Summary none')
    : level === 'basic'
      ? t('Summary basic')
      : level === 'full'
        ? t('Summary full')
        : t('Summary institutional');
}
function statusWord(t: Copy, status: VerificationRecord['status']): string {
  return status === 'pending' ? t('Pending') : status === 'approved' ? t('Approved') : status === 'rejected' ? t('Rejected') : t('Expired');
}

/** Verification (UI-SPEC 5.13): your level, what each level unlocks, and the requests you've made. */
export default function Verification() {
  const { t } = verificationScreenCopy.useCopy();
  const flow = useVerification();
  const { resource, reload, userId } = flow;
  const [asking, setAsking] = useState(false);
  // A reply that says a request was opened or turned down: read the list again so it shows without a reload.
  const answered = flow.known.length;
  useEffect(() => {
    if (answered > 0) reload();
  }, [answered]);

  if (!userId)
    return (
      <div className="vf">
        <h1 className="vf-h1">{t('Verification')}</h1>
        <StateBlock kind="empty" title={t('Sign in to see')} action={{ label: t('Sign in'), href: '/login?redirect=%2Fverification' }} />
      </div>
    );

  const held: Held = resource.status === 'ready' ? resource.data.tier : 'none';
  const records = resource.status === 'ready' ? resource.data.records : [];
  const open = askable(held, records);
  const target = flow.chosenTier;
  const pendingLevel = LEVELS.find((level) => levelState(held, level, records) === 'pending');

  function begin(level: Level) {
    flow.setTier(level);
    setAsking(true);
  }

  return (
    <div className="vf">
      <header className="vf-head">
        <h1 className="vf-h1">{t('Verification')}</h1>
        <p className="sk-lead">{t('Verification lead')}</p>
      </header>

      <Outcomes flow={flow} />

      {resource.status === 'loading' ? (
        <Card label={t('Your level')}>
          <StateBlock kind="loading" rows={3} rowHeight={56} label={t('Your level')} />
        </Card>
      ) : resource.status === 'failed' ? (
        <Card label={t('Your level')}>
          <Failed failure={resource.failure} onRetry={reload} />
        </Card>
      ) : (
        <>
          <Card title={t('Your level')}>
            <div className="vf-level">
              <StatusTag className="h-10 rounded-sm px-5 text-lg font-semibold" status={heldTag[held]} label={levelName(t, held)} />
              <p className="vf-level__line">{summary(t, held)}</p>
            </div>
            {pendingLevel ? (
              <Note role="status">
                <p>{t('Review waiting', { level: levelName(t, pendingLevel) })}</p>
              </Note>
            ) : null}
            {open.length > 0 ? (
              <div>
                <Button variant="primary" size={40} disabled={flow.blocked} onClick={() => begin(open[0]!)}>
                  {t('Ask for', { level: levelName(t, open[0]!) })}
                </Button>
              </div>
            ) : null}
          </Card>

          <Card title={t('Levels')} lead={t('Levels lead')}>
            <ol className="vf-ladder">
              {LEVELS.map((level, index) => (
                <LevelBlock
                  key={level}
                  level={level}
                  step={index + 1}
                  state={levelState(held, level, records)}
                  blocked={flow.blocked}
                  onAsk={() => begin(level)}
                />
              ))}
            </ol>
            <p className="sk-small">{t('Limits note')}</p>
          </Card>

          <Card title={t('How it works')}>
            <ol className="vf-steps">
              {([1, 2, 3] as const).map((n) => (
                <li key={n} className="vf-step">
                  <span className="vf-step__n" aria-hidden="true">
                    {n}
                  </span>
                  <span className="vf-step__title">{t(`Step ${n} title`)}</span>
                  <span className="sk-small">{t(`Step ${n} body`)}</span>
                </li>
              ))}
            </ol>
            <p className="sk-small">{t('Cant upload')}</p>
          </Card>

          <Card
            title={t('Your requests')}
            action={
              <Button variant="secondary" size={32} onClick={reload}>
                {t('Refresh')}
              </Button>
            }
          >
            <Requests records={records} flow={flow} />
          </Card>
        </>
      )}

      <p className="vf-foot">
        <span className="sk-small">{t('Questions')}</span>{' '}
        <a className="sk-link" href="/support">
          {t('Contact support')}
        </a>
      </p>

      <AskDialog
        flow={flow}
        asking={asking}
        levels={open}
        target={target}
        onClose={() => {
          flow.close();
          setAsking(false);
        }}
        onSent={() => setAsking(false)}
      />
    </div>
  );
}

function Failed({ failure, onRetry }: { failure: { reason: string; code?: string }; onRetry: () => void }) {
  const { t } = verificationScreenCopy.useCopy();
  if (failure.code && (failure.reason === 'forbidden' || failure.reason === 'error')) {
    const words = refusalCopy(failure.code);
    return <StateBlock kind="refused" title={words.title} body={words.body} code={words.reference} action={words.action} />;
  }
  return <StateBlock kind="error" title={t('Could not load')} onRetry={onRetry} retryLabel={t('Try again')} />;
}

function LevelBlock({
  level,
  step,
  state,
  blocked,
  onAsk,
}: {
  level: Level;
  step: number;
  state: LevelState;
  blocked: boolean;
  onAsk: () => void;
}) {
  const { t } = verificationScreenCopy.useCopy();
  const name = levelName(t, level);
  const done = state === 'current' || state === 'included';
  return (
    <li className="vf-level-block" data-state={state}>
      <span className="vf-mark" aria-hidden="true">
        {done ? <Check size={16} strokeWidth={2.25} /> : step}
      </span>
      <div className="vf-level-block__body">
        <div className="vf-level-block__head">
          <h3 className="sk-h3">{name}</h3>
          {state === 'current' ? <Chip tone="good">{t('Current')}</Chip> : null}
          {state === 'included' ? <Chip>{t('Included')}</Chip> : null}
          {state === 'pending' ? <Chip tone="warn">{t('In review')}</Chip> : null}
          {state === 'declined' ? <Chip tone="warn">{t('Declined')}</Chip> : null}
          {state === 'available' || state === 'declined' ? (
            <Button
              className="vf-level-block__ask"
              variant="secondary"
              size={32}
              disabled={blocked}
              onClick={onAsk}
              aria-label={t('Ask for', { level: name })}
            >
              {t('Ask for', { level: name })}
            </Button>
          ) : null}
        </div>
        <dl className="vf-facts">
          <div>
            <dt>{t('What it unlocks')}</dt>
            <dd>
              <ul className="vf-bullets">
                <li>{t(`Unlock ${level} 1`)}</li>
                <li>{t(`Unlock ${level} 2`)}</li>
              </ul>
            </dd>
          </div>
          <div>
            <dt>{t('Limits')}</dt>
            <dd className="vf-limits">
              <span aria-hidden="true">—</span> <span>{t('Limits not set')}</span>
            </dd>
          </div>
        </dl>
      </div>
    </li>
  );
}

function Requests({ records, flow }: { records: readonly VerificationRecord[]; flow: ReturnType<typeof useVerification> }) {
  const { t } = verificationScreenCopy.useCopy();
  const { timeZone } = usePreferences();
  const { limit, setLimit, selected, setSelected } = flow;
  if (records.length === 0) return <StateBlock kind="empty" title={t('No requests')} body={t('No requests body')} />;
  return (
    <>
      <Rows label={t('Your requests')}>
        {records.map((row) => {
          const open = selected?.id === row.id;
          return (
            <Row
              key={row.id}
              title={levelName(t, row.tier)}
              chip={<StatusTag status={recordTag[row.status]} label={statusWord(t, row.status)} />}
              line={`${t('Country')} ${row.jurisdiction} · ${stamp(row.createdAt, timeZone)}`}
              action={
                <Button variant="ghost" size={32} aria-expanded={open} onClick={() => setSelected(open ? null : { ...row })}>
                  {open ? t('Hide details') : t('Details')}
                </Button>
              }
            >
              {open ? (
                <dl className="vf-record">
                  <div>
                    <dt>{t('Asked')}</dt>
                    <dd>{stamp(row.createdAt, timeZone)}</dd>
                  </div>
                  <div>
                    <dt>{t('Reviewed')}</dt>
                    <dd>{row.reviewedAt ? stamp(row.reviewedAt, timeZone) : t('Not yet')}</dd>
                  </div>
                  <div>
                    <dt>{t('Expires')}</dt>
                    <dd>{row.expiresAt ? stamp(row.expiresAt, timeZone) : t('Never expires')}</dd>
                  </div>
                </dl>
              ) : null}
            </Row>
          );
        })}
      </Rows>
      {limit < 200 && records.length === limit ? (
        <div>
          <Button variant="secondary" size={32} onClick={() => setLimit((value: number) => Math.min(200, value + 50))}>
            {t('Show more')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** What happened to the request just sent, and the saved note when a result is still unknown. All words come from the safety catalog. */
function Outcomes({ flow }: { flow: ReturnType<typeof useVerification> }) {
  const { t } = verificationScreenCopy.useCopy();
  const { timeZone } = usePreferences();
  const { journal, known, problem, privateVisible, busy } = flow;
  if (!privateVisible) return null;
  const unknown = journal.records.filter(
    (local) =>
      !known.some(
        (receipt) =>
          receipt.local.requestId === local.requestId &&
          receipt.local.owner === local.owner &&
          receipt.local.kind === local.kind &&
          receipt.local.createdAt === local.createdAt,
      ),
  );
  const shown = problem && problem !== 'invalidCountry' ? problem : journal.failed ? 'storage' : null;
  if (!shown && unknown.length === 0 && known.length === 0) return null;
  return (
    <div className="vf-outcomes" aria-label={t('Request status')}>
      {shown ? (
        <Note tone="warn" role="status">
          <p>{t(`Problem ${shown}`)}</p>
        </Note>
      ) : null}
      {unknown.map((local) => (
        <Note key={local.requestId} tone="warn" role="status">
          <h3 className="sk-h3">{busy ? t('Sending title') : t('Unknown title')}</h3>
          <p>{t('Unknown body')}</p>
          <p>{t('Sent at', { time: stamp(local.createdAt, timeZone) })}</p>
          <p>{t('On hold')}</p>
          <details>
            <summary>{t('Reference for support')}</summary>
            <p className="sk-mono">{local.requestId}</p>
          </details>
          <a className="sk-link" href="/support">
            {t('Contact support')}
          </a>
        </Note>
      ))}
      {known.map((receipt) => (
        <Receipt key={receipt.local.requestId} receipt={receipt} flow={flow} />
      ))}
    </div>
  );
}

function Receipt({ receipt, flow }: { receipt: Known; flow: ReturnType<typeof useVerification> }) {
  const { t } = verificationScreenCopy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <Note tone={receipt.refused ? 'warn' : 'good'} role="status">
      <h3 className="sk-h3">{receipt.refused ? t('Declined title') : t('Received title')}</h3>
      <p>{t('You asked for', { level: levelName(t, receipt.original.tier), country: receipt.original.country })}</p>
      {receipt.row ? (
        <>
          <p>
            {t('Status line', { status: statusWord(t, receipt.row.status) })} {stamp(receipt.row.createdAt, timeZone)}
          </p>
          <p>{t('Level only changes')}</p>
        </>
      ) : (
        <p>{t('Declined body')}</p>
      )}
      {receipt.retained ? (
        <>
          <h3 className="sk-h3">{t('Last step title')}</h3>
          <p>{t('Last step body')}</p>
          <details>
            <summary>{t('Reference for support')}</summary>
            <p className="sk-mono">{receipt.local.requestId}</p>
          </details>
          <div>
            <Button variant="secondary" size={32} disabled={flow.busy} onClick={() => void flow.finalize(receipt)}>
              {t('Clear note')}
            </Button>
          </div>
        </>
      ) : null}
      {receipt.finalized ? <p>{t('Note cleared')}</p> : null}
    </Note>
  );
}

function AskDialog({
  flow,
  asking,
  levels,
  target,
  onClose,
  onSent,
}: {
  flow: ReturnType<typeof useVerification>;
  asking: boolean;
  levels: Level[];
  target: Level;
  onClose: () => void;
  onSent: () => void;
}) {
  const { t } = verificationScreenCopy.useCopy();
  const { review, problem, country, setCountry, setTier, busy, blocked } = flow;
  const reviewing = review && flow.same(review) ? review : null;
  const open = asking || reviewing !== null;
  const items = Object.fromEntries(levels.map((level) => [level, levelName(t, level)]));
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent closeLabel={t('Cancel')}>
        {reviewing ? (
          <div className="sk-dialog">
            <DialogHeader>
              <DialogTitle>{t('Review title')}</DialogTitle>
              <DialogDescription>{t('Ask dialog body')}</DialogDescription>
            </DialogHeader>
            <dl className="sk-facts">
              <dt>{t('Level')}</dt>
              <dd>{levelName(t, reviewing.tier)}</dd>
              <dt>{t('Country')}</dt>
              <dd>{reviewing.country}</dd>
            </dl>
            <p className="sk-small">{t('Review note')}</p>
            <DialogFooter>
              <Button variant="ghost" size={40} disabled={busy} onClick={onClose}>
                {t('Cancel')}
              </Button>
              <Button
                variant="primary"
                size={40}
                loading={busy}
                onClick={() => {
                  onSent();
                  void flow.dispatch(reviewing);
                }}
              >
                {t('Send')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="sk-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              flow.open();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('Ask dialog title')}</DialogTitle>
              <DialogDescription>{t('Ask dialog body')}</DialogDescription>
            </DialogHeader>
            {levels.length > 1 ? (
              <div className="sk-field">
                <span className="sk-field__label" id="vf-level-label">
                  {t('Level')}
                </span>
                <Select items={items} value={target} onValueChange={(value) => setTier(value as Level)}>
                  <SelectTrigger aria-labelledby="vf-level-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {levels.map((level) => (
                      <SelectItem key={level} value={level}>
                        {levelName(t, level)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="sk-small">
                {t('Level')}: <strong>{levelName(t, target)}</strong>
              </p>
            )}
            <TextField
              label={t('Country code')}
              hint={t('Country hint')}
              error={problem === 'invalidCountry' ? t('Problem invalidCountry') : null}
              name="kyc-country"
              required
              minLength={2}
              maxLength={2}
              autoComplete="country"
              value={country}
              onChange={(event) => setCountry(event.target.value)}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" size={40} onClick={onClose}>
                {t('Cancel')}
              </Button>
              <Button type="submit" variant="primary" size={40} disabled={blocked}>
                {t('Continue')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
