import { quantStrategyHeadSchema, type QuantStrategyHead } from '@intafaced/contracts/quant-algo';
import { useState } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { signedDecimalSchema } from '../../shared/money';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { useApi } from '../session/session';
import { studioCopy } from './studio-copy';
import { useRuleWords } from './SignalBuilder';
import { ruleRefusal, signalRulesFilled, trimSignalRules } from './signal-rules';
import { fingerprint, saveKey, type StudioLink, type StudioRules } from './studio-save';

/** Whether the form holds everything a save needs; the service still checks each rule and refuses by name. */
export function savable(rules: StudioRules): boolean {
  return Boolean(
    rules.name.trim() &&
    signedDecimalSchema.safeParse(rules.cash.trim()).success &&
    (rules.modules
      ? signalRulesFilled(rules.modules)
      : rules.blocks.length > 0 && rules.blocks.every((b) => b.symbol.trim() && signedDecimalSchema.safeParse(b.qty.trim()).success)) &&
    rules.risk.maxDrawdown.trim() &&
    rules.risk.maxNotional.trim() &&
    rules.risk.kill.trim(),
  );
}

/**
 * Save to the account's library. The first save creates version 1; a save after a change adds the next version. The
 * key comes from the draft or from the version the change starts at, so pressing Save again after a lost reply
 * returns the first answer instead of a second strategy or version.
 */
/** The saved head with the note the service stored for its version, so a replayed save can be told apart. */
const savedHead = quantStrategyHeadSchema.extend({ releaseNote: z.string().default('') });

export function StudioSave({
  rules,
  link,
  onSaved,
}: {
  rules: StudioRules;
  link: StudioLink;
  onSaved: (head: QuantStrategyHead, saved: string) => void;
}) {
  const api = useApi();
  const { t } = studioCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [releaseNote, setReleaseNote] = useState('');
  const [keptNote, setKeptNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const current = fingerprint(rules);
  const unchanged = link.saved === current;
  const ready = savable(rules);
  // A save refused for one signal-rule input names that input, as Build source does.
  const { refusalText } = useRuleWords();
  const refusal = failure ? ruleRefusal(failure.message) : null;

  async function save() {
    if (busy || unchanged || !ready) return;
    setBusy(true);
    setFailure(null);
    setKeptNote(null);
    const note = releaseNote.trim();
    const body = {
      name: rules.name.trim(),
      cash: rules.cash.trim(),
      blocks: rules.modules ? [] : rules.blocks.map((b) => ({ side: b.side, symbol: b.symbol.trim(), qty: b.qty.trim() })),
      modules: rules.modules ? trimSignalRules(rules.modules) : null,
      risk: { maxDrawdown: rules.risk.maxDrawdown.trim(), maxNotional: rules.risk.maxNotional.trim(), kill: rules.risk.kill.trim() },
      environment: 'paper',
      presentedAs: 'paper',
      idempotencyKey: saveKey(link),
      ...(note ? { releaseNote: note } : {}),
    };
    const res =
      link.strategyId && link.version
        ? await api.mutate('quant', 'studio.update', { ...body, id: link.strategyId }, savedHead)
        : await api.mutate('quant', 'studio.save', { ...body, clientStrategyId: link.clientStrategyId }, savedHead);
    setBusy(false);
    // The rules the service holds now: a replay after a lost reply may hold the first press's rules, not the form's.
    if (res.ok) {
      // A replay answers with the note the first press stored. If that is not this note, keep it typed and say so.
      if (res.data.releaseNote === note) setReleaseNote('');
      else setKeptNote(res.data.releaseNote);
      onSaved(res.data, fingerprint(res.data));
    } else setFailure(res);
  }

  return (
    <div className="quant-save" data-testid="quant-save">
      <Field
        label={t('releaseNote')}
        hint={t('releaseNoteHint')}
        value={releaseNote}
        onChange={(event) => setReleaseNote(event.currentTarget.value)}
        disabled={busy}
      />
      <Button type="button" onClick={() => void save()} disabled={busy || unchanged || !ready} data-testid="quant-save-library">
        {t('save')}
      </Button>
      <p className="muted" role="status" data-testid="quant-save-state">
        {unchanged && link.version
          ? t('savedAs', { version: link.version })
          : !ready
            ? t('incomplete')
            : link.version
              ? t('changedSince', { version: link.version })
              : t('notSaved')}
      </p>
      {keptNote !== null && (
        <p role="status" data-testid="quant-save-note-kept">
          {keptNote ? t('noteReplayed', { note: keptNote }) : t('noteReplayedBlank')}
        </p>
      )}
      {busy && <Loading label={t('saving')} />}
      {failure && refusal ? (
        <p role="alert" className="error-text" data-testid="quant-save-refusal">
          {refusalText(refusal)}
        </p>
      ) : (
        failure && <Failure result={failure} retry={() => void save()} />
      )}
    </div>
  );
}
