'use client';

import { useState } from 'react';
import { downloadCsv } from '@/lib/ops-desk/csv-browser';
import { venueCostsCsv, venueCostsFilename, type CostLineView } from '@/lib/venue-economics/model';
import '../desk.css';

/** The month's cost lines, every version, built in the browser from what the page already read. Nothing is fetched again. */
export function ExportCostsCsv({ period, asOf, lines }: { period: string; asOf: string; lines: readonly CostLineView[] }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="dk-row" data-testid="export-costs">
      <button
        type="button"
        className="adm-btn"
        onClick={() => setFailed(!downloadCsv(venueCostsFilename(period, asOf), venueCostsCsv(period, lines)))}
      >
        Export cost lines (CSV)
      </button>
      <span className="dk-muted">
        One row per entered version, and a “not_entered” row for each missing line; revenue is not in the file.
      </span>
      {failed && (
        <span className="dk-why" role="alert">
          The browser blocked the download.
        </span>
      )}
    </div>
  );
}
