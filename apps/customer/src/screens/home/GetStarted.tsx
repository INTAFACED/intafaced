import { Check, ChevronRight, Clock, X } from 'lucide-react';
import { Button } from '@intafaced/ui/lit';
import { homeCopy } from './copy';
import { Ghost, StatusTag } from './volt-parts';
import { progress, type Step, type StepId, type StepStatus } from './started';

const TITLE = {
  register: 'Step register',
  verify: 'Step verify',
  secure: 'Step secure',
  deposit: 'Step deposit',
  trade: 'Step trade',
  alert: 'Step alert',
} as const satisfies Record<StepId, string>;
const HINT = {
  register: 'Step register hint',
  verify: 'Step verify hint',
  secure: 'Step secure hint',
  deposit: 'Step deposit hint',
  trade: 'Step trade hint',
  alert: 'Step alert hint',
} as const satisfies Record<StepId, string>;

function Mark({ status }: { status: StepStatus }) {
  return (
    <span data-status={status} aria-hidden="true">
      {status === 'done' ? <Check size={14} strokeWidth={3} /> : status === 'review' ? <Clock size={14} /> : null}
    </span>
  );
}

function Trailing({ step }: { step: Step }) {
  const { t } = homeCopy.useCopy();
  switch (step.status) {
    case 'done':
      return <StatusTag status="filled" label={t('Done')} />;
    case 'review':
      return <StatusTag status="pending" label={t('In review')} />;
    case 'checking':
      return <Ghost shape="text" count={1} />;
    case 'unknown':
      return <span className="lt-hint">{t('Couldn’t check')}</span>;
    default:
      return <ChevronRight size={20} aria-hidden="true" />;
  }
}

function Row({ step }: { step: Step }) {
  const { t } = homeCopy.useCopy();
  const done = step.status === 'done';
  const body = (
    <>
      <Mark status={step.status} />
      <span className="lt-lines">
        <span data-testid="home-started__title" data-done={done}>
          {t(TITLE[step.id])}
        </span>
        {done ? null : <span className="lt-hint">{t(step.status === 'review' ? 'Step verify review' : HINT[step.id])}</span>}
      </span>
      <Trailing step={step} />
    </>
  );
  return (
    <li>
      {/* One link across the whole row, at the kit's row height: a step whose answer comes back done (no hint line) keeps
          its row's place. */}
      <a
        data-testid="home-started__row"
        className="lt-row-link"
        data-span="row"
        href={step.href}
        data-step={step.id}
        data-status={step.status}
      >
        {body}
      </a>
    </li>
  );
}

/**
 * "Get started" (ROADMAP M8, HM-widgets-02): six steps, from creating the account to a first price alert. Each shows done or not from the real answers; a step
 * whose answer has not come, or could not be read, never claims to be done. The person can hide the list.
 */
export function GetStarted({ steps, onHide }: { steps: Step[]; onHide: () => void }) {
  const { t } = homeCopy.useCopy();
  const count = progress(steps);
  return (
    <section data-testid="home-started" className="lt-stack" aria-labelledby="home-started-title">
      <div className="lt-title-row">
        <h2 id="home-started-title">{t('Get started')}</h2>
        <span data-testid="home-started__count" className="lt-hint">
          {count.settled ? t('Steps done', { done: count.done, total: count.total }) : <Ghost shape="text" count={1} />}
        </span>
        <Button tone="quiet" onClick={onHide} aria-label={t('Hide Get started')}>
          <X size={16} aria-hidden="true" />
        </Button>
      </div>
      <div data-testid="home-started__bar" className="lt-steps" aria-hidden="true">
        {steps.map((step) => (
          <span key={step.id} className="lt-step-dot" data-on={step.status === 'done'} />
        ))}
      </div>
      <ul className="lt-rows">
        {steps.map((step) => (
          <Row key={step.id} step={step} />
        ))}
      </ul>
    </section>
  );
}
