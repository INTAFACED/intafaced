import {
  QUANT_EMBED_ORIGINS_UNSET,
  QUANT_SHARE_NOT_FOUND,
  QUANT_SHARE_RATE_LIMITED,
  QUANT_SHARE_TOKEN_UNSET,
  QuantError,
} from '../errors.js';
import { isBarBacktest, presentBacktest, readStoredBacktest } from '../engine/run.js';
import {
  publicJurisdictionProcedure,
  quantPublicResultSchema,
  quantShareCreatedSchema,
  quantShareEmbedSchema,
  quantShareStateSchema,
  router,
} from '@intafaced/contracts';
import { publicResultOf } from '../report/document.js';
import { z } from 'zod';
import { toTrpc, accountField, type QuantCore } from './core.js';

export function resultRoutes(core: QuantCore) {
  const { runs, shares, embedOrigins, shareNow, accountOf, requireShareLimits, requireSeq, sharePath, embedOf, ownedBar } = core;
  return router({
    share: router({
      /** How many links this run has, and whether one is active. The screen sends that count as `seq` on create. */
      get: publicJurisdictionProcedure('quant', 'fiat')
        .input(z.object({ runId: z.string().min(1), ...accountField }))
        .output(quantShareStateSchema)
        .query(async ({ input, ctx }) => {
          try {
            requireShareLimits();
            const accountId = accountOf(ctx, input.accountId);
            await ownedBar(accountId, input.runId);
            const rows = await shares!.list({ accountId, runId: input.runId });
            const active = rows.find((link) => link.revokedAt === null) ?? null;
            return { runId: input.runId, links: rows.length, active: active !== null, seq: active?.seq ?? null };
          } catch (err) {
            toTrpc(err);
          }
        }),

      /**
       * One active link per run, under `result.share:<runId>:<seq>`. The token is returned only by the call that
       * stores the link. A lost reply is answered by revoking and creating the next seq, never by a second token
       * for the same key.
       */
      create: publicJurisdictionProcedure('quant', 'fiat')
        .input(z.object({ runId: z.string().min(1), seq: z.unknown().optional(), ...accountField }))
        .output(quantShareCreatedSchema)
        .mutation(async ({ input, ctx }) => {
          try {
            requireShareLimits();
            const accountId = accountOf(ctx, input.accountId);
            await ownedBar(accountId, input.runId);
            const seq = requireSeq(input.seq);
            const created = await shares!.create({ accountId, runId: input.runId, seq, now: new Date(shareNow()).toISOString() });
            const shown = embedOf(created.token);
            return {
              runId: created.link.runId,
              links: created.links,
              active: created.link.revokedAt === null,
              seq: created.link.seq,
              token: created.token,
              path: created.token ? sharePath(created.token) : null,
              embed: shown.embed,
              embedRefusal: shown.embedRefusal,
            };
          } catch (err) {
            toTrpc(err);
          }
        }),

      revoke: publicJurisdictionProcedure('quant', 'fiat')
        .input(z.object({ runId: z.string().min(1), ...accountField }))
        .output(quantShareStateSchema)
        .mutation(async ({ input, ctx }) => {
          try {
            requireShareLimits();
            const accountId = accountOf(ctx, input.accountId);
            await ownedBar(accountId, input.runId);
            const revoked = await shares!.revoke({ accountId, runId: input.runId, now: new Date(shareNow()).toISOString() });
            return { runId: input.runId, links: revoked.links, active: false, seq: null };
          } catch (err) {
            toTrpc(err);
          }
        }),

      /**
       * The embed snippet for a token the caller already holds. A blank origin list refuses only this call.
       * The link stays. The token is not issued again.
       */
      embed: publicJurisdictionProcedure('quant', 'fiat')
        .input(z.object({ runId: z.string().min(1), token: z.unknown().optional(), ...accountField }))
        .output(quantShareEmbedSchema)
        .mutation(async ({ input, ctx }) => {
          try {
            requireShareLimits();
            if (embedOrigins === null || embedOrigins.length === 0) {
              throw new QuantError(QUANT_EMBED_ORIGINS_UNSET, 'embed origins — the list of frames is not set');
            }
            const token = typeof input.token === 'string' ? input.token.trim() : '';
            if (!token) throw new QuantError(QUANT_SHARE_TOKEN_UNSET, 'token — the share token is unset');
            const accountId = accountOf(ctx, input.accountId);
            await ownedBar(accountId, input.runId);
            const link = await shares!.matchActive({ accountId, runId: input.runId, token });
            if (!link) throw new QuantError(QUANT_SHARE_NOT_FOUND, 'not found');
            return {
              snippet: `<iframe src="${sharePath(token)}" title="Historical simulation — not a forecast"></iframe>`,
              origins: [...embedOrigins],
            };
          } catch (err) {
            toTrpc(err);
          }
        }),

      /** Signed-out read of a share link. Jurisdiction is quant/fiat, with no session. A revoked token and an unknown token answer the same not-found. */
      public: publicJurisdictionProcedure('quant', 'fiat')
        .input(z.object({ token: z.string() }))
        .output(quantPublicResultSchema)
        .query(async ({ input }) => {
          try {
            const limits = requireShareLimits();
            const opened = await shares!.openPublic({
              token: input.token,
              rate: limits.rate,
              windowMs: limits.windowMs,
              nowMs: shareNow(),
            });
            if (opened.kind === 'limited') {
              throw new QuantError(QUANT_SHARE_RATE_LIMITED, 'share rate — the published share rate is used up');
            }
            if (opened.kind !== 'ok') throw new QuantError(QUANT_SHARE_NOT_FOUND, 'not found');
            const row = await runs.get({ userId: opened.link.accountId, id: opened.link.runId });
            const stored = row && row.finished && row.outcome === 'ok' && isBarBacktest(row) ? readStoredBacktest(row.response) : null;
            if (!row || !stored) throw new QuantError(QUANT_SHARE_NOT_FOUND, 'not found');
            return publicResultOf(presentBacktest(stored, row.id));
          } catch (err) {
            toTrpc(err);
          }
        }),
    }),
  });
}
