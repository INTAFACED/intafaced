import { useMemo, useState, type FormEvent } from 'react';
import { Button, Field } from '../../../shared/ui';
import { useSession } from '../../session/session';
import { readSandboxes } from '../sandbox/sandbox-api';
import { explorerCopy } from './explorer-copy';
import { codeOfAnswer, curlOf, EXPLORER_HEADER, EXPLORER_ROUTES, isSandboxKey, pathOf, type ExplorerRoute } from './explorer-model';

type Answer =
  | { kind: 'said'; key: 'needKey' | 'bodyInvalid' | 'sandboxUnread' | 'sandboxUnset' }
  | { kind: 'answered'; status: number; code: string | null; message: string | null; text: string }
  | { kind: 'failed' };

/** The write's business key: the same request sent again is the same payment, never a second one. */
async function businessKey(route: ExplorerRoute, body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `explorer:${route.id}:${hex.slice(0, 32)}`;
}

/**
 * /developers/explorer (DV-console-01, J-developer-15 #7): builds a request from the route table, shows it as code, and
 * sends it with the person's key. A live key goes to this site's API and only reads: the edge refuses the explorer's
 * write with a live key (`edge.explorer_live_write_refused`), and the answer is shown as it came. A sandbox key goes to
 * the person's sandbox address, where a write runs on the sandbox only.
 */
export function ExplorerPage({ title }: { title: string }) {
  const { t } = explorerCopy.useCopy();
  const { api, userId } = useSession();
  const [routeId, setRouteId] = useState<ExplorerRoute['id']>('balance');
  const route = EXPLORER_ROUTES.find((r) => r.id === routeId) ?? EXPLORER_ROUTES[0]!;
  const [key, setKey] = useState('');
  const [merchantId, setMerchantId] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const sandbox = isSandboxKey(key);
  const base = sandbox ? '<your sandbox address>' : window.location.origin;
  const code = useMemo(() => curlOf(route, base, merchantId, route.body ? body : null), [route, base, merchantId, body]);

  function choose(id: ExplorerRoute['id']) {
    setRouteId(id);
    const next = EXPLORER_ROUTES.find((r) => r.id === id);
    setBody(next?.body ? JSON.stringify(next.body(merchantId), null, 2) : '');
    setAnswer(null);
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!key.trim()) return setAnswer({ kind: 'said', key: 'needKey' });
    let raw: string | undefined;
    if (route.body) {
      try {
        raw = JSON.stringify(JSON.parse(body));
      } catch {
        return setAnswer({ kind: 'said', key: 'bodyInvalid' });
      }
    }
    setBusy(true);
    setAnswer(null);
    try {
      let origin = '';
      if (sandbox) {
        if (!userId) return setAnswer({ kind: 'said', key: 'sandboxUnread' });
        const read = await readSandboxes(api);
        if (!read.ok) return setAnswer({ kind: 'said', key: 'sandboxUnread' });
        if (!read.data.baseUrl) return setAnswer({ kind: 'said', key: 'sandboxUnset' });
        origin = read.data.baseUrl.replace(/\/$/, '');
      }
      const headers: Record<string, string> = { authorization: `Bearer ${key.trim()}`, [EXPLORER_HEADER]: '1' };
      if (raw !== undefined) {
        headers['content-type'] = 'application/json';
        headers['idempotency-key'] = await businessKey(route, raw);
      }
      const res = await fetch(`${origin}${pathOf(route, merchantId)}`, { method: route.method, headers, body: raw, credentials: 'omit' });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const message =
        parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
          ? ((parsed as { error: string }).error ?? null)
          : null;
      setAnswer({
        kind: 'answered',
        status: res.status,
        code: res.ok ? null : codeOfAnswer(parsed),
        message,
        text: parsed === null ? text : JSON.stringify(parsed, null, 2),
      });
    } catch {
      setAnswer({ kind: 'failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pub-page" data-testid="explorer">
      <header className="pub-heading">
        <h1>{title}</h1>
        <p className="muted">{t('lead')}</p>
      </header>
      <form noValidate onSubmit={(event) => void send(event)}>
        <Field
          label={t('keyLabel')}
          hint={t('keyHint')}
          name="key"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.currentTarget.value)}
        />
        {key.trim() && (
          <p data-testid="explorer-key-mode" role="status">
            {t(sandbox ? 'keySandbox' : 'keyLive')}
          </p>
        )}
        <label className="field" htmlFor="explorer-route">
          <span>{t('requestLabel')}</span>
          <select
            id="explorer-route"
            name="route"
            value={routeId}
            onChange={(event) => choose(event.currentTarget.value as ExplorerRoute['id'])}
          >
            {EXPLORER_ROUTES.map((r) => (
              <option key={r.id} value={r.id}>
                {`${t(`route.${r.id}`)} · ${r.method} ${r.path.split('?')[0]}`}
              </option>
            ))}
          </select>
        </label>
        {route.merchant && (
          <Field
            label={t('merchantLabel')}
            hint={t('merchantHint')}
            name="merchantId"
            autoComplete="off"
            value={merchantId}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setMerchantId(next);
              if (route.body) setBody(JSON.stringify(route.body(next), null, 2));
            }}
          />
        )}
        {route.body && (
          <label className="field" htmlFor="explorer-body">
            <span>{t('bodyLabel')}</span>
            <textarea
              id="explorer-body"
              name="body"
              rows={10}
              spellCheck={false}
              aria-describedby="explorer-body-hint"
              value={body}
              onChange={(event) => setBody(event.currentTarget.value)}
            />
            <small id="explorer-body-hint" className="muted">
              {t('bodyHint')}
            </small>
          </label>
        )}
        <h2>{t('codeTitle')}</h2>
        <pre data-testid="explorer-code" dir="ltr">
          <code lang="und">{code}</code>
        </pre>
        <Button type="submit" disabled={busy}>
          {busy ? t('sending') : t('send')}
        </Button>
      </form>
      {answer && (
        <section data-testid="explorer-answer" aria-labelledby="explorer-answer-title">
          <h2 id="explorer-answer-title">{t('resultTitle')}</h2>
          {answer.kind === 'said' && <p role="alert">{t(answer.key)}</p>}
          {answer.kind === 'failed' && <p role="alert">{t('resultFailed')}</p>}
          {answer.kind === 'answered' && (
            <>
              <p data-testid="explorer-status" role="status">
                {t('resultStatus', { status: answer.status })}
              </p>
              {answer.code && (
                <p data-testid="explorer-refused" role="alert">
                  {t('resultRefused', { code: answer.code })}
                  {answer.message ? ` ${answer.message}` : ''}
                </p>
              )}
              <pre data-testid="explorer-body" dir="ltr">
                <code lang="und">{answer.text}</code>
              </pre>
            </>
          )}
        </section>
      )}
    </div>
  );
}
