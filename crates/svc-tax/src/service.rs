//! How svc-tax is put together, once, at start-up (`services/svc-tax/src/index.ts`): every client and store is made here
//! from the environment and handed to the service. Boot refuses what `index.ts` refuses: an environment `env.ts` refuses,
//! a half-set S2S configuration, a database with no pool size, a bad edge key or missing limits, a bad counsel map.

use std::sync::Arc;

use crate::clients::bank::BankOwnSpaces;
use crate::clients::ledger::HttpLedger;
use crate::clients::prices::TradePrices;
use crate::clients::venue::TradeVenueActivity;
use crate::edge::EdgeKey;
use crate::env::TaxEnv;
use crate::http::Fetch;
use crate::ports::{
    BasisStore, ChoiceStore, CloseSeriesSource, Ledger, OwnSpaces, PriceAtTime, VenueActivitySource,
};
use crate::s2s::{CallSigner, s2s_from_env};
use crate::stores::basis::PgBasisStore;
use crate::stores::choices::PgChoiceStore;
use crate::stores::pool::Pool;
use crate::tax::{
    Balance, Failure, HistoryEntry, LakeStatus, LedgerReads, Range, TaxDeps, TaxService,
};
use crate::time::Instant;
use crate::wire::{Wire, WireConfig};

pub const TAX_DATABASE_POOL_MAX_UNSET: &str = "tax.database_pool_max_unset";

/// Everything the service reads through, each `None` where `index.ts` leaves it out.
pub struct Ports {
    pub ledger: Arc<HttpLedger>,
    pub prices: Option<Arc<TradePrices>>,
    pub spaces: Option<Arc<BankOwnSpaces>>,
    pub venue: Option<Arc<TradeVenueActivity>>,
    pub basis: Option<Arc<PgBasisStore>>,
    pub choices: Option<Arc<PgChoiceStore>>,
    pub pool: Option<Arc<Pool>>,
    pub deposit_basis: Option<String>,
    pub lake: LakeStatus,
    pub indexer: LakeStatus,
}

impl Ports {
    pub fn as_ledger(&self) -> Arc<dyn Ledger> {
        self.ledger.clone()
    }
    pub fn as_prices(&self) -> Option<Arc<dyn PriceAtTime>> {
        self.prices.clone().map(|p| p as Arc<dyn PriceAtTime>)
    }
    pub fn as_closes(&self) -> Option<Arc<dyn CloseSeriesSource>> {
        self.prices.clone().map(|p| p as Arc<dyn CloseSeriesSource>)
    }
    pub fn as_spaces(&self) -> Option<Arc<dyn OwnSpaces>> {
        self.spaces.clone().map(|p| p as Arc<dyn OwnSpaces>)
    }
    pub fn as_venue(&self) -> Option<Arc<dyn VenueActivitySource>> {
        self.venue
            .clone()
            .map(|p| p as Arc<dyn VenueActivitySource>)
    }
    pub fn as_basis(&self) -> Option<Arc<dyn BasisStore>> {
        self.basis.clone().map(|p| p as Arc<dyn BasisStore>)
    }
    pub fn as_choices(&self) -> Option<Arc<dyn ChoiceStore>> {
        self.choices.clone().map(|p| p as Arc<dyn ChoiceStore>)
    }
}

/// Every port, made from the environment.
pub fn ports(env: &TaxEnv, fetch: &Arc<dyn Fetch>) -> Result<Ports, String> {
    // Per-service keys (S2S v3): S2S_AUTH_MODE off leaves the ledger reads on the shared secret alone.
    let s2s = s2s_from_env(
        &env.s2s_mode,
        env.s2s_keyring.as_deref(),
        env.s2s_signing_kid.as_deref(),
        env.s2s_signing_key.as_deref(),
        "svc-tax",
    )?;
    let keyed = match (s2s.signer, s2s.mode) {
        (Some(signer), Some(mode)) => Some((signer, mode)),
        _ => None,
    };
    let signer = CallSigner::new("svc-tax", "svc-ledger", &env.internal_secret, keyed);
    // No pool when the URL is blank. A URL with no size refuses: a pool would otherwise be filled in.
    let pool = match (&env.database_url, env.database_pool_max) {
        (None, _) => None,
        (Some(_), None) => {
            return Err(format!(
                "{TAX_DATABASE_POOL_MAX_UNSET}: DATABASE_POOL_MAX is unset — the basis store is not opened"
            ));
        }
        (Some(url), Some(max)) => Some(Arc::new(Pool::new(url, usize::try_from(max).unwrap_or(1)))),
    };
    Ok(Ports {
        ledger: Arc::new(HttpLedger::new(&env.ledger_url, signer, fetch.clone())),
        prices: env
            .trade_url
            .as_deref()
            .map(|u| Arc::new(TradePrices::new(u, fetch.clone()))),
        spaces: env.bank_url.as_deref().map(|u| {
            Arc::new(BankOwnSpaces::new(
                Some(u),
                Some(&env.internal_secret),
                fetch.clone(),
            ))
        }),
        venue: env.trade_url.as_deref().map(|u| {
            Arc::new(TradeVenueActivity::new(
                Some(u),
                Some(&env.internal_secret),
                fetch.clone(),
            ))
        }),
        basis: pool.clone().map(|p| Arc::new(PgBasisStore::new(p))),
        choices: pool.clone().map(|p| Arc::new(PgChoiceStore::new(p))),
        pool,
        deposit_basis: env.tax_deposit_basis.clone(),
        lake: LakeStatus::lake(env.data_lake_url.as_deref()),
        indexer: LakeStatus::indexer(env.indexer_url.as_deref()),
    })
}

/// The service's present `LedgerReads` (the year export's balances and history) over the HTTP ledger.
struct ExportReads(Arc<HttpLedger>);

impl LedgerReads for ExportReads {
    fn balances(&self, user_id: &str) -> Result<Vec<Balance>, Failure> {
        Ok(Ledger::balances(self.0.as_ref(), "user", user_id)?
            .into_iter()
            .map(|b| Balance {
                account: b.account,
                amount: b.amount,
            })
            .collect())
    }
    fn history(
        &self,
        account: &crate::tax::Account,
        range: Range,
    ) -> Result<Vec<HistoryEntry>, Failure> {
        Ledger::history(self.0.as_ref(), account, range)
    }
}

/// The milliseconds clock (`new Date()`).
pub fn system_now() -> Instant {
    Instant(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0),
    )
}

/// The door, built from the environment and the ports.
///
/// `TaxDeps` takes the ledger's export reads today; the lot book's readers, the prices, the spaces, the venue, the
/// deposit-basis policy and the two stores are made above and are handed in here as `TaxDeps` grows to take them.
pub fn wire(env: &TaxEnv, ports: &Ports) -> Result<Wire, String> {
    let tax = TaxService::new(TaxDeps {
        map_raw: env.tax_jurisdiction_map_json.clone(),
        reads: Box::new(ExportReads(ports.ledger.clone())),
        lake: ports.lake,
        indexer: ports.indexer,
        history_years: env.tax_history_years,
        now: Box::new(system_now),
    })
    .map_err(|e| format!("{}: {}", e.code, e.message))?;
    let wire = Wire::new(WireConfig {
        edge_secret: env.edge_secret.clone(),
        env: env.raw.clone(),
        tax,
    })?;
    Ok(match &env.edge_public_key {
        None => wire,
        Some(key) => wire.with_edge_key(EdgeKey::from_env(
            &env.service_name,
            key,
            env.edge_max_lifetime_seconds,
            env.edge_clock_skew_seconds,
        )?),
    })
}
