'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CellValueView, ReadBlock } from '@/components/ops-desk';
import { TransactionView } from '@/components/ledger-lookup';
import { lookupRefusal } from '@/lib/ledger/lookup';
import { ledgerHref, PAYMENT_REFERENCE_UNWIRED, SEARCH_SOURCE_UNAVAILABLE } from '@/lib/search/cross-search';
import type { SearchAnswer } from '@/lib/search/server';
import './desk.css';

/**
 * The answers to one cross-desk search, grouped by desk (OPS-payments-desk-01). Each section is one service's own read, shown
 * as it answered: a hit, an honest "nothing", or that desk's refusal with its code. One desk refusing never blanks another.
 */
export function CrossSearch({ answer, founderId }: { answer: SearchAnswer; founderId: string }) {
  return (
    <div className="dk-stack" data-testid="cross-search">
      <header className="dk-stack">
        <h1>Search</h1>
        <p className="dk-muted">
          Results for <code data-testid="cross-search-q">{answer.plan.q}</code>, asked of each desk as you. Every desk records the search
          under your name; this console keeps nothing.
        </p>
      </header>
      <AccountsSection section={answer.accounts} q={answer.plan.q} />
      <LedgerSection section={answer.ledger} />
      <PaymentsSection section={answer.payments} founderId={founderId} />
    </div>
  );
}

function ModuleOff({ module }: { module: string }) {
  return (
    <p className="dk-why" data-state="module-off">
      This console has the {module} module switched off (ADMIN_MODULES), so this desk was not asked.
    </p>
  );
}

function Refused({ title, message, code, service }: { title: string; message: string; code: string | null; service: string }) {
  return (
    <div className="adm-callout" data-tone="warn" role="status" data-state="refused">
      <strong>{title}</strong>
      <p>{message}</p>
      <p className="dk-muted">
        Code: {SEARCH_SOURCE_UNAVAILABLE}
        {code ? ` (${service}: ${code})` : ''}
      </p>
    </div>
  );
}

function AccountsSection({ section, q }: { section: SearchAnswer['accounts']; q: string }) {
  return (
    <section className="adm-callout dk-stack" data-tone="info" aria-labelledby="h-search-accounts" data-testid="search-accounts">
      <h2 id="h-search-accounts">Accounts</h2>
      {section.kind === 'module-off' && <ModuleOff module="accounts" />}
      {section.kind === 'not-asked' && (
        <p className="dk-muted" data-state="not-asked">
          {section.why}
        </p>
      )}
      {section.kind === 'record' && (
        <p data-state="record">
          An account id: <Link href={`/accounts/${section.userId}`}>open the customer record for {section.userId}</Link>. Identity says
          there whether the account exists.
        </p>
      )}
      {section.kind === 'search' && section.outcome.part.kind === 'failed' && (
        <Refused
          title={`Could not load ${section.spec.plainName}`}
          message={section.outcome.part.message}
          code={section.outcome.part.code}
          service="svc-identity"
        />
      )}
      {section.kind === 'search' && section.outcome.part.kind === 'ok' && section.outcome.part.data.shape === 'list' && (
        <div className="dk-stack" data-state="read">
          <p className="dk-muted">{section.spec.note}</p>
          {section.outcome.part.data.rows.length === 0 ? (
            <p data-testid="search-accounts-empty">{section.spec.emptyText}</p>
          ) : (
            <div className="dk-table-wrap">
              <table className="dk-table">
                <thead>
                  <tr>
                    {section.spec.columns
                      .filter((c) => !c.detail)
                      .map((c) => (
                        <th key={c.key} scope="col">
                          {c.label}
                        </th>
                      ))}
                    <th scope="col">Record</th>
                  </tr>
                </thead>
                <tbody>
                  {section.outcome.part.data.rows.map((row) => (
                    <tr key={row.id} data-testid="search-account-row">
                      {row.cells
                        .filter((c) => !c.detail)
                        .map((c) => (
                          <td key={c.key}>
                            <CellValueView cell={c} />
                          </td>
                        ))}
                      <td>
                        <Link href={`/accounts/${row.id}`}>Open record</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {section.outcome.part.data.nextCursor ? (
            <p>
              Identity has more matches than this page.{' '}
              <Link href={`/accounts?q=${encodeURIComponent(q)}`} data-testid="search-accounts-more">
                See every match on Account controls
              </Link>
            </p>
          ) : (
            section.outcome.part.data.rows.length > 0 && <p className="dk-muted">That is every match.</p>
          )}
        </div>
      )}
    </section>
  );
}

function LedgerSection({ section }: { section: SearchAnswer['ledger'] }) {
  return (
    <section className="adm-callout dk-stack" data-tone="info" aria-labelledby="h-search-ledger" data-testid="search-ledger">
      <h2 id="h-search-ledger">Ledger</h2>
      {section.kind === 'module-off' && <ModuleOff module="ledger" />}
      {section.kind === 'lookup' && !section.outcome.ok && (
        <Refused
          title="The ledger did not answer this search"
          message={lookupRefusal(section.outcome.code, section.outcome.status)}
          code={section.outcome.code}
          service="svc-ledger"
        />
      )}
      {section.kind === 'lookup' && section.outcome.ok && !section.outcome.answer.found && (
        <p data-state="read" data-testid="search-ledger-none">
          Nothing was booked under the business key <code>{section.outcome.answer.businessKey}</code>.
        </p>
      )}
      {section.kind === 'lookup' && section.outcome.ok && section.outcome.answer.found && (
        <div className="dk-stack" data-state="read">
          <TransactionView transaction={section.outcome.answer.transaction} readAt={section.readAt} />
          <p>
            <Link href={ledgerHref({ txId: section.outcome.answer.transaction.txId })} data-testid="search-ledger-open">
              Open this transaction on Ledger ops
            </Link>
          </p>
        </div>
      )}
    </section>
  );
}

function PaymentsSection({ section, founderId }: { section: SearchAnswer['payments']; founderId: string }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <section className="adm-callout dk-stack" data-tone="info" aria-labelledby="h-search-payments" data-testid="search-payments">
      <h2 id="h-search-payments">Payments</h2>
      {section.kind === 'module-off' && <ModuleOff module="pay-ops" />}
      {section.kind === 'not-asked' && (
        <p className="dk-muted" data-state="not-asked">
          {section.why}
        </p>
      )}
      {section.kind === 'transfer' && (
        <ReadBlock
          spec={section.spec}
          outcome={section.outcome}
          ctx={{ userId: founderId, onChanged: () => undefined }}
          openKey={openKey}
          onOpen={setOpenKey}
        />
      )}
      <article className="adm-callout" data-tone="warn" data-testid={`unwired-${PAYMENT_REFERENCE_UNWIRED.id}`} data-state="unwired">
        <strong>{PAYMENT_REFERENCE_UNWIRED.label}: no source</strong>
        <p>{PAYMENT_REFERENCE_UNWIRED.reason}</p>
        <p className="dk-muted">Code: {SEARCH_SOURCE_UNAVAILABLE}</p>
      </article>
    </section>
  );
}
