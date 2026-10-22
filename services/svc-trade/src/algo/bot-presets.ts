/**
 * Bot strategy presets (copy-bots-otc-bots-003). Presets come only from an owner-published backtest source, and none is
 * wired in this build, so the read is `not_set` with no presets and no APR. No backtest figure is ever invented here.
 */
export interface BotPresetsView {
  readonly state: 'not_set';
  readonly presets: readonly never[];
}

export function botPresets(): BotPresetsView {
  return { state: 'not_set', presets: [] };
}
