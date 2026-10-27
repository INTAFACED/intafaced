import type { CategoryPolicyEvent, CategoryPolicyView } from '@intafaced/contracts/business-category';
import type { PayCallResult } from '@/lib/merchants/pay-call';
import { CLASS_RULE, CLASS_WORDS } from '@/lib/merchants/category-client';
import { formatUtc } from '@/lib/merchants/time';
import { CategoryApprovePanel, CategoryEditor } from './category-editor';
import { Card, FailureState, PageHead, StateBlock } from './ui';

const HERE = '/merchants/categories';

/**
 * Business categories (RC-merchant-08): which businesses INTAFACED takes, and on what terms. The table is versioned;
 * every edit is made by one founder and approved by another. While it is empty no business can pick a category or go
 * live.
 */
export function CategoriesView({
  policy,
  history,
}: {
  policy: PayCallResult<CategoryPolicyView>;
  history: PayCallResult<CategoryPolicyEvent[]>;
}) {
  return (
    <div className="mp-page">
      <PageHead
        title="Business categories"
        purpose="Which businesses INTAFACED takes, and on what terms. Every change needs a second founder."
        back={{ href: '/merchants', label: 'Merchants dashboard' }}
      />
      {policy.kind !== 'ok' ? (
        <FailureState failure={policy} what="The business category table" retryHref={HERE} />
      ) : (
        <>
          <Card
            id="categories"
            title={policy.data.categories.length === 0 ? 'No rule set' : `Table version ${policy.data.tableVersion}`}
            sub="A business picks one of these on its Compliance page. Its class decides what it may take."
            flush={policy.data.categories.length > 0}
          >
            {policy.data.categories.length === 0 ? (
              <StateBlock kind="empty" title="No rule set">
                No business category is published, so no business can choose one and none can go live. This is a successful read, not an
                error.
              </StateBlock>
            ) : (
              <div className="mp-scroll" tabIndex={0} role="region" aria-label="Business categories, scrolls sideways on small screens">
                <table className="mp-table" data-testid="category-table">
                  <thead>
                    <tr>
                      <th scope="col">Category</th>
                      <th scope="col">Class and rule</th>
                      <th scope="col">Reserve</th>
                      <th scope="col">Extra documents</th>
                      <th scope="col">Version</th>
                      <th scope="col">Changed by, approved by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {policy.data.categories.map((c) => (
                      <tr key={c.key}>
                        <td>
                          {c.label}
                          <br />
                          <code>{c.key}</code>
                        </td>
                        <td>
                          <strong>{CLASS_WORDS[c.class]}</strong>. {CLASS_RULE[c.class]}
                        </td>
                        <td>
                          {c.class !== 'restricted' ? '—' : c.reserve ? `${c.reserve.percent}% for ${c.reserve.holdDays} days` : 'Not set'}
                        </td>
                        <td>{c.extraDocuments.length ? c.extraDocuments.join('; ') : '—'}</td>
                        <td>{c.version}</td>
                        <td>
                          <code title={c.updatedBy}>{c.updatedBy.slice(0, 8)}</code>,{' '}
                          <code title={c.approvedBy}>{c.approvedBy.slice(0, 8)}</code>
                          <br />
                          {formatUtc(c.updatedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card id="change" title="Change the table" sub="You ask; the other founder approves in their own sign-in; then you save.">
            <CategoryEditor categories={policy.data.categories} />
          </Card>
        </>
      )}
      <Card
        id="approve"
        title="Approve a category change"
        sub="Paste the request the other founder copied, read it, then approve or decline."
      >
        <CategoryApprovePanel />
      </Card>
      <Card id="history" title="History" sub="Every edit, newest first, with both founders and the reason.">
        {history.kind !== 'ok' ? (
          <FailureState failure={history} what="The category history" retryHref={HERE} />
        ) : history.data.length === 0 ? (
          <StateBlock kind="empty" title="No changes yet">
            Nothing has been added or changed.
          </StateBlock>
        ) : (
          <ul className="mp-requests" aria-label="Category history">
            {history.data.map((e) => (
              <li key={e.seq} className="mp-requests__item" data-testid="category-event">
                <p>
                  #{e.seq} {e.before ? 'Changed' : 'Added'} <strong>{e.after.label}</strong> ({CLASS_WORDS[e.after.class]}). {e.reason}
                </p>
                <p className="mp-hint">
                  By <code title={e.actorId}>{e.actorId.slice(0, 8)}</code>, approved by{' '}
                  <code title={e.approverId}>{e.approverId.slice(0, 8)}</code>, {formatUtc(e.createdAt)}.
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
