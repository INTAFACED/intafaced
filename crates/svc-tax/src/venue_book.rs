//! The person's own venue accounts in their lot book (`services/svc-tax/src/venue-book.ts`, J-cex-spot-01 #11): each
//! account is a book of its own, built by the same lot engine from the venue's own fills and checked against the venue's
//! own balances, then listed beside the ledger book. A move into one of the account's own sub-accounts carries the lots
//! (J-portfolio-04 #2). Nothing is stored and nothing is posted.

use std::collections::HashMap;

use crate::lot_book::{
    BookChoices, BookInput, BookVenue, CarriedLot, Inflow, LotBook, VenueAccountRef,
    build_lot_book, is_par,
};
use crate::lot_engine::{CarriedFrom, SaleRules};
use crate::money::{Rounding, mul_rounded, parse_amount};
use crate::own_moves::OwnMove;
use crate::ports::{
    EngineMethod, Fill, FillLeg, InflowLine, VenueAccountActivity, VenueActivity, VenueFill,
};
use crate::tax::{Amount, Failure};
use crate::time::{Instant, js_date};

pub const TAX_VENUE_UNWIRED: &str = "tax.venue_unwired";
pub const TAX_VENUE_OFF: &str = "tax.venue_off";
pub const TAX_VENUE_UNAVAILABLE: &str = "tax.venue_unavailable";
/// `VENUE_TRANSFER_IN`: the reason a venue transfer in carries into the lot book.
pub const VENUE_TRANSFER_IN: &str = "venue.transfer_in";

fn amount(text: &str) -> Result<Amount, Failure> {
    parse_amount(text).map_err(Failure::Internal)
}

/// `new Date(text)` on a venue time; an invalid one fails the read as `toISOString` does.
fn when(text: &str) -> Result<Instant, Failure> {
    js_date(crate::basis::js_trim(text))
        .ok_or_else(|| Failure::Internal("Invalid time value".to_owned()))
}

/// `venueAccountKey`.
pub fn venue_account_key(venue_id: &str, owner: &str, sub_account: Option<&str>) -> String {
    match sub_account {
        None => format!("venue:{venue_id}:{owner}"),
        Some(s) => format!("venue:{venue_id}:{owner}:{s}"),
    }
}

pub fn key_of(a: &VenueAccountActivity) -> String {
    venue_account_key(&a.venue_id, &a.owner, a.sub_account.as_deref())
}

/// `venueFillToFill`.
pub fn venue_fill_to_fill(account: &str, f: &VenueFill) -> Result<Fill, Failure> {
    let qty = amount(&f.amount)?;
    let notional = mul_rounded(amount(&f.price)?, qty, Rounding::Ceil);
    let fee = amount(&f.fee)?;
    let (got, gave) = if f.buy {
        (&f.base, &f.quote)
    } else {
        (&f.quote, &f.base)
    };
    let (got_qty, gave_qty) = if f.buy {
        (qty, notional)
    } else {
        (notional, qty)
    };
    let in_got = f.fee_asset == *got;
    let in_gave = f.fee_asset == *gave;
    Ok(Fill {
        tx_id: format!("{account}:{}", f.fill_id),
        posted_at: when(&f.filled_at)?,
        received: FillLeg {
            asset_id: got.clone(),
            amount: if in_got { got_qty - fee } else { got_qty },
        },
        paid: Some(FillLeg {
            asset_id: gave.clone(),
            amount: if in_gave { gave_qty + fee } else { gave_qty },
        }),
        fee: (in_got || in_gave).then_some(fee),
        fee_asset_id: (!in_got).then(|| f.fee_asset.clone()),
    })
}

/// `venueArrivalLines`: one account's credits from outside, as arrivals (none: no `arrivals`).
pub fn venue_arrival_lines(a: &VenueAccountActivity) -> Result<Vec<InflowLine>, Failure> {
    let account = key_of(a);
    a.arrivals
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|x| {
            Ok(InflowLine {
                tx_id: format!("{account}:arrival:{}", x.arrival_id),
                posted_at: when(&x.arrived_at)?,
                asset_id: x.asset.clone(),
                amount: amount(&x.amount)?,
                reason: if x.kind == "deposit" {
                    "deposit.venue".to_owned()
                } else {
                    VENUE_TRANSFER_IN.to_owned()
                },
            })
        })
        .collect()
}

