import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import {
  FUNDS_WORDS,
  NOT_KNOWN,
  RESULT_WORDS,
  STATE_WORDS,
  type Authorization,
  type Cardholder,
  type CardholderDetail,
  type Desk,
  type Setting,
} from '@/lib/card-programme/model';
import type { ProgrammeFigures } from '@/lib/card-programme/read';
import type { Part } from '@/lib/desk/part';
import {
  BulkForm,
  CardholderForm,
  ConfigForms,
  ExportButton,
  ReassignForm,
  RuleForms,
  SimulatorForm,
  StaffForm,
  ThreeDsForm,
} from './actions';
import '../desk.css';

/**
 * The card programme desk (J-bank-26). Every figure is svc-bank's own answer; a part that failed says why and shows no
 * rows. The programme is the TEST card simulator on every stack today, and every surface here says so.
 */

export function Failed({ part, testId }: { part: Extract<Part<unknown>, { kind: 'failed' }>; testId: string }) {
  return (
    <div className="adm-callout" data-tone={part.forbidden || part.notBuilt ? 'warn' : 'danger'} role="status" data-testid={testId}>
      <strong>{part.forbidden ? 'Access refused' : 'This part could not be read'}</strong>
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
      <p className="dk-muted">Nothing is shown here rather than a guess.</p>
    </div>
  );
}
const TestMark = ({ test }: { test: boolean }) => (test ? <span className="dk-badge">TEST</span> : null);

