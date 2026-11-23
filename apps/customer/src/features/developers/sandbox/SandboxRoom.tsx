// volt-room: /developers/sandbox/:sandboxId
import { useState, type ReactNode } from 'react';
import type { SandboxBalance, SandboxDetail } from '@intafaced/contracts/developer-sandboxes';
import { Button } from '@intafaced/ui/lit';
import { KeyValue, SettingsTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { sandboxCopy } from './sandbox-copy';
import { fundSandbox, readSandbox, readSandboxBalance, resetSandbox } from './sandbox-api';
import { Failure, Loading } from './kit-parts';
import { BaseUrl, Refused, type Refusal, type T } from './sandbox-parts';

/** Revoked, past its end date (the door refuses it as expired), or active. */
const keyState = (key: SandboxDetail['keys'][number], now = Date.now()) =>
  key.revoked ? 'stateRevoked' : key.expiresAt !== null && Date.parse(key.expiresAt) <= now ? 'stateExpired' : 'stateActive';

/** A table in the kit's look, named as a region so a reader (and a test) finds it by its name. */
function Grid({ headers, children, label }: { headers: readonly string[]; children: ReactNode; label: string }) {
  return (
    <div tabIndex={0} role="region" aria-label={label}>
      <table className="lt-table">
        <thead>
          <tr>
            {headers.map((head, index) => (
              <th key={index} scope="col">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** The room's sections, each a link to its part of the page. */
const SECTIONS = [
  ['sandbox-funds', 'fundsHeading'],
  ['sandbox-keys', 'keysHeading'],
] as const;

/** The room on its settings template; the way back to every sandbox stays in its index whatever its state. */
function SandboxShell({
  title,
  description,
  state,
  sections,
  roomAction,
  sectionLinks = false,
}: {
  title: string;
  description?: string;
  state: RoomState;
  sections?: ReactNode;
  roomAction?: ReactNode;
  sectionLinks?: boolean;
}) {
  const { t } = sandboxCopy.useCopy();
  return (
    <SettingsTemplate
      title={title}
      description={description}
      state={state}
      roomAction={roomAction}
      index={
        <nav aria-label={t('sectionsLabel')}>
          <ul>
            <li>
              <a className="lt-link" href="/developers/sandbox">
                ← {t('back')}
              </a>
            </li>
            {sectionLinks
              ? SECTIONS.map(([id, key]) => (
                  <li key={id}>
                    <a className="lt-link" href={`#${id}`}>
                      {t(key)}
                    </a>
                  </li>
                ))
              : null}
          </ul>
        </nav>
      }
      sections={sections ?? null}
      explain={<p>{t('explain')}</p>}
    />
  );
}

/**
 * The sandbox's TEST funds, from the pay service's sandbox store: the balance, what each Fund adds and the resets used
 * today (each "not set" while the owner's setting is blank), Fund and Reset. Every figure is TEST and never real money.
 */
function Funds({ sandboxId, t }: { sandboxId: string; t: T }) {
  const { api, userId } = useSession();
  const { resource, reload } = useResource(
    (signal) => readSandboxBalance(api, sandboxId, signal),
    `developer-sandbox-balance:${userId ?? 'out'}:${sandboxId}`,
  );
  // The balance a press answered, for this sandbox only; a refusal drops it and reads again.
  const [answered, setAnswered] = useState<SandboxBalance | null>(null);
  const latest = answered?.sandboxId === sandboxId ? answered : null;
  // While a refusal's re-read is under way, the figures last shown stay on screen.
  const [shown, setShown] = useState<SandboxBalance | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ kind: 'done'; text: string } | { kind: 'refused'; failure: Refusal } | null>(null);
  const fresh = latest ?? (resource.status === 'ready' ? resource.data : null);
  const read = fresh ?? (shown?.sandboxId === sandboxId ? shown : null);

  async function press(action: 'fund' | 'reset') {
    if (busy || !userId || !read) return;
    setBusy(true);
    setSaid(null);
    const result = action === 'fund' ? await fundSandbox(api, userId, read) : await resetSandbox(api, userId, read);
    setBusy(false);
    if (!result.ok) {
      setSaid({ kind: 'refused', failure: result });
      setShown(read);
      setAnswered(null);
      reload();
      return;
    }
    const { replayed, ...balance } = result.data;
    setAnswered(balance);
    let text = t('pressReplayed');
    if (!replayed) text = action === 'fund' ? t('funded', { amount: balance.fundAmount ?? '', asset: balance.asset }) : t('resetDone');
    setSaid({ kind: 'done', text });
  }

  return (
    <section aria-labelledby="sandbox-funds">
      <h2 id="sandbox-funds">{t('fundsHeading')}</h2>
      <p className="lt-hint">{t('fundsLead')}</p>
      {resource.status === 'failed' && !latest ? <Failure result={resource.failure} retry={reload} /> : null}
      {read ? (
        <KeyValue
          rows={[
            {
              label: t('balanceLabel'),
              value: (
                <span data-testid="sandbox-balance" data-balance={read.amount}>
                  {read.amount} {read.asset} {read.label}
                </span>
              ),
            },
            {
              label: t('fundAmountLabel'),
              unset: read.fundAmount === null,
              value: (
                <span data-testid="sandbox-fund-amount">
                  {read.fundAmount === null ? <span className="lt-hint">{t('notSet')}</span> : `${read.fundAmount} ${read.asset} TEST`}
                </span>
              ),
            },
            {
              label: t('resetsLabel'),
              unset: read.resetsPerDay === null,
              value: (
                <span data-testid="sandbox-resets">
                  {read.resetsPerDay === null ? (
                    <span className="lt-hint">{t('notSet')}</span>
                  ) : (
                    t('resetsOf', { used: String(read.resetsToday), cap: String(read.resetsPerDay) })
                  )}
                </span>
              ),
            },
          ]}
        />
      ) : resource.status === 'loading' ? (
        <Loading label={t('balanceLoading')} />
      ) : null}
      <div className="lt-actions">
        <Button tone="secondary" disabled={busy || !read} onClick={() => void press('fund')}>
          {t('fund')}
        </Button>
        <Button tone="secondary" disabled={busy || !read} onClick={() => void press('reset')}>
          {t('reset')}
        </Button>
      </div>
      {said?.kind === 'done' ? <p role="status">{said.text}</p> : null}
      {said?.kind === 'refused' ? <Refused failure={said.failure} t={t} /> : null}
    </section>
  );
}

function SandboxSections({ detail, t }: { detail: SandboxDetail; t: T }) {
  return (
    <div data-testid="developers-sandbox-detail">
      <BaseUrl baseUrl={detail.baseUrl} t={t} />
      <Funds sandboxId={detail.sandbox.id} t={t} />
      <section aria-labelledby="sandbox-keys">
        <h2 id="sandbox-keys">{t('keysHeading')}</h2>
        {detail.keys.length === 0 ? (
          <p>{t('noKeys')}</p>
        ) : (
          <Grid label={t('keysHeading')} headers={[t('colKey'), t('colPrefix'), t('colScopes'), t('colState')]}>
            {detail.keys.map((key) => (
              <tr key={key.id} data-key-id={key.id} data-mode={key.mode}>
                <td>
                  <bdi lang="und">{key.name}</bdi>
                </td>
                <td>
                  <code lang="und">{key.prefix}</code>
                </td>
                <td>
                  <code lang="und">{key.scopes.join(' ')}</code>
                </td>
                <td>{t(keyState(key))}</td>
              </tr>
            ))}
          </Grid>
        )}
      </section>
    </div>
  );
}

/** One sandbox's read, shared by its room and its new-key page. */
export function useSandbox(id: string) {
  const { api, userId } = useSession();
  return useResource(
    (signal) => (userId ? readSandbox(api, id, signal) : Promise.resolve({ ok: true as const, data: null })),
    `developer-sandbox:${userId ?? 'out'}:${id}`,
  );
}

/** /developers/sandbox/<id>: one sandbox, its address, its TEST funds and its keys, on the settings template. */
/** No sandbox at this address: an id the door doesn't know, or one that isn't this person's. */
export function SandboxNotFound() {
  const { t } = sandboxCopy.useCopy();
  return (
    <SandboxShell
      title={t('notFoundTitle')}
      state={{
        kind: 'empty',
        title: t('notFoundTitle'),
        body: t('notFoundBody'),
        action: { label: t('back'), href: '/developers/sandbox' },
      }}
    />
  );
}

export function SandboxPage({ id }: { id: string }) {
  const { t } = sandboxCopy.useCopy();
  const { userId } = useSession();
  const { resource, reload } = useSandbox(id);
  if (!userId) {
    const back = `/developers/sandbox/${id}`;
    return (
      <SandboxShell
        title={t('title')}
        description={t('lead')}
        state={{
          kind: 'empty',
          title: t('signedOutTitle'),
          body: t('signedOutBody'),
          action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(back)}` },
        }}
      />
    );
  }
  if (resource.status === 'failed') {
    if (resource.failure.code === 'identity.sandbox_not_found') return <SandboxNotFound />;
    // Refused, the room keeps its heading and its way back.
    return <SandboxShell title={t('title')} state={{ kind: 'ready' }} sections={<Failure result={resource.failure} retry={reload} />} />;
  }
  const detail = resource.status === 'ready' ? resource.data : null;
  if (!detail) return <SandboxShell title={t('title')} state={{ kind: 'loading' }} />;
  return (
    <SandboxShell
      title={detail.sandbox.name}
      state={{ kind: 'ready' }}
      sectionLinks
      roomAction={
        <a className="lt-button lt-button-primary" href={`/developers/sandbox/${detail.sandbox.id}/keys/new`}>
          {t('newKey')}
        </a>
      }
      sections={<SandboxSections detail={detail} t={t} />}
    />
  );
}
