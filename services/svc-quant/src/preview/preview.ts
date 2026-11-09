/**
 * The Algo dev Preview rooms (AL-order-01): `/quant/editor`, `/quant/tester` and `/quant/optimise` carry full layouts on
 * TEST sample data, and every engine action on them is refused here with the platform's one typed Preview refusal
 * (`@intafaced/contracts` preview-refusal, IA-SPEC 3.3). The engines (the strategy language compiler and runtime, the tick
 * engine, the optimiser) do not exist in this build; nothing outside is missing, so this is never a NotConnected.
 *
 * The procedure is stateless: it validates the room and action from a closed list, reads nothing, writes nothing and
 * stores nothing, so there is no key and nothing to retry. It takes no free text and echoes only the validated pair.
 */
import { z } from 'zod';
import { PREVIEW_REFUSAL_CODE, previewRefusal, protectedProcedure, router, TRPCError } from '@intafaced/contracts';

/** Each Preview room's engine actions, and the engine each one needs. Engine ids name the missing engine, never a vendor. */
export const PREVIEW_ACTIONS = {
  editor: {
    compile: 'quant.strategy_compiler',
    debug: 'quant.strategy_runtime',
    step: 'quant.strategy_runtime',
    profile: 'quant.strategy_runtime',
  },
  tester: {
    start: 'quant.tick_engine',
  },
  optimise: {
    start: 'quant.optimiser',
    stop: 'quant.optimiser',
    resume: 'quant.optimiser',
    export: 'quant.optimiser',
  },
} as const satisfies Record<string, Record<string, string>>;

export type PreviewRoom = keyof typeof PREVIEW_ACTIONS;

export const previewActInputSchema = z.discriminatedUnion('room', [
  z.object({ room: z.literal('editor'), action: z.enum(['compile', 'debug', 'step', 'profile']) }).strict(),
  z.object({ room: z.literal('tester'), action: z.enum(['start']) }).strict(),
  z.object({ room: z.literal('optimise'), action: z.enum(['start', 'stop', 'resume', 'export']) }).strict(),
]);
export type PreviewActInput = z.infer<typeof previewActInputSchema>;

/** The engine a validated room and action needs. */
export function previewEngineOf(input: PreviewActInput): string {
  return (PREVIEW_ACTIONS[input.room] as Record<string, string>)[input.action]!;
}

/** Always throws the typed Preview refusal for a validated room and action: PRECONDITION_FAILED, nothing written. */
export function refusePreviewAct(input: PreviewActInput): never {
  const refusal = previewRefusal(previewEngineOf(input), input.action);
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: `${PREVIEW_REFUSAL_CODE} — ${refusal.engine}:${refusal.action}`,
    cause: Object.assign(new Error(refusal.label), refusal),
  });
}

/** `quant.preview.act`: signed-in sessions only; answers every engine action with the typed Preview refusal. */
export function createPreviewRouter() {
  return router({
    act: protectedProcedure
      .input(previewActInputSchema)
      .output(z.never())
      .mutation(({ input }): never => refusePreviewAct(input)),
  });
}
