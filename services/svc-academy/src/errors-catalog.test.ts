import { describe, expect, it } from 'vitest';
import {
  ACADEMY_ERROR_CODES,
  academyErrorCodeCount,
  isAcademyErrorCode,
  academyUnavailableErrorCodes,
  academyErrorCatalogBoardCard,
  academyErrorCatalogStatusLine,
  parseAcademyErrorCatalogStatusLine,
  academyErrorCatalogStatusLineMatches,
  academyErrorCatalogExportHeader,
  academyErrorCatalogExportLines,
  academyErrorCatalogExportText,
  academyErrorCodeCountInRange,
} from './errors.js';

describe('L3 wave59 academy error catalog honesty', () => {
  it('catalog boards and export', () => {
    expect(academyErrorCodeCount()).toBe(ACADEMY_ERROR_CODES.length);
    expect(isAcademyErrorCode('academy.room_full')).toBe(true);
    expect(isAcademyErrorCode('academy.not_a_code')).toBe(false);
    expect(academyUnavailableErrorCodes().every((c) => c.endsWith('_unavailable'))).toBe(true);
    expect(academyErrorCatalogBoardCard().total).toBe(ACADEMY_ERROR_CODES.length);
    expect(academyErrorCatalogStatusLineMatches()).toBe(true);
    expect(parseAcademyErrorCatalogStatusLine('nope')).toBeNull();
    expect(academyErrorCatalogExportText().startsWith(academyErrorCatalogExportHeader())).toBe(true);
    expect(academyErrorCatalogExportLines()).toHaveLength(ACADEMY_ERROR_CODES.length);
    expect(academyErrorCodeCountInRange(1, 200)).toBe(true);
    expect(academyErrorCodeCountInRange(ACADEMY_ERROR_CODES.length + 1, 10_000)).toBe(false);
    expect(academyErrorCodeCountInRange(100, 1)).toBe(false);
  });
});
