//! The activity slice (`PORT.md`): the person's money history and what is read from it. Every part is a read of
//! svc-ledger's book, svc-bank's own tables or the partner's record, except the person's own words on a line (notes,
//! disputes, saved filters, budgets) and the statement exports, which are svc-bank's own rows. Nothing here moves money.
//!
//! - `pages`: svc-ledger's `historyPage`, the read the feed and the balance entries share, and its TEST fault.
//! - `feed`: `activity.*` (`activity/`): the merged feed, one line and its transaction, the person's notes, disputes and
//!   saved filters, the partner's history, the tax-effect map.
//! - `statements`: `statements.*` (`statements/`) and the export worker.
//! - `analytics`: `analytics.*` (`router/analytics.router.ts`, `analytics/`).
//! - `portfolio`: `portfolio.*` (`router/portfolio.router.ts`, `portfolio/`).
//! - `calendar`: `calendar.*` (`calendar/`).
//! - `work_items`: `workItems.*` (`home/work-items.ts`).
//!
//! Each part answers its own calls ([`answer`]) and maps its own refusals as its TypeScript router does.

pub mod analytics;
pub mod calendar;
pub mod feed;
pub mod pages;
pub mod portfolio;
pub mod statements;
pub mod work_items;

use service_kit::json::Json;
use service_kit::time::Instant;
use service_kit::trpc::TrpcError;

use crate::door::{BankDoor, Ctx};

/// What the door holds for the slice, built once at start-up (`index.ts`'s `activity`, `statementJobs`, `portfolio`
/// options and `taxEffectsFor`).
pub struct Wiring {
    /// svc-ledger's `historyPage` for the feed (the TEST fault's failing reader when it is on).
    pub pages: Box<dyn pages::HistoryPages>,
    /// svc-ledger's `historyPage` for the balance entries: never the TEST fault, as `index.ts` builds it.
    pub entry_pages: Box<dyn pages::HistoryPages>,
    /// `INTERNAL_SERVICE_SECRET`: the feed's cursors and the statements' links are signed with it. None: the feed
    /// refuses as unavailable.
    pub cursor_secret: Option<String>,
    pub feed: feed::Wiring,
    pub statements: statements::Wiring,
    pub analytics: analytics::Wiring,
    pub portfolio: portfolio::Wiring,
    pub calendar: calendar::Wiring,
}

impl Wiring {
    /// Nothing wired: every history read fails and every owner value is blank.
    pub fn none() -> Wiring {
        Wiring {
            pages: Box::new(pages::NoPages),
            entry_pages: Box::new(pages::NoPages),
            cursor_secret: None,
            feed: feed::Wiring::none(),
            statements: statements::Wiring::none(),
            analytics: analytics::Wiring::none(),
            portfolio: portfolio::Wiring::none(),
            calendar: calendar::Wiring::none(),
        }
    }
}

/// What the binary hands each part to build its wiring from the environment (`index.ts`'s options).
pub struct Build<'a> {
    pub env: &'a crate::env::BankEnv,
    /// A signer for a call out of svc-bank to `audience`, signed as svc-bank as every other call is.
    pub signer: &'a dyn Fn(&str) -> service_kit::s2s::CallSigner,
    /// A fresh HTTP client for one port.
    pub fetch: &'a dyn Fn() -> Box<dyn service_kit::http::Fetch>,
}

impl Build<'_> {
    /// A raw value of the environment.
    pub fn raw(&self, key: &str) -> Option<&str> {
        self.env.raw.get(key).map(String::as_str)
    }

    /// svc-ledger's HTTP door, signed as svc-bank.
    pub fn ledger(&self) -> crate::spaces::ports::LedgerHttp {
        crate::spaces::ports::LedgerHttp::new(
            self.env.str("LEDGER_URL").unwrap_or_default(),
            (self.signer)("svc-ledger"),
            (self.fetch)(),
        )
    }
}

/// The slice's wiring from the environment, in `index.ts`'s order; each part refuses to start as the TypeScript does.
pub fn wiring(b: &Build<'_>) -> Result<Wiring, String> {
    let fault = pages::test_fault(
        b.raw("BANK_ACTIVITY_TEST_FAULT"),
        b.raw("APP_ENV"),
        b.raw("NODE_ENV"),
    )?;
    let pages: Box<dyn pages::HistoryPages> = if fault {
        Box::new(pages::FailingPages)
    } else {
        Box::new(pages::LedgerPages(b.ledger()))
    };
    Ok(Wiring {
        pages,
        entry_pages: Box::new(pages::LedgerPages(b.ledger())),
        cursor_secret: b.env.str("INTERNAL_SERVICE_SECRET").map(str::to_owned),
        feed: feed::wiring(b)?,
        statements: statements::wiring(b)?,
        analytics: analytics::wiring(b)?,
        portfolio: portfolio::wiring(b)?,
        calendar: calendar::wiring(b)?,
    })
}

/// What every part is handed for one call or one pass: the door (the store and every other slice's wiring and
/// dependencies, through its getters), this slice's wiring, and the time.
pub struct Deps<'a> {
    pub door: &'a BankDoor,
    pub w: &'a Wiring,
    pub now: Instant,
}

impl Deps<'_> {
    pub fn store(&self) -> &crate::db::Store {
        self.door.store()
    }
}

/// The slice's answer to one call, or `None` for a call no part answers yet.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    let path = ctx.call.path;
    let part = path.split_once('.').map_or(path, |(p, _)| p);
    let out = match part {
        "activity" => feed::answer(d, ctx),
        "statements" => statements::answer(d, ctx),
        "analytics" => analytics::answer(d, ctx),
        "portfolio" => portfolio::answer(d, ctx),
        "calendar" => calendar::answer(d, ctx),
        "workItems" => work_items::answer(d, ctx),
        _ => None,
    };
    out.map(|r| r.map(Some))
}

/// The principal's user id: every call of the slice is a person's own.
pub fn user_of<'c>(ctx: &'c Ctx<'_>) -> &'c str {
    ctx.principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default()
}
