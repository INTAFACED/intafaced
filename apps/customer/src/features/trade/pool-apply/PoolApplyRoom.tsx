import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button, Field, Input } from '@intafaced/ui';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { Refusal, RoomState } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { poolApplyCopy } from './pool-apply-copy';

/**
 * The master center (CB-copy-pro-share-11), on the flow template: apply to run a pooled strategy. The person's
 * application is read from svc-trade (`copy.myPoolMasterApplication`) and sent with `copy.applyToPoolMaster`, one per
 * person under its business key, so the same submit again answers with the same application. Founders see it on the
 * console's Copy trading desk. No pool opens while INTAFACED holds no customer money, and the room says so.
 */

// hand-declared-ok: svc-trade's copy procedures have no browser-safe schema in packages/contracts yet (the lead application room declares its own the same way)
const mineSchema = z.object({
  applicationId: z.string(),
  key: z.string(),
  state: z.literal('applied'),
  nickname: z.string(),
  style: z.string(),
  appliedAt: z.string(),
});
type Mine = z.infer<typeof mineSchema>;

type T = ReturnType<typeof poolApplyCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

function codeOf(failure: Failed): string | undefined {
  return /\[([a-z_.]+)\]\s*$/.exec(failure.message ?? '')?.[1] ?? failure.code;
}

function applyRefusal(failure: Failed, t: T): Refusal {
  const code = codeOf(failure);
  const reference = code ?? failure.reason;
  if (code === 'trade.pool_master_application_open') return { variant: 'refused', title: t('openTitle'), body: t('openBody'), reference };
  if (code === 'trade.pool_master_name_invalid') return { variant: 'refused', title: t('nameTitle'), body: t('nameBody'), reference };
  if (code === 'trade.pool_master_style_invalid') return { variant: 'refused', title: t('styleTitle'), body: t('styleBody'), reference };
  return {
    variant: failure.reason === 'unreachable' || failure.reason === 'uncertain' ? 'unreachable' : 'refused',
    title: t('refusedTitle'),
    body: failure.reason === 'uncertain' ? t('uncertainBody') : t('otherBody'),
    reference,
  };
}

export function PoolApplyRoom() {
  const { t } = poolApplyCopy.useCopy();
  const { api, userId } = useSession();
  const mine = useResource(
    (signal) =>
      userId
        ? api.query('trade', 'copy.myPoolMasterApplication', undefined, mineSchema.nullable(), { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `pool-apply:${userId ?? 'out'}`,
  );
  const [nickname, setNickname] = useState('');
  const [style, setStyle] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [sent, setSent] = useState<Mine | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const nicknameId = useId();
  const styleId = useId();

  const current = sent ?? (mine.resource.status === 'ready' ? mine.resource.data : null);

  async function apply(e: FormEvent) {
    e.preventDefault();
    // One request per submit, and never a second while the first has no answer.
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setRefusal(null);
    const out = await api.mutate('trade', 'copy.applyToPoolMaster', { nickname: nickname.trim(), style: style.trim() }, mineSchema);
    sending.current = false;
    setBusy(false);
    if (out.ok) setSent(out.data);
    else setRefusal(applyRefusal(out, t));
  }

  const state: RoomState = useMemo(() => {
    if (!userId)
      return {
        kind: 'refused',
        refusal: {
          variant: 'refused',
          title: t('signedOutTitle'),
          body: t('signedOutBody'),
          action: { label: t('signIn'), href: '/login?redirect=%2Fcopy%2Fpools%2Fapply' },
        },
      };
    if (mine.resource.status === 'loading') return { kind: 'loading' };
    if (mine.resource.status === 'failed')
      return {
        kind: 'refused',
        refusal: {
          variant: 'unreachable',
          title: t('readFailedTitle'),
          body: t('readFailedBody'),
          reference: codeOf(mine.resource.failure) ?? mine.resource.failure.reason,
          action: { label: t('tryAgain'), href: '/copy/pools/apply' },
        },
      };
    if (refusal) return { kind: 'ready', partial: { missing: refusal } };
    return { kind: 'ready' };
  }, [userId, mine.resource, refusal, t]);

  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      state={state}
      step={
        <div className="pool-apply">
          {sent ? <p role="status">{t('sent')}</p> : null}
          {current ? <p>{t('applied', { name: current.nickname })}</p> : null}
          {!current ? (
            <form aria-label={t('title')} onSubmit={(e) => void apply(e)}>
              <Field label={t('nicknameLabel')} hint={t('nicknameHint')}>
                <Input id={nicknameId} value={nickname} onValueChange={setNickname} maxLength={80} autoComplete="nickname" />
              </Field>
              <Field label={t('styleLabel')} hint={t('styleHint')}>
                <Input id={styleId} value={style} onValueChange={setStyle} maxLength={280} />
              </Field>
              <Button type="submit" variant="primary" loading={busy} disabled={busy}>
                {t('apply')}
              </Button>
            </form>
          ) : null}
        </div>
      }
      summary={
        <div>
          <h2>{t('summaryTitle')}</h2>
          <p>{t('summaryPools')}</p>
          <p>{t('summaryOnce')}</p>
        </div>
      }
    />
  );
}
