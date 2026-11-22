import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { ASSET_ACTIONS, ASSET_STATES, REGISTRY_ASSET_KINDS } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `assets.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/**
 * W-balances-05: svc-ledger's supported asset and network list, every state, retired included, so history that
 * names a retired asset still resolves. The same rows the address book offers and the deposit catalogue is narrowed
 * to. No registry, or an unreadable one, refuses `bank.asset_registry_unavailable`; never an empty list.
 */
export const BANK_ASSETS_LIST = defineProcedure({
  ...base,
  name: 'bank.assets.list',
  kind: 'query',
  path: 'assets.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    assets: z.array(
      z
        .object({
          assetId: z.string(),
          kind: z.enum(REGISTRY_ASSET_KINDS),
          precision: z.number().int().nonnegative(),
          networks: z.array(
            z
              .object({
                networkId: z.string(),
                label: z.string(),
                contract: z.string().nullable(),
                links: z.array(z.object({ label: z.string(), url: z.string() }).strict()),
              })
              .strict(),
          ),
          defaultNetworkId: z.string().nullable(),
          allowedActions: z.array(z.enum(ASSET_ACTIONS)),
          state: z.enum(ASSET_STATES),
        })
        .strict(),
    ),
  }),
  samples: [{ verdict: 'accept' }],
});
