import { ChevronRight } from 'lucide-react';
import { WORK_LIST_CAP_UNSET, type WorkItem, type WorkItemKind, type WorkItemSource } from '@intafaced/contracts/home-work-items';
import { dayTime } from './clock';
import { homeCopy } from './copy';
import { Amount, fmtAmount, Skeleton, StateBlock, StatusTag } from './deps';
import { IN_PANEL, STATE_IN_COLUMN } from './panel';
import { HOME_CONFIG_UNWIRED, type WorkList as List } from './work-list';
import { useWorkList } from './work-list-data';
import { usePreferences } from '../../shared/preferences';

/** The owners' copy keys Home words. A key this build does not know falls back to its kind's own words. */
const TITLE = {
  'identity.verification.start': 'Work verification start',
  'identity.verification.pending': 'Work verification pending',
  'identity.verification.rejected': 'Work verification rejected',
  'identity.verification.expired': 'Work verification expired',
  'bank.margin.call_open': 'Work margin call open',
  'bank.margin.liquidating': 'Work margin liquidating',
  'bank.card.frozen_by_you': 'Work card frozen by you',
  'bank.card.frozen_by_bank': 'Work card frozen by bank',
  'bank.card.frozen': 'Work kind card_frozen',
} as const;
const titleOf = (key: string) => (Object.hasOwn(TITLE, key) ? TITLE[key as keyof typeof TITLE] : undefined);
const KIND_TITLE = {
  verification: 'Work kind verification',
  margin_health: 'Work kind margin_health',
  loan_payment_due: 'Work kind loan_payment_due',
  card_frozen: 'Work kind card_frozen',
  payout_waiting: 'Work kind payout_waiting',
} as const satisfies Record<WorkItemKind, string>;
const SOURCE_NAME = { identity: 'Work source identity', bank: 'Work source bank', pay: 'Work source pay' } as const satisfies Record<
  WorkItemSource,
  string
>;
const SEVERITY = {
  action: { status: 'pending', label: 'Work severity action' },
  warning: { status: 'failed', label: 'Work severity warning' },
  info: { status: 'working', label: 'Work severity info' },
} as const;

/**
 * "Needs you" (HM-dashboard-03): what needs the person now, each row from its owner's record and opening the owner's
 * room. With the owner values blank the list is refused with its code; an owner that has not answered is named, so an
 * empty list never claims "nothing needs you" on a missing answer.
 */
export function WorkList({ hidden, className = 'home-section', testId }: { hidden: boolean; className?: string; testId?: string }) {
  const { t } = homeCopy.useCopy();
  const { list, retry } = useWorkList();
  return (
    <section data-testid={testId} className={`${className} home-work`} aria-labelledby="home-work-title">
      <div className="home-section__head">
        <h2 className="home-h2" id="home-work-title">
          {t('Needs you')}
        </h2>
      </div>
      <Body list={list} hidden={hidden} retry={retry} />
    </section>
  );
}

function Body({ list, hidden, retry }: { list: List; hidden: boolean; retry: () => void }) {
  const { t, Copy } = homeCopy.useCopy();
  if (list.state === 'loading')
    return (
      <div className="home-work__rows" aria-hidden="true">
        {[0, 1].map((index) => (
          <div data-testid="home-work__row" className="home-work__row" key={index}>
            <Skeleton width={180} height={36} className={IN_PANEL} />
          </div>
        ))}
      </div>
    );
  if (list.state === 'refused') {
    const unset = list.code === WORK_LIST_CAP_UNSET;
    const unwired = list.code === HOME_CONFIG_UNWIRED;
    return (
      <StateBlock
        kind="refused"
        className={STATE_IN_COLUMN}
        title={t(unset ? 'Work cap unset' : unwired ? 'Work config unwired' : 'Work config failed')}
        body={t(unset ? 'Work cap unset body' : unwired ? 'Work config unwired body' : 'Work config failed body')}
        code={list.code}
        action={unset ? undefined : { label: t('Try again'), onClick: retry }}
      />
    );
  }
  const unwired = list.missing.filter((entry) => entry.state === 'unwired');
  const failed = list.missing.filter((entry) => entry.state === 'failed');
  // Each sentence carries its own language and direction (Copy): an English fallback on a right-to-left page keeps
  // its full stop and brackets where English puts them.
  const noneKey = list.missing.length === 0 ? 'Work nothing' : 'Work nothing so far';
  const names = (entries: typeof list.missing) => entries.map((entry) => t(SOURCE_NAME[entry.source])).join(', ');
  return (
    <>
      {list.items.length > 0 ? (
        <ul className="home-work__rows">
          {list.items.map((item) => (
            <Row key={item.id} item={item} hidden={hidden} />
          ))}
        </ul>
      ) : (
        <p className="home-work__none" data-complete={list.missing.length === 0}>
          <Copy k={noneKey} />
        </p>
      )}
      {list.more > 0 ? (
        <p className="home-work__note">
          <Copy k="Work more" params={{ count: String(list.more) }} />
        </p>
      ) : null}
      {list.ordered ? null : list.items.length > 1 ? (
        <p className="home-work__note">
          <Copy k="Work order unset" />
        </p>
      ) : null}
      {unwired.length > 0 ? (
        <p className="home-work__note" data-missing="unwired">
          <Copy k="Work sources unwired" params={{ sources: names(unwired) }} />
        </p>
      ) : null}
      {failed.length > 0 ? (
        <p className="home-work__note" data-missing="failed">
          <Copy k="Work sources failed" params={{ sources: names(failed) }} />{' '}
          <button type="button" className="home-link" onClick={retry}>
            <Copy k="Try again" />
          </button>
        </p>
      ) : null}
    </>
  );
}

function Row({ item, hidden }: { item: WorkItem; hidden: boolean }) {
  const { t, Copy } = homeCopy.useCopy();
  const { timeZone } = usePreferences();
  const known = titleOf(item.titleKey);
  const due = item.dueAt ? dayTime(item.dueAt, timeZone) : null;
  const severity = SEVERITY[item.severity];
  return (
    <li>
      <a data-testid="home-work__row" className="home-work__row" href={item.link} data-kind={item.kind} data-severity={item.severity}>
        <span className="home-work__what">
          <span className="home-work__title">
            <Copy k={known ?? KIND_TITLE[item.kind]} />
          </span>
          <span className="home-work__meta">
            {due ? <Copy k="Work due" params={{ when: due }} /> : null}
            {item.amount ? <Amount value={`${fmtAmount(item.amount.value, { places: 18 })} ${item.amount.asset}`} hidden={hidden} /> : null}
            {item.reasonCode ? (
              <span className="home-work__code" dir="ltr">
                {item.reasonCode}
              </span>
            ) : null}
          </span>
        </span>
        <StatusTag status={severity.status} label={t(severity.label)} />
        <ChevronRight size={20} aria-hidden="true" className="home-work__chev" />
      </a>
    </li>
  );
}
