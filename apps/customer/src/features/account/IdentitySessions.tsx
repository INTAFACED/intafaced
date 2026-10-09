import { useState } from 'react';
import { z } from 'zod';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, Dialog, EmptyState, Failure, Loading } from '../../shared/ui';
import { defineCopy } from '../../shared/i18n';

const copy = defineCopy(
  'account.sessions',
  {
    title: 'Signed-in identity sessions',
    scope:
      'The identity service returns live session IDs and creation times for this account. Device names, IP addresses and the current seat are not published. Revoking a seat may sign out this browser.',
    empty: 'No live sessions returned',
    emptyBody: 'The source returned no live seats in this window.',
    session: 'Session',
    created: 'Created',
    action: 'Action',
    table: 'Live identity seats',
    revoke: 'Revoke session {id}',
    review: 'Revoke session',
    reviewBody: 'Revoke only the reviewed session for this account? This can end access on its signed-in browser.',
    confirm: 'Revoke this session',
    refresh: 'Refresh sessions',
    window: 'Most recent live sessions: requested limit {limit}. The service has no cursor.',
    more: 'Expand session window',
    maximum: 'The maximum window is 200 sessions; older sessions are not represented.',
    revoked: 'The service revoked the selected session.',
    unchanged: 'The service did not revoke a live seat. Refresh the source before deciding what to do next.',
    owner: 'Account',
    original: 'Reviewed session',
  } as const,
  {
    es: {
      title: 'Sesiones de identidad activas',
      scope:
        'El servicio de identidad devuelve los ID de sesión activos y sus fechas de creación para esta cuenta. No publica nombres de dispositivos, direcciones IP ni la sesión actual. Revocar una sesión puede cerrar la sesión en este navegador.',
      empty: 'No se devolvieron sesiones activas',
      emptyBody: 'La fuente no devolvió sesiones activas en este intervalo.',
      session: 'Sesión',
      created: 'Creada',
      action: 'Acción',
      table: 'Sesiones de identidad activas',
      revoke: 'Revocar sesión {id}',
      review: 'Revocar sesión',
      reviewBody: '¿Revocar solo la sesión revisada de esta cuenta? Puede finalizar el acceso de su navegador.',
      confirm: 'Revocar esta sesión',
      refresh: 'Actualizar sesiones',
      window: 'Sesiones activas más recientes: límite solicitado {limit}. El servicio no tiene cursor.',
      more: 'Ampliar el intervalo de sesiones',
      maximum: 'El intervalo máximo es de 200 sesiones; no incluye las más antiguas.',
      revoked: 'El servicio revocó la sesión seleccionada.',
      unchanged: 'El servicio no revocó una sesión activa. Actualiza la fuente antes de decidir qué hacer.',
      owner: 'Cuenta',
      original: 'Sesión revisada',
    },
    fr: {
      title: 'Sessions d’identité actives',
      scope:
        'Le service d’identité renvoie les identifiants des sessions actives et leurs dates de création pour ce compte. Les noms d’appareils, adresses IP et la session actuelle ne sont pas publiés. La révocation peut déconnecter ce navigateur.',
      empty: 'Aucune session active renvoyée',
      emptyBody: 'La source n’a renvoyé aucune session active dans cette fenêtre.',
      session: 'Session',
      created: 'Créée',
      action: 'Action',
      table: 'Sessions d’identité ouvertes',
      revoke: 'Révoquer la session {id}',
      review: 'Révoquer la session',
      reviewBody: 'Révoquer uniquement la session vérifiée de ce compte ? Cela peut terminer l’accès de son navigateur.',
      confirm: 'Révoquer cette session',
      refresh: 'Actualiser les sessions',
      window: 'Sessions actives les plus récentes : limite demandée {limit}. Le service n’a pas de curseur.',
      more: 'Élargir la fenêtre des sessions',
      maximum: 'La fenêtre maximale est de 200 sessions ; les plus anciennes ne sont pas représentées.',
      revoked: 'Le service a révoqué la session sélectionnée.',
      unchanged: 'Le service n’a pas révoqué de session active. Actualisez la source avant de décider de la suite.',
      owner: 'Compte',
      original: 'Session vérifiée',
    },
  },
);