/// `venueOwnMoves`: the moves into a sub-account a main account lists.
pub fn venue_own_moves(a: &VenueAccountActivity) -> Result<Vec<OwnMove>, Failure> {
    let account = key_of(a);
    a.transfers
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|t| t.into_sub_account)
        .map(|t| {
            Ok(OwnMove {
                tx_id: format!("{account}:move:{}", t.move_id),
                posted_at: when(&t.settled_at)?,
                asset_id: t.asset.clone(),
                amount: amount(&t.amount)?,
                from: None,
                to: Some(venue_account_key(
                    &a.venue_id,
                    &a.owner,
                    Some(&t.sub_account),
                )),
            })
        })
        .collect()
}

/// What every venue account's book shares with the ledger book (`BookShared`).
pub struct BookShared<'a> {
    pub method: EngineMethod,
    pub rules: &'a SaleRules<'a>,
    pub preview: bool,
    pub choices: BookChoices,
    pub include_transfers: bool,
    pub now: Instant,
}

/// `VenueExtras`.
#[derive(Default)]
pub struct VenueExtras<'a> {
    pub inflows: HashMap<String, Vec<Inflow>>,
    pub override_price_per_unit: Option<&'a HashMap<String, Amount>>,
}

/// The lots a main account's moves put in each of its sub-accounts, by the sub-account's key.
type CarriedOut = Vec<(String, Vec<CarriedLot>)>;

fn venue_account_book(
    activity: &VenueAccountActivity,
    shared: &BookShared<'_>,
    carried_in: &[CarriedLot],
    extras: &VenueExtras<'_>,
) -> Result<(LotBook, CarriedOut), Failure> {
    let account = key_of(activity);
    let mut held: HashMap<String, Amount> = HashMap::new();
    for b in &activity.balances {
        let total = amount(&b.total)?;
        if total > 0 {
            *held.entry(b.asset.clone()).or_insert(0) += total;
        }
    }
    let moves = venue_own_moves(activity)?;
    let fills: Vec<Fill> = activity
        .fills
        .iter()
        .map(|f| venue_fill_to_fill(&account, f))
        .collect::<Result<_, _>>()?;
    let none: Vec<Inflow> = Vec::new();
    let inflows: &[Inflow] = if activity.arrivals.is_some() {
        extras.inflows.get(&account).unwrap_or(&none)
    } else {
        &[]
    };
    let book = build_lot_book(BookInput {
        fills: &fills,
        held: &held,
        method: shared.method,
        rules: Some(shared.rules),
        preview: shared.preview,
        choices: Some(shared.choices.clone()),
        truncated: false,
        outside_inflows: &[],
        inflows,
        now: shared.now,
        override_price_per_unit: extras.override_price_per_unit,
        moves: &moves,
        carried_in,
        spaces: None,
        space_held: None,
        withdrawals: &[],
        include_transfers: shared.include_transfers,
    });
    let mut carried_out: CarriedOut = Vec::new();
    for lot in &book.lots {
        let Some(space) = &lot.space_id else {
            continue;
        };
        let by_carry = lot
            .carried_from
            .as_ref()
            .and_then(|c| moves.iter().find(|m| m.tx_id == c.tx_id));
        let mv = by_carry.or_else(|| {
            moves.iter().find(|m| {
                m.to.as_deref() == Some(space.as_str())
                    && m.posted_at == lot.acquired_at
                    && m.asset_id == lot.asset_id
            })
        });
        let Some(mv) = mv else {
            continue;
        };
        let carried = CarriedLot {
            lot_id: lot.id.clone(),
            asset_id: lot.asset_id.clone(),
            acquired_at: lot.acquired_at,
            source: lot.source,
            reason: "moved to your venue sub-account".to_owned(),
            qty: lot.qty,
            cost_usd: lot.cost_usd,
            valued_at: lot.valued_at.clone(),
            tx_id: mv.tx_id.clone(),
            moved_at: mv.posted_at,
            from: lot.carried_from.as_ref().map(|c| CarriedFrom {
                lot_id: c.lot_id.clone(),
                tx_id: c.tx_id.clone(),
                moved_at: c.moved_at,
            }),
            customer_entered: lot.customer_entered,
            price_lot_id: lot.basis_lot_id.clone(),
        };
        match carried_out.iter_mut().find(|(k, _)| k == space) {
            Some((_, list)) => list.push(carried),
            None => carried_out.push((space.clone(), vec![carried])),
        }
    }
    let mut book = book;
    book.lots.retain(|l| l.space_id.is_none());
    for l in &mut book.lots {
        l.venue_account = Some(account.clone());
    }
    for s in &mut book.sales {
        s.venue_account = Some(account.clone());
    }
    book.assets.retain(|a| !is_par(&a.asset_id));
    for a in &mut book.assets {
        a.venue_account = Some(account.clone());
    }
    Ok((book, carried_out))
}

