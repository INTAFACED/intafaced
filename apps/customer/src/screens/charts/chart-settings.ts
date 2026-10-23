/**
 * The chart's settings, kept on this device for this person (a display choice, never money). A key this build does not
 * know, or a value of the wrong type, takes its default: nothing is refused and nothing is guessed.
 */
export interface ChartSettings {
  /** Symbol: the market name in the chart title. */
  showName: boolean;
  /** Status line: the time and the change in the legend. */
  showTime: boolean;
  showChange: boolean;
  /** Scales. */
  priceScale: boolean;
  timeScale: boolean;
  logScale: boolean;
  /** Canvas. */
  gridLines: boolean;
}

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  showName: true,
  showTime: true,
  showChange: true,
  priceScale: true,
  timeScale: true,
  logScale: false,
  gridLines: true,
};

export const CHART_SETTING_KEYS = Object.keys(DEFAULT_CHART_SETTINGS) as readonly (keyof ChartSettings)[];

/** Whatever was stored, read key by key: a known boolean is kept, anything else takes the default. */
export function readChartSettings(value: unknown): ChartSettings {
  const stored = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const out: Record<string, boolean> = { ...DEFAULT_CHART_SETTINGS };
  for (const key of CHART_SETTING_KEYS) {
    const v = stored[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return out as unknown as ChartSettings;
}

export const isStoredChartSettings = (value: unknown): value is ChartSettings => typeof value === 'object' && value !== null;

export const chartSettingsKey = (userId: string | null): string => `charts-chart-settings:${userId ?? 'guest'}`;
