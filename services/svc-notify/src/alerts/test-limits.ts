import { NO_ALERT_LIMITS, type AlertLimits } from './service.js';

/**
 * For tests that are about something other than limits: every owner limit stays blank except the price-alert quota, which every
 * create needs. TEST value, not a platform setting.
 */
export const TEST_ALERT_LIMITS: AlertLimits = { ...NO_ALERT_LIMITS, maxActivePrice: 1000, repeatFrequencies: [] };