function Section({ id, title, intro, children }: { id: string; title: string; intro: string; children: ReactNode }) {
  return (
    <section className="dk-stack" aria-labelledby={`${id}-title`} data-testid={id}>
      <h3 id={`${id}-title`}>{title}</h3>
      <p className="dk-muted">{intro}</p>
      {children}
    </section>
  );
}
function Table({
  testId,
  heads,
  rows,
  empty,
}: {
  testId: string;
  heads: readonly string[];
  rows: ReadonlyArray<readonly ReactNode[]>;
  empty: string;
}) {
  if (rows.length === 0)
    return (
      <p className="dk-muted" data-testid={`${testId}-empty`}>
        {empty}
      </p>
    );
  return (
    <div className="dk-table-wrap">
      <table className="adm-table" data-testid={testId}>
        <thead>
          <tr>
            {heads.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Kv({ items, testId }: { items: ReadonlyArray<[string, ReactNode]>; testId: string }) {
  return (
    <dl className="dk-kv" data-testid={testId}>
      {items.map(([k, v]) => (
        <div className="dk-kv-row" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const settingWords = (s: Setting | null, words: (v: Record<string, unknown>) => string): string =>
  s ? `${words(s.value)} (version ${s.version})` : 'not set';
const fee = (v: unknown, asset: unknown) => (typeof v === 'string' ? `${v} ${String(asset)}` : 'not set');

function CardholderRows({ rows }: { rows: readonly Cardholder[] }) {
  return (
    <Table
      testId="cp-cardholder-list"
      heads={['Cardholder', 'Type', 'Status', 'Screening', 'Cards', 'Id']}
      rows={rows.map((h) => [
        <Link key="n" href={`/bank-ops/cards/cardholders/${h.id}`}>
          {h.name}
        </Link>,
        h.kind === 'individual' ? 'Individual (KYC)' : 'Business (KYB)',
        h.status === 'verified' ? 'verified' : `in review: ${h.gap ?? ''}`,
        h.screening,
        (h.cards ?? []).map((c) => `•••• ${c.panTail} (${c.status})`).join(', ') || 'none',
        <code key="i">{h.id}</code>,
      ])}
      empty="No cardholder matches."
    />
  );
}

export function CardProgrammeDesk({
  asOf,
  desk,
  query,
  search,
}: {
  asOf: string;
  desk: Part<Desk>;
  query: string;
  search: Part<Cardholder[]> | null;
}) {
  if (desk.kind === 'failed') return <Failed part={desk} testId="cp-failed" />;
  const d = desk.data;
  const s = d.settings;
  return (
    <div className="dk-stack" data-testid="card-programme-desk">
      <p>
        <Link href="/bank-ops">Bank ops (programme funding)</Link> · <Link href="/bank-ops/cards/disputes">Card disputes</Link>
      </p>
      <h2>
        Card programme <TestMark test={d.test} />
      </h2>
      <p className="dk-muted">
        {d.programme.displayName}
        {d.programme.simulated ? ': a simulation, so no real card exists.' : '.'} Card money is the card partner’s; nothing here posts to
        the ledger. As of {formatAsOf(asOf)}.
      </p>

      <Section
        id="cp-checklist"
        title="Set-up checklist"
        intro="What the programme needs, read from what is stored. Going live is not a setting here."
      >
        <Table
          testId="cp-checklist-items"
          heads={['Step', 'Done', 'What is missing']}
          rows={d.checklist.map((c) => [c.label, c.done ? 'done' : 'not done', c.blocker ?? ''])}
          empty="No checklist."
        />
      </Section>

      <Section
        id="cp-config"
        title="Programme, product and BIN"
        intro="Each save is versioned and audited. Fees are recorded settings: svc-bank has no fee recipe, so none is charged."
      >
        <Kv
          testId="cp-config-values"
          items={[
            [
              'Programme',
              settingWords(
                s.programme,
                (v) => `${String(v.type)}, ${(v.currencies as string[]).join(' ')}, ${String(v.fulfilment).replaceAll('_', ' ')}`,
              ),
            ],
            [
              'Product',
              settingWords(
                s.product,
                (v) => `${String(v.name)}, ${String(v.cardType)}, limit ${String(v.perAuthorizationLimit)} ${String(v.assetId)}`,
              ),
            ],
            ['BIN', settingWords(s.bin, (v) => `${String(v.bin)} on ${String(v.network)}, ${String(v.range)}`)],
            ['Issuance fee', s.fees ? fee(s.fees.value.issuance, s.fees.value.assetId) : 'not set'],
            ['Replacement fee', s.fees ? fee(s.fees.value.replacement, s.fees.value.assetId) : 'not set'],
            ['Monthly fee', s.fees ? fee(s.fees.value.monthly, s.fees.value.assetId) : 'not set'],
          ]}
        />
        <ConfigForms />
      </Section>

      <Section
        id="cp-rules"
        title="Authorisation rules"
        intro="A new rule runs in shadow over the last 100 TEST authorisations and decides nothing. Promoted, it decides new authorisations only; roll back puts the version before it back."
      >
        <Table
          testId="cp-rule-list"
          heads={['Rule', 'Version', 'What it does', 'State', 'Shadow run', 'Key']}
          rows={d.rules.map((r) => [
            r.name,
            r.version,
            r.words,
            STATE_WORDS[r.state],
            `would decline ${r.shadow.wouldDecline} of ${r.shadow.evaluated} past TEST authorisations`,
            r.ruleKey,
          ])}
          empty="No rule yet."
        />
        <RuleForms rules={d.rules} />
      </Section>

      <Section
        id="cp-threeds"
        title="3DS policy and SCA exemptions"
        intro="Asked of online payments only. A payment within the low-value exemption skips the challenge, and its trace says why."
      >
        <Kv
          testId="cp-threeds-values"
          items={[
            [
              '3DS policy',
              s.threeds ? (s.threeds.value.mode === 'challenge_all' ? 'challenge every online payment' : 'frictionless') : 'not set',
            ],
            [
              'Low-value exemption',
              s.threeds?.value.lowValueExemption
                ? `${String((s.threeds.value.lowValueExemption as { limit: string }).limit)} ${String((s.threeds.value.lowValueExemption as { assetId: string }).assetId)}`
                : 'not set',
            ],
            ['Payments exempted', d.exemptions],
          ]}
        />
        <ThreeDsForm />
      </Section>

      <Section
        id="cp-cardholders"
        title="Cardholders"
        intro={`Each is screened and passes the KYC or KYB gate (the full verification level), or lands in the review queue with the gap named.${d.screeningListSet ? '' : ' The cardholder sanctions list is not set, so none can be created.'}`}
      >
        <CardholderForm />
        <form className="dk-row" method="get" action="/bank-ops/cards" data-testid="cp-directory-search">
          <div className="adm-field">
            <label htmlFor="cp-q">Directory search: name, email or last four digits</label>
            <input id="cp-q" name="q" className="adm-input" defaultValue={query} />
          </div>
          <button type="submit" className="adm-btn">
            Search
          </button>
        </form>
        {search === null ? (
          <CardholderRows rows={d.cardholders} />
        ) : search.kind === 'failed' ? (
          <Failed part={search} testId="cp-search-failed" />
        ) : (
          <CardholderRows rows={search.data} />
        )}
        <h4>Review queue</h4>
        <Table
          testId="cp-review-queue"
          heads={['Cardholder', 'Type', 'Gap', 'Code', 'Since']}
          rows={d.reviewQueue.map((h) => [h.name, h.kind, h.gap ?? '', h.gapCode ?? '', formatWhen(h.createdAt)])}
          empty="The review queue is empty."
        />
      </Section>

      <Section
        id="cp-decision-log"
        title="Real-time decision log"
        intro="The newest 50 authorisations as svc-bank decided them. Open one for its lifecycle, capture variance and trace."
      >
        <Table
          testId="cp-decisions"
          heads={['Decided', 'Card', 'Amount', 'Channel', 'Category', 'Decision', 'Code', '']}
          rows={d.decisionLog.map((a) => [
            formatWhen(a.decidedAt),
            `•••• ${a.panTail}`,
            `${a.amount} ${a.assetId}`,
            a.channel,
            a.merchantCategory ?? '',
            a.decision,
            a.declineCode ?? '',
            <Link key="o" href={`/bank-ops/cards/authorizations/${a.id}`} data-testid={`cp-open-${a.id}`}>
              Open{a.test ? ' (TEST)' : ''}
            </Link>,
          ])}
          empty="No authorisation has been decided yet."
        />
      </Section>

      <Section
        id="cp-report"
        title={`Report: authorisations on ${d.report.day} (UTC)`}
        intro={`Freshness ${formatAsOf(d.report.asOf)}. The export signs exactly these figures.`}
      >
        <Table
          testId="cp-report-table"
          heads={['Asset', 'Approved', 'Approved volume', 'Declined']}
          rows={[
            ...d.report.assets.map((a) => [a.assetId, a.approved, a.approvedVolume, a.declined]),
            ['total', d.report.totals.approved, '', d.report.totals.declined],
          ]}
          empty="No authorisation today."
        />
        <ExportButton />
      </Section>

      <Section
        id="cp-staff"
        title="Staff roles and audit log"
        intro="A Viewer reads the programme and changes nothing. Every change is in the audit log, which cannot be edited."
      >
        <StaffForm />
        <Table
          testId="cp-staff-list"
          heads={['Email', 'Role', 'Since']}
          rows={d.staff.map((m) => [m.email, m.role, formatWhen(m.assignedAt)])}
          empty="No staff role is given."
        />
        <Table
          testId="cp-audit"
          heads={['When', 'Who', 'Action', 'On', 'Before', 'After']}
          rows={d.audit.map((e) => [formatWhen(e.at), e.actor, e.action, e.target, e.before ?? '', e.after ?? ''])}
          empty="No change has been made."
        />
      </Section>

      <Section
        id="cp-issue"
        title="Bulk issue, reassign and the card event simulator"
        intro="A file with any bad row issues nothing. Issuing the same file again makes its cards once. A reassign moves a card, never money."
      >
        <BulkForm />
        <ReassignForm />
        {d.simulator ? (
          <div className="dk-stack" data-testid="cp-simulator">
            <h4>
              TEST card event simulator <span className="dk-badge">TEST</span>
            </h4>
            <p className="dk-muted">
              Sends a TEST authorisation, capture or reversal on a simulated card through the same path an issuer’s message takes.
            </p>
            <SimulatorForm />
          </div>
        ) : (
          <p className="dk-muted" data-testid="cp-simulator-off">
            The card event simulator runs only on a dev or test stack, on simulated cards.
          </p>
        )}
      </Section>
    </div>
  );
}

export function AuthorizationDetail({ asOf, part }: { asOf: string; part: Part<Authorization> }) {
  if (part.kind === 'failed') return <Failed part={part} testId="cp-authorization-failed" />;
  const a = part.data;
  return (
    <div className="dk-stack" data-testid="cp-authorization">
      <p>
        <Link href="/bank-ops/cards">Card programme</Link>
      </p>
      <h2>
        Authorisation {a.authorizationRef} <TestMark test={a.test} />
      </h2>
      <p className="dk-muted">As of {formatAsOf(asOf)}.</p>
      <Kv
        testId="cp-authorization-facts"
        items={[
          ['Card', `•••• ${a.panTail}`],
          ['Amount', `${a.amount} ${a.assetId}`],
          ['Channel', a.channel],
          ['Merchant category', a.merchantCategory ?? NOT_KNOWN],
          ['Decision', a.decision],
          ['Decline code', a.declineCode ?? 'none'],
          ['Held by', a.heldBy === 'partner' ? `the card partner${a.partnerHoldRef ? `, ${a.partnerHoldRef}` : ''}` : a.heldBy],
        ]}
      />
      <h3>Lifecycle</h3>
      <Table
        testId="cp-lifecycle"
        heads={['Event', 'Amount', 'When', 'Detail']}
        rows={a.lifecycle.map((e) => [e.event, e.amount, formatWhen(e.at), e.detail ?? ''])}
        empty=""
      />
      <h3>Capture variance</h3>
      {a.variance ? (
        <Kv
          testId="cp-variance"
          items={[
            ['Authorised', a.variance.authorised],
            ['Captured', a.variance.captured],
            ['Given back', a.variance.returned],
            ['Still held', a.variance.stillHeld],
            ['Capture variance', a.variance.captureVariance],
          ]}
        />
      ) : (
        <p className="dk-muted">A declined authorisation holds and captures nothing.</p>
      )}
      <h3>Why it was {a.decision}</h3>
      {a.trace ? (
        <Table
          testId="cp-trace"
          heads={['Check', 'Answer', 'Why']}
          rows={a.trace.map((t) => [t.check, RESULT_WORDS[t.result], t.detail])}
          empty=""
        />
      ) : (
        <p className="dk-muted" data-testid="cp-trace-none">
          No trace was recorded for this authorisation (decided before traces were kept, or its write failed). Nothing is shown rather than
          a guess.
        </p>
      )}
    </div>
  );
}

export function CardholderPage({ asOf, part, figures }: { asOf: string; part: Part<CardholderDetail>; figures: Part<ProgrammeFigures> }) {
  if (part.kind === 'failed') return <Failed part={part} testId="cp-cardholder-failed" />;
  const h = part.data;
  return (
    <div className="dk-stack" data-testid="cp-cardholder">
      <p>
        <Link href="/bank-ops/cards">Card programme</Link>
      </p>
      <h2>
        {h.name} <TestMark test={h.test} />
      </h2>
      <p className="dk-muted">As of {formatAsOf(asOf)}.</p>
      <Kv
        testId="cp-cardholder-facts"
        items={[
          ['Type', h.kind === 'individual' ? 'Individual (KYC)' : 'Business (KYB)'],
          ['Status', h.status === 'verified' ? 'verified' : `in review: ${h.gap ?? ''}`],
          ['Screening', `${h.screening}, ${formatWhen(h.screenedAt)}`],
          ['Email', h.email ?? 'none'],
          ['Country', h.country],
          ['Beneficial owners', h.beneficialOwners.map((o) => o.name).join(', ') || 'none on file'],
          ['Id', h.id],
        ]}
      />
      <Table
        testId="cp-cardholder-cards"
        heads={['Card', 'Asset', 'Status', 'Id']}
        rows={h.cards.map((c) => [`•••• ${c.panTail}`, c.assetId, c.status, <code key="i">{c.id}</code>])}
        empty="No card."
      />
      <h3>Funding and balances</h3>
      <p className="dk-muted">
        This cardholder’s open holds and captures in this app beside the card partner’s own figures for them. The difference is the
        partner’s minus the app’s.
      </p>
      <Table
        testId="cp-funds"
        heads={[
          'Asset',
          'Open holds (app)',
          'Captured (app)',
          'Held plus captured (app)',
          'Partner’s figure',
          'Difference',
          'Reconciliation',
        ]}
        rows={h.funds.map((f) => [
          f.assetId,
          f.appHeld,
          f.appCaptured,
          f.appFigure,
          f.partnerFigure ?? NOT_KNOWN,
          f.difference ?? NOT_KNOWN,
          FUNDS_WORDS[f.status],
        ])}
        empty="This cardholder has no card funds yet."
      />
      <h3>The programme’s figures as the partner reports them</h3>
      {figures.kind === 'failed' ? (
        <Failed part={figures} testId="cp-programme-figures-failed" />
      ) : (
        <Table
          testId="cp-programme-figures"
          heads={['Asset', 'Partner’s figure', 'Partner’s time']}
          rows={figures.data.rows.map((r) => [r.assetId, r.partnerFigure ?? NOT_KNOWN, r.partnerAsOf ?? NOT_KNOWN])}
          empty="The partner reports no programme figure."
        />
      )}
    </div>
  );
}
