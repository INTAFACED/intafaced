import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { useSession } from '../session';
import { confirmWithStepUp, factorStatus, type StepUpBegin, type StepUpMethod } from '../account';
import { isStepUpCode, mintWithdrawToken, type WithdrawStepUpMethod } from './withdraw-step-up';
import { stepUpRefusalKeys } from './WithdrawStepUp';
import { withdrawStepUpCopy } from './withdraw-step-up-copy';

/**
 * The logic of the two "Confirm it's you" parts, `WithdrawStepUp` and `StepUpConfirm`, as hooks, so a room in Volt
 * draws them with the kit's parts (volt/flow, #9570) and keeps exactly what they do: the same calls, the same
 * refusal words, nothing sent before the approval exists. The old parts stay as they are for the rooms not in Volt.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

function useAlive() {
  const alive = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    return () => controller.abort();
  }, []);
  return alive;
}

/** `WithdrawStepUp`'s logic: a passkey or a code buys one short `trade:withdraw` token, spent on `run` once. */
export function useWithdrawStepUp({ run, onDone }: { run: (token: string) => Promise<ApiResult<unknown>>; onDone: () => void }) {
  const { api } = useSession();
  const { t } = withdrawStepUpCopy.useCopy();
  const [code, setCodeRaw] = useState('');
  const [busy, setBusy] = useState<'code' | 'passkey' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useAlive();
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
    setCodeRaw('');
    onDone();
  }
  function submitCode(event: FormEvent) {
    event.preventDefault();
    // The sheet may sit under a caller's own form; its submit is this sheet's alone.
    event.stopPropagation();
    if (busy) return;
    if (!isStepUpCode(code)) {
      setProblem(t('codeShort'));
      return;
    }
    void confirm({ code }, 'code');
  }
  return {
    t,
    code,
    setCode: (value: string) => setCodeRaw(value.trim().slice(0, 11)),
    busy,
    problem,
    passkey: () => void confirm({ passkey: true }, 'passkey'),
    submitCode,
  };
}

const confirmRefusalKeys = { ...stepUpRefusalKeys, 'stepUp.no_passkey': 'noPasskey' } as const;

/** `StepUpConfirm`'s logic: a fresh code or a passkey buys one approval for exactly the request under review. */
export function useStepUpConfirm({
  request,
  codeShort,
  disabled,
  onApproved,
}: {
  request: () => StepUpBegin;
  codeShort: string;
  disabled: boolean;
  onApproved: (stepUpApprovalId: string | null) => void;
}) {
  const { api, userId } = useSession();
  const { t } = withdrawStepUpCopy.useCopy();
  const factors = useResource((signal) => api.query('identity', 'factorStatus', undefined, factorStatus, { signal }), `factors:${userId}`);
  const [code, setCodeRaw] = useState('');
  const [busy, setBusy] = useState<'code' | 'passkey' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useAlive();

  async function confirm(method: StepUpMethod, how: 'code' | 'passkey') {
    if (busy || disabled) return;
    setBusy(how);
    setProblem(null);
    const approved = await confirmWithStepUp(api, request(), method, alive.current?.signal);
    if (alive.current?.signal.aborted ?? true) return;
    setBusy(null);
    setCodeRaw('');
    if (!approved.ok) {
      if (approved.code === 'stepUp.code_malformed') return setProblem(codeShort);
      const key = approved.code ? confirmRefusalKeys[approved.code as keyof typeof confirmRefusalKeys] : undefined;
      setProblem(key ? t(key) : approved.message || t('failed'));
      return;
    }
    onApproved(approved.data.stepUpApprovalId);
  }
  function submitCode(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!/^\d{6}$/.test(code)) {
      setProblem(codeShort);
      return;
    }
    void confirm({ totpCode: code }, 'code');
  }
  const status = factors.resource;
  return {
    t,
    /** The factors are still being read: show "Checking" and nothing else. */
    checking: status.status === 'loading',
    /** No authenticator and no passkey: the request goes without an approval, and the bank alone decides. */
    noFactor: status.status === 'ready' && !status.data.authenticator.on && status.data.passkeys.count === 0,
    code,
    setCode: (value: string) => setCodeRaw(value.replace(/\D/g, '').slice(0, 6)),
    busy,
    problem,
    passkey: () => void confirm({ passkey: true }, 'passkey'),
    submitCode,
  };
}