/// `buildVenueAccountBook`: one account's book on its own.
pub fn build_venue_account_book(
    activity: &VenueAccountActivity,
    shared: &BookShared<'_>,
    extras: &VenueExtras<'_>,
) -> Result<LotBook, Failure> {
    venue_account_book(activity, shared, &[], extras).map(|(b, _)| b)
}

/// `venueBooks`: every account's book in the order the accounts came; main accounts first, so their moves reach their
/// sub-accounts.
pub fn venue_books(
    accounts: &[VenueAccountActivity],
    shared: &BookShared<'_>,
    extras: &VenueExtras<'_>,
) -> Result<Vec<LotBook>, Failure> {
    let mut built: HashMap<String, LotBook> = HashMap::new();
    let mut carried: HashMap<String, Vec<CarriedLot>> = HashMap::new();
    for a in accounts.iter().filter(|a| a.sub_account.is_none()) {
        let (book, out) = venue_account_book(a, shared, &[], extras)?;
        built.insert(key_of(a), book);
        for (to, lots) in out {
            carried.entry(to).or_default().extend(lots);
        }
    }
    for a in accounts.iter().filter(|a| a.sub_account.is_some()) {
        let key = key_of(a);
        let lots = carried.get(&key).cloned().unwrap_or_default();
        let (book, _) = venue_account_book(a, shared, &lots, extras)?;
        built.insert(key, book);
    }
    accounts
        .iter()
        .map(|a| {
            built
                .get(&key_of(a))
                .cloned()
                .ok_or_else(|| Failure::Internal("a venue account's book is missing".to_owned()))
        })
        .collect()
}

/// `sumOrNull`.
fn sum_or_null(values: impl Iterator<Item = Option<Amount>>) -> Option<Amount> {
    let mut total: Amount = 0;
    for v in values {
        total += v?;
    }
    Some(total)
}

/// `withVenue`: the ledger book with the person's venue accounts beside it.
pub fn with_venue(
    main: LotBook,
    activity: Option<&VenueActivity>,
    shared: &BookShared<'_>,
    extras: &VenueExtras<'_>,
) -> Result<LotBook, Failure> {
    let mut books: Vec<LotBook> = Vec::new();
    let venue = match activity {
        None => BookVenue::Unwired,
        Some(VenueActivity::Off) => BookVenue::Off,
        Some(VenueActivity::Unavailable) => BookVenue::Unavailable,
        Some(VenueActivity::Read { test, accounts }) => {
            books = venue_books(accounts, shared, extras)?;
            BookVenue::Read {
                test: *test,
                accounts: accounts
                    .iter()
                    .map(|a| VenueAccountRef {
                        account: key_of(a),
                        venue_id: a.venue_id.clone(),
                        owner: a.owner.clone(),
                        sub_account: a.sub_account.clone(),
                        as_of: a.as_of.clone(),
                    })
                    .collect(),
            }
        }
    };
    let unread = venue == BookVenue::Unavailable;
    let counted = |b: &LotBook| {
        b.sales
            .iter()
            .any(|s| s.counted != crate::lot_book::Counted::None)
    };
    let all: Vec<&LotBook> = std::iter::once(&main).chain(books.iter()).collect();
    let selling: Vec<&&LotBook> = all.iter().filter(|b| counted(b)).collect();
    let realized_usd = if unread || selling.is_empty() {
        None
    } else {
        sum_or_null(selling.iter().map(|b| b.realized_usd))
    };
    let fees_usd = if unread {
        None
    } else {
        sum_or_null(all.iter().map(|b| b.fees_usd))
    };
    let mut residuals: Vec<&'static str> = all
        .iter()
        .flat_map(|b| b.residuals.iter().copied())
        .collect();
    if unread {
        residuals.push(TAX_VENUE_UNAVAILABLE);
    }
    residuals.sort_unstable();
    residuals.dedup();
    let mut out = main;
    for b in books {
        out.assets.extend(b.assets);
        out.sales.extend(b.sales);
        out.lots.extend(b.lots);
    }
    out.realized_usd = realized_usd;
    out.fees_usd = fees_usd;
    out.residuals = residuals;
    out.venue = Some(venue);
    Ok(out)
}
