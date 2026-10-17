/** Time windows for spending: named presets so nobody has to type two timestamps. All times are UTC instants. */
export const PERIOD_PRESETS = ['7d', '30d', 'month', 'lastMonth'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export function periodRange(preset: PeriodPreset, now: Date): { from: string; to: string } {
  const to = new Date(now.getTime());
  const day = 24 * 60 * 60 * 1000;
  switch (preset) {
    case '7d':
      return { from: new Date(to.getTime() - 7 * day).toISOString(), to: to.toISOString() };
    case '30d':
      return { from: new Date(to.getTime() - 30 * day).toISOString(), to: to.toISOString() };
    case 'month':
      return { from: new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1)).toISOString(), to: to.toISOString() };
    case 'lastMonth':
      return {
        from: new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 1, 1)).toISOString(),
        to: new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1)).toISOString(),
      };
  }
}