const seat = z.object({ id: z.string().uuid(), createdAt: z.string(), revoked: z.literal(false) });
/** The source exposes ownership and seat references only, never credentials. */
export interface PrivateSessionSource {
  userId: string;
  sessions: Array<z.infer<typeof seat>>;
}

export function IdentitySessions() {
  const { api, userId } = useSession();
  const { t, Copy, languageFor, requestedLocale } = copy.useCopy();
  const [limit, setLimit] = useState(50);
  const { resource, reload } = useResource<PrivateSessionSource>(
    (signal) =>
      api.query(
        'identity',
        'listSessions',
        { userId, limit },
        z
          .object({ userId: z.string().uuid(), sessions: z.array(seat).max(limit) })
          .refine((value) => value.userId === userId, 'Session ownership does not match this account'),
        { signal },
      ),
    `identity-seats:${userId}:${limit}`,
  );
  const [review, setReview] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ApiResult<{ userId: string; sessionId: string; revoked: boolean }> | null>(null);
  async function revoke() {
    if (!review || !userId || pending) return;
    const original = review;
    setPending(true);
    const outcome = await api.mutate(
      'identity',
      'revokeSession',
      { userId, sessionId: original },
      z
        .object({ userId: z.string().uuid(), sessionId: z.string().uuid(), revoked: z.boolean() })
        .refine(
          (value) => value.userId === userId && value.sessionId === original,
          'Session outcome does not match the reviewed account and seat',
        ),
    );
    setResult(outcome);
    setPending(false);
    if (outcome.ok) {
      setReview(null);
      reload();
    }
  }
  return (
    <section className="stack" aria-label={t('title')} lang={languageFor('title')}>
      <h3>
        <Copy k="title" />
      </h3>
      <p className="muted">
        <Copy k="scope" />
      </p>
      {resource.status === 'loading' ? (
        <Loading />
      ) : resource.status === 'failed' ? (
        <div lang="und">
          <Failure result={resource.failure} retry={reload} />
        </div>
      ) : resource.data.sessions.length === 0 ? (
        <EmptyState title={<Copy k="empty" />}>
          <Copy k="emptyBody" />
        </EmptyState>
      ) : (
        <DataTable label={t('table')} headers={[<Copy k="session" />, <Copy k="created" />, <Copy k="action" />]}>
          {resource.data.sessions.map((item) => (
            <tr key={item.id}>
              <td className="numeric" lang="zxx">
                {item.id}
              </td>
              <td>
                <time dateTime={item.createdAt} lang={requestedLocale}>
                  {new Date(item.createdAt).toLocaleString(requestedLocale)}
                </time>
              </td>
              <td>
                <Button
                  variant="ghost"
                  disabled={pending}
                  aria-label={t('revoke', { id: item.id })}
                  onClick={() => {
                    setResult(null);
                    setReview(item.id);
                  }}
                >
                  <Copy k="review" />
                </Button>
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <p className="muted">
        <Copy k="window" params={{ limit }} />
      </p>
      <div className="actions">
        <Button variant="secondary" onClick={reload}>
          <Copy k="refresh" />
        </Button>
        {limit < 200 ? (
          <Button variant="ghost" onClick={() => setLimit((value) => Math.min(200, value + 50))}>
            <Copy k="more" />
          </Button>
        ) : (
          <p className="muted">
            <Copy k="maximum" />
          </p>
        )}
      </div>
      {result &&
        (result.ok ? (
          <p role="status" className="notice">
            <Copy k={result.data.revoked ? 'revoked' : 'unchanged'} />
          </p>
        ) : (
          <div lang="und">
            <Failure result={result} />
          </div>
        ))}
      {review && (
        <Dialog title={<Copy k="review" />} onClose={() => !pending && setReview(null)}>
          <div className="stack">
            <p>
              <Copy k="reviewBody" />
            </p>
            <dl>
              <dt>
                <Copy k="owner" />
              </dt>
              <dd className="numeric" lang="zxx">
                {userId}
              </dd>
              <dt>
                <Copy k="original" />
              </dt>
              <dd className="numeric" lang="zxx">
                {review}
              </dd>
            </dl>
            <Button variant="danger" disabled={pending} onClick={() => void revoke()}>
              <Copy k="confirm" />
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
