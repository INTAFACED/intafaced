import type { ApiResult } from '../../shared/api';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * The code a refusal starts with, as the service sends it: `quant.lake_store_unset — …`. The same rule as `StrategyTeam`'s
 * `refusalCode`, here so a room can read a code without reaching the team panel; once the layers meet, that one imports this.
 */
export const refusalCode = (result: Failed) => result.code ?? /^([a-z]+\.[a-z_]+) — /.exec(result.message.trim())?.[1] ?? null;
