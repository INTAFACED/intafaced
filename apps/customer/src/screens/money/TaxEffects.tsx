import { useRef, useState } from 'react';
import { z } from 'zod';
import { ACTIVITY_KINDS, Button, refusalCopy, StateBlock, type ActivityKind } from './deps';
import { moneyCopy } from './copy';
import { titleOf } from './activity-view';
import { groupKindsByEffect, type KnownEffect } from './tax-effects';
import { useSession } from '../../features/session/session';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

const effectsShape = z.object({ effects: z.record(z.string(), z.string()) });

const EFFECT_WORD: Record<KnownEffect, 'Tax effect income' | 'Tax effect disposal' | 'Tax effect neutral'> = {
  income: 'Tax effect income',
  disposal: 'Tax effect disposal',
  neutral: 'Tax effect neutral',
};

type State =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'refused'; code: string }
  | { kind: 'failed' }
  | { kind: 'ready'; effects: Record<string, string> };

/** A kind's words, as its rows say it. A kind this screen does not know shows as the bank named it. */
function kindWord(kind: string, copy: Copy): string {
  if (!(ACTIVITY_KINDS as readonly string[]).includes(kind)) return kind;
  // A kind can read differently in and out (a payment received or sent): the effect covers both, so both are named.
  const words = (['in', 'out'] as const).map((direction) =>
    titleOf({ kind: kind as ActivityKind, direction, counterparty: null } as Parameters<typeof titleOf>[0], copy.t, (key, handle) =>
      copy.t(key, { handle }),
    ),
  );
  return [...new Set(words)].join(' / ');
}

/**
 * Activity types grouped by how they are taxed (income, disposal, neutral). What each type means for tax is an owner and
 * counsel value: while it is not set the bank refuses with `portfolio.tax_effect_map_unset`, and this says so in words.
 * Nothing is ever shown as taxable by guess.
 */
export function TaxEffects() {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { api } = useSession();
  const [state, setState] = useState<State>({ kind: 'closed' });
  // Each ask gets a number; an answer to an older ask, or one that comes after the panel was closed, is dropped.
  const asked = useRef(0);

  async function load() {
    const ask = ++asked.current;
    setState({ kind: 'loading' });
    const result = await api.query('bank', 'activity.taxEffects', {}, effectsShape);
    if (ask !== asked.current) return;
    if (result.ok) setState({ kind: 'ready', effects: result.data.effects });
    // A refusal names its code; an unreachable bank or a broken answer has none and is offered again.
    else if (result.code && result.reason !== 'unreachable') setState({ kind: 'refused', code: result.code });
    else setState({ kind: 'failed' });
  }

  const open = state.kind !== 'closed';
  let body: React.ReactNode = null;
  if (state.kind === 'loading') body = <p className="money-detail__note">{t('Tax effect loading')}</p>;
  else if (state.kind === 'failed')
    body = <StateBlock kind="error" title={t('Tax effect failed')} onRetry={() => void load()} retryLabel={t('Try again')} />;
  else if (state.kind === 'refused') {
    const words = refusalCopy(state.code);
    body = (
      <StateBlock
        kind="refused"
        title={words.title}
        body={state.code === 'portfolio.tax_effect_map_unset' ? t('Tax effect unset body') : words.body}
        code={words.reference}
      />
    );
  } else if (state.kind === 'ready') {
    const { groups, unset } = groupKindsByEffect(state.effects);
    body = (
      <dl className="money-facts" data-label="tax-effects">
        {groups.map((group) => (
          <div className="money-fact" key={group.effect} data-effect={group.effect}>
            <dt>{group.effect in EFFECT_WORD ? t(EFFECT_WORD[group.effect as KnownEffect]) : group.effect}</dt>
            <dd>{group.kinds.map((kind) => kindWord(kind, copy)).join(', ')}</dd>
          </div>
        ))}
        {unset.length > 0 && (
          <div className="money-fact" data-effect="unset">
            <dt>{t('Tax effect not set')}</dt>
            <dd>{unset.map((kind) => kindWord(kind, copy)).join(', ')}</dd>
          </div>
        )}
      </dl>
    );
  }

  return (
    <section className="money-tax-effects" aria-label={t('Tax effect')}>
      <Button
        type="button"
        variant="secondary"
        size={40}
        aria-expanded={open}
        loading={state.kind === 'loading'}
        onClick={() => {
          if (!open) return void load();
          asked.current += 1;
          setState({ kind: 'closed' });
        }}
      >
        {open ? t('Hide tax effect groups') : t('Group by tax effect')}
      </Button>
      {open && <p className="money-detail__note">{t('Tax effect note')}</p>}
      {body}
    </section>
  );
}
