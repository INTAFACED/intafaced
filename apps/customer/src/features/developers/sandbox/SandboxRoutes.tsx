import { useState, type FormEvent } from 'react';
import { SANDBOX_CARD_TEST_VALUES, SANDBOX_NAME_MAX, type SandboxList } from '@intafaced/contracts/developer-sandboxes';
import { Button } from '@intafaced/ui/lit';
import { DataTable, EmptyState, Failure, Field, Loading, Page } from '../../../shared/ui';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { sandboxCopy } from './sandbox-copy';
import { SandboxNotFound, SandboxPage } from './SandboxRoom';
import { NewSandboxKey } from './NewSandboxKey';
import { BaseUrl, Refused, type Refusal, type T } from './sandbox-parts';
import { createSandbox, readSandboxes, sandboxRoute } from './sandbox-api';
import '../apps/apps.css';

const day = (iso: string) => <time dateTime={iso}>{iso.slice(0, 10)}</time>;

function SignedOut({ t, back }: { t: T; back: string }) {
  return (
    <Page eyebrow={t('eyebrow')} title={t('title')} description={t('lead')}>
      <EmptyState
        title={t('signedOutTitle')}
        action={
          <a className="lt-button lt-button-primary" href={`/login?redirect=${encodeURIComponent(back)}`}>
            {t('signIn')}
          </a>
        }
      >
        {t('signedOutBody')}
      </EmptyState>
    </Page>
  );
}

function CreateForm({ listed, onMade, t }: { listed: SandboxList['sandboxes']; onMade: () => void; t: T }) {
  const { api, userId } = useSession();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !userId) return;
    setBusy(true);
    setRefused(null);
    setSaid(null);
    const result = await createSandbox(api, userId, listed, name.trim());
    setBusy(false);
    if (!result.ok) return setRefused(result);
    setSaid(t(result.data.replayed ? 'replayed' : 'created', { name: result.data.sandbox.name }));
    setName('');
    onMade();
  }
  return (
    <form className="apps-form" onSubmit={submit} noValidate aria-labelledby="sandbox-create">
      <h2 id="sandbox-create">{t('formHeading')}</h2>
      <Field
        label={t('name')}
        hint={t('nameHint')}
        value={name}
        maxLength={SANDBOX_NAME_MAX}
        autoComplete="off"
        onChange={(event) => setName(event.target.value)}
      />
      {refused ? <Refused failure={refused} t={t} /> : null}
      {said ? <p role="status">{said}</p> : null}
      <Button tone="primary" type="submit" disabled={busy}>
        {busy ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}

/** /developers/sandbox: the account's named sandboxes, the owner's cap on how many, and the create form. */
function SandboxList() {
  const { t } = sandboxCopy.useCopy();
  const { api, userId } = useSession();
  const list = useResource(
    (signal) => (userId ? readSandboxes(api, signal) : Promise.resolve({ ok: true as const, data: null })),
    `developer-sandboxes:${userId ?? 'out'}`,
  );
  if (!userId) return <SignedOut t={t} back="/developers/sandbox" />;
  const resource = list.resource;
  return (
    <Page eyebrow={t('eyebrow')} title={t('title')} description={t('lead')}>
      <div className="apps-room" data-testid="developers-sandbox">
        {resource.status === 'loading' ? (
          <Loading label={t('loading')} />
        ) : resource.status === 'failed' ? (
          <div role="alert">
            <p>{t('readFailed')}</p>
            <Failure result={resource.failure} retry={list.reload} />
          </div>
        ) : resource.data ? (
          <>
            <section aria-labelledby="sandbox-list">
              <h2 id="sandbox-list">{t('listHeading')}</h2>
              <p data-testid="sandbox-cap" data-limit={resource.data.cap.limit ?? 'unset'} data-held={resource.data.cap.held}>
                {resource.data.cap.limit === null
                  ? t('capUnset')
                  : t('capSet', { held: String(resource.data.cap.held), limit: String(resource.data.cap.limit) })}
              </p>
              <BaseUrl baseUrl={resource.data.baseUrl} t={t} />
              {resource.data.sandboxes.length === 0 ? (
                <p>{t('empty')}</p>
              ) : (
                <DataTable label={t('listHeading')} headers={[t('colName'), t('colCreated')]}>
                  {resource.data.sandboxes.map((sandbox) => (
                    <tr key={sandbox.id} data-sandbox-id={sandbox.id}>
                      <td>
                        <a className="lt-link" href={`/developers/sandbox/${sandbox.id}`}>
                          <bdi lang="und">{sandbox.name}</bdi>
                        </a>
                      </td>
                      <td>{day(sandbox.createdAt)}</td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </section>
            <CreateForm listed={resource.data.sandboxes} onMade={list.reload} t={t} />
          </>
        ) : null}
      </div>
    </Page>
  );
}

const TEST_VALUE_NAME = {
  decline: 'valueDecline',
  acquirer_outage: 'valueOutage',
  funds_held: 'valueFundsHeld',
  unlisted_reason: 'valueUnlisted',
} as const;
const TEST_VALUE_RESULT = {
  decline: 'resultDecline',
  acquirer_outage: 'resultOutage',
  funds_held: 'resultFundsHeld',
  unlisted_reason: 'resultUnlisted',
} as const;

/**
 * /developers/sandbox/test-values: the card tokens that steer a sandbox payment (J-developer-02 #8), from the contract
 * the sandbox card rail answers. Public reference, so it reads the same signed in or out.
 */
function TestValues() {
  const { t } = sandboxCopy.useCopy();
  return (
    <Page eyebrow={t('eyebrow')} title={t('testValuesTitle')}>
      <div className="apps-room">
        <a className="text-link" href="/developers/sandbox">
          ← {t('back')}
        </a>
        <p>{t('testValuesLead')}</p>
        <DataTable label={t('testValuesHeading')} headers={[t('colOutcome'), t('colToken'), t('colResult')]}>
          {SANDBOX_CARD_TEST_VALUES.map((value) => (
            <tr key={value.id} data-test-value={value.id}>
              <th scope="row">{t(TEST_VALUE_NAME[value.id])}</th>
              <td>
                <code lang="und">{value.token}</code>
              </td>
              <td>
                {t(TEST_VALUE_RESULT[value.id])}
                {value.failureCode ? (
                  <>
                    {' '}
                    <code lang="und">{value.failureCode}</code>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
          <tr data-test-value="approve">
            <th scope="row">{t('valueApprove')}</th>
            <td>{t('anyOtherToken')}</td>
            <td>{t('resultApprove')}</td>
          </tr>
        </DataTable>
      </div>
    </Page>
  );
}

/** Every room under /developers/sandbox (DV-sandbox-01). Signed in: a sandbox belongs to an account. */
export function SandboxRoutes({ path }: { path: string }) {
  const route = sandboxRoute(path);
  if (route.kind === 'list') return <SandboxList />;
  if (route.kind === 'test-values') return <TestValues />;
  if (route.kind === 'sandbox') return <SandboxPage id={route.id} />;
  if (route.kind === 'new-key') return <NewSandboxKey id={route.id} />;
  // An address under the room's own path with no sandbox id it knows: the room's own not-found state.
  return <SandboxNotFound />;
}
