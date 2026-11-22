import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiResult } from '../../shared/api';
import { useSession } from '../session';
import { isStepUpCode, mintWithdrawToken, type WithdrawStepUpMethod } from './withdraw-step-up';
import { stepUpRefusalKeys, withdrawStepUpCopy } from './withdraw-step-up-copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
/**
 * What a "Confirm it's you" for `trade:withdraw` knows and does, whichever dialog draws it: the code typed, which way is
 * being checked, and the problem to show. The short token goes to `run` for exactly one call, as that call's own bearer,
 * and is dropped: never stored, never put in the session and never shown. A refusal of the action stays in the dialog
 * in the service's words; success calls `onDone`.
 */
export function useWithdrawStepUp({ run, onDone }: { run: (token: string) => Promise<ApiResult<unknown>>; onDone: () => void }) {
  const { api } = useSession();
  const { t } = withdrawStepUpCopy.useCopy();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'code' | 'passkey' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    return () => controller.abort();
  }, []);
  const gone = () => alive.current?.signal.aborted ?? true;

  const wordsFor = (result: Failed) =>
    result.code && stepUpRefusalKeys[result.code] ? t(stepUpRefusalKeys[result.code]!) : result.message || t('failed');

  async function confirm(method: WithdrawStepUpMethod, how: 'code' | 'passkey') {
    if (busy) return;
    setBusy(how);
    setProblem(null);
    const token = await mintWithdrawToken(api, method, alive.current?.signal);
    if (gone()) return;
    if (!token.ok) {
      setBusy(null);
      setProblem(wordsFor(token));
      return;
    }
    const answer = await run(token.data.accessToken);
    if (gone()) return;
    setBusy(null);
    if (!answer.ok) {
      setProblem(answer.message || t('failed'));
      return;
    }
    setCode('');
    onDone();
  }
  function withCode(event: FormEvent) {
    event.preventDefault();
    // The dialog may sit under a caller's own form; its submit is this dialog's alone.
    event.stopPropagation();
    if (busy) return;
    if (!isStepUpCode(code)) {
      setProblem(t('codeShort'));
      return;
    }
    void confirm({ code }, 'code');
  }
  return {
    code,
    setCode: (value: string) => setCode(value.trim().slice(0, 11)),
    busy,
    problem,
    withPasskey: () => void confirm({ passkey: true }, 'passkey'),
    withCode,
  };
}
