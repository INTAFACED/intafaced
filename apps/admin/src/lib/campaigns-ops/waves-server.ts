import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import type { ExecuteFn } from '@/lib/desk/approval-steps';
import type { ExecuteReply } from '@/lib/desk/approval-types';
import { partFrom, type Part } from '@/lib/desk/part';
import { codeInText, explainRefusal, isKnownCode } from '@/lib/desk/refusal-copy';
import { failureRefusal } from '@/lib/ops-desk/execute';
import { readWavesState, type Wave, type WavesState } from './waves-model';

export interface WavesView {
  readonly asOf: string;
  readonly state: Part<WavesState>;
}

const FORBIDDEN = 'svc-identity did not accept your founder session for this read (it needs admin:read).';

export async function loadWaves(ctx: FounderCallContext): Promise<WavesView> {
  const result = await founderCall(ctx, 'identity', 'waitlist.waves.list', 'GET', undefined, readWavesState);
  return {
    asOf: new Date().toISOString(),
    state: partFrom(result, (d) => d, { service: 'svc-identity', forbiddenMessage: FORBIDDEN }),
  };
}

function readRelease(raw: unknown): { wave: Wave; created: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { wave, created } = raw as Record<string, unknown>;
  const state = readWavesState({ waveSize: null, nextWave: 1, waiting: 0, waves: [wave] });
  if (!state || typeof created !== 'boolean') return null;
  return { wave: state.waves[0]!, created };
}

const WRONG_WAVE: ExecuteReply = { ok: false, refusal: explainRefusal('admin.ops_invalid_response', 502, true) };

/** Run an approved wave release as the signed-in founder. The wave identity returns must be the one approved, or it is not reported done. */
export function wavesExecute(ctx: FounderCallContext): ExecuteFn {
  return async (request, ids) => {
    if (request.kind !== 'campaigns.waitlist.wave_release') {
      return { ok: false, refusal: explainRefusal('admin.request_invalid', 400, false) };
    }
    const result = await founderCall(
      ctx,
      'identity',
      'waitlist.waves.release',
      'POST',
      { waveNumber: Number(request.wave), ...ids },
      readRelease,
    );
    if (result.kind === 'refused' || result.kind === 'forbidden') {
      const code = result.refusal.code ?? codeInText(result.refusal.message) ?? /\[([a-z0-9_.]+)\]\s*$/.exec(result.refusal.message)?.[1];
      return { ok: false, refusal: explainRefusal(isKnownCode(code) ? code : null, result.refusal.status, false) };
    }
    if (result.kind !== 'ok') return failureRefusal('svc-identity', 'identity', result);
    const { wave, created } = result.data;
    if (String(wave.waveNumber) !== request.wave) return WRONG_WAVE;
    return {
      ok: true,
      detail: created
        ? `svc-identity answered: wave ${wave.waveNumber} released ${wave.releasedCount} of ${wave.size} people.`
        : `svc-identity answered: wave ${wave.waveNumber} was already released (${wave.releasedCount} people); nothing new was released.`,
    };
  };
}
