import { LEDGER_ACK_INVALID_MESSAGE, createLedgerTransport, parseLedgerPostAck, type HttpLedgerOptions } from './http-client.js';
import { LEDGER_POST_RECIPE, postRecipeRequest, type PostRecipeCall } from './post-recipe-record.js';
import type { LedgerClient } from './client.js';
import type { LedgerTx } from './types.js';

export * from './post-recipe-record.js';

/** Posts a recipe by its name and inputs; the ledger runs the recipe. */
export interface RecipePoster {
  postRecipe(call: PostRecipeCall): Promise<LedgerTx>;
}

/**
 * The HTTP client for svc-ledger's `postRecipe` door, on the same transport as `post`: signed per attempt over the exact
 * bytes, a timeout per attempt, bounded retries on a network failure, a timeout or a 502/503/504 only, and the same
 * `deadlineMs` budget. A retry is the same body, so the same recipe key: the ledger answers it with the original
 * transaction, never a second booking. Errors carry the ledger's code and the attempt count, so `classifyPostOutcome`
 * reads them exactly as it reads a `post`.
 *
 * Inputs the record or the recipe refuses are refused here, before anything is sent (`ledger.recipe_unknown`,
 * `ledger.recipe_input_invalid`). Like every code the door raises before the key is looked up, `classifyPostOutcome` reads
 * them as unknown, not refused (`post-outcome.ts`): a caller looks its key up rather than trust them. The receipt is parsed by the record and must name the key,
 * module and reason the recipe builds from these inputs; anything else is an unknown outcome, never a success.
 */
export function createHttpRecipePoster(options: HttpLedgerOptions): RecipePoster {
  const call = createLedgerTransport(options);
  return {
    async postRecipe(input) {
      const { request } = postRecipeRequest(input);
      const raw = await call<unknown>(LEDGER_POST_RECIPE.path, LEDGER_POST_RECIPE.input.parse(input));
      const receipt = LEDGER_POST_RECIPE.output.safeParse(raw);
      if (
        !receipt.success ||
        receipt.data.idempotencyKey !== request.idempotencyKey ||
        receipt.data.module !== request.module ||
        receipt.data.reason !== request.reason
      ) {
        throw new Error(LEDGER_ACK_INVALID_MESSAGE);
      }
      return parseLedgerPostAck(request, raw);
    },
  };
}

/**
 * The same door in process: the post the ledger would build for this call, handed to any `post` (the in-memory ledger in
 * tests). It builds with the same function the server runs, so a test through it books what the door books.
 */
export function recipePosterOver(ledger: Pick<LedgerClient, 'post'>): RecipePoster {
  return { postRecipe: async (input) => ledger.post(postRecipeRequest(input).request) };
}
