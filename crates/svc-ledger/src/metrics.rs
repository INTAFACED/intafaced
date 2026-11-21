//! The book's scrape surface (`services/svc-ledger/src/metrics.ts`): the kit's request metrics
//! (`service_kit::metrics`, served at `GET /metrics` through the door's `Door::metrics`) and the two reconciliation
//! gauges read from the book on each scrape. `tooling/infra/prometheus.yaml` scrapes it at `svc-ledger:4001/metrics`.

use service_kit::metrics::GaugeSample;

use crate::db::Store;
use crate::reconcile::{self, LastVerified};

/// `reconcileGauges(last)`: the last `ok` run's time in whole Unix seconds and the `chain_tip` seq it covered; 0 means
/// never proved, which a staleness alert treats as stale.
pub fn reconcile_gauges(last: &LastVerified) -> Vec<GaugeSample> {
    vec![
        GaugeSample {
            name: "ledger_reconcile_last_verified_timestamp_seconds".to_owned(),
            help: "Unix time of the last reconciliation run that proved the book consistent (0 = never).".to_owned(),
            value: last
                .at_ms
                .map_or_else(|| "0".to_owned(), |ms| ms.div_euclid(1000).to_string()),
        },
        GaugeSample {
            name: "ledger_reconcile_last_verified_seq".to_owned(),
            help: "chain_tip seq the last ok reconciliation run covered (0 = never).".to_owned(),
            value: last.seq.clone().unwrap_or_else(|| "0".to_owned()),
        },
    ]
}

/// `gauges: async () => reconcileGauges(await ledger.lastVerified())`: a failed read is the caller's to skip.
pub fn gauges(store: &Store) -> Result<Vec<GaugeSample>, String> {
    reconcile::read_last_verified(store)
        .map(|last| reconcile_gauges(&last))
        .map_err(|e| e.message)
}
