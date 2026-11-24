//! History when the partner bank holds the money (`partner-activity.ts`, OWNER 226): the ledger holds no line for a
//! partner-held person's bank money, so their history is the partner's own record of its moves, each labelled with
//! whose record it is. One move is a line on each of the person's accounts it touched.
//!
//! Only the filters the partner's record can answer are taken (asset, kind, direction, dates, account, text); any other
//! filter or oldest first refuses `bank.partner_history_filter_unsupported`.

use std::collections::BTreeMap;

use service_kit::time::js_date;

use super::service::{FeedError, Found, Item, Page, PartnerBook, Query, Spaces, bank};
use crate::partner::{AccountRef, FEES_OWNER, Move, MovesQuery, PAY_INS_OWNER, PAYOUTS_OWNER};

const SCAN_WINDOW: usize = 100;
const SCAN_MAX: usize = 2_000;

fn unsupported(name: &str) -> FeedError {
    bank(
        "bank.partner_history_filter_unsupported",
        format!(
            "The partner bank's history cannot be filtered by {name} here. Remove that filter to see it."
        ),
    )
}

fn assert_supported(q: &Query) -> Result<(), FeedError> {
    if q.sort.as_deref() == Some("asc") {
        return Err(unsupported("oldest first"));
    }
    let set = [
        (q.min_amount.is_some(), "amount"),
        (q.max_amount.is_some(), "amount"),
        (q.address.is_some(), "address"),
        (q.has_note.is_some_and(|h| h), "note"),
        (q.year.is_some(), "year"),
        (q.tax_year.is_some(), "tax year"),
    ];
    match set.iter().find(|(on, _)| *on) {
        Some((_, name)) => Err(unsupported(name)),
        None => Ok(()),
    }
}

/// `partnerLines`: the person's lines for one move, theirs only.
pub fn lines(user_id: &str, m: &Move, names: &BTreeMap<String, String>) -> Vec<Item> {
    let own = m.from.user_id == m.to.user_id;
    let payout = m.from.user_id == PAYOUTS_OWNER || m.to.user_id == PAYOUTS_OWNER;
    let pay_in = m.from.user_id == PAY_INS_OWNER || m.to.user_id == PAY_INS_OWNER;
    let fee = m.to.user_id == FEES_OWNER;
    let line = |side: &'static str, account: &AccountRef| Item {
        id: format!("{}.{side}", m.id),
        kind: if own {
            "space_move"
        } else if pay_in {
            "deposit"
        } else if fee {
            "fee"
        } else if payout {
            "withdrawal"
        } else if side == "out" {
            "transfer_out"
        } else {
            "transfer_in"
        },
        direction: side,
        asset: account.asset_id.clone(),
        amount: m.amount,
        posted_at: m.moved_at,
        tx_id: m.id.clone(),
        counterparty: None,
        space_name: account
            .space_id
            .as_ref()
            .and_then(|s| names.get(s).cloned()),
        order_id: None,
        purchase: false,
        note: None,
        reference: None,
        private_note: None,
        report_description: None,
        dispute: None,
        address: None,
        held_at: Some(m.label.to_owned()),
        fees: None,
    };
    let mut out = Vec::new();
    if m.from.user_id == user_id {
        out.push(line("out", &m.from));
    }
    if m.to.user_id == user_id {
        out.push(line("in", &m.to));
    }
    out
}

/// `new Date(text).toISOString()` as milliseconds; an unreadable date is NaN (every comparison false). The schema
/// held these to ISO date-times, so it does not arise from the door.
fn at(text: &str) -> Option<i64> {
    js_date(text).map(|i| i.0)
}

fn keeps(item: &Item, account: &AccountRef, q: &Query) -> bool {
    if let Some(k) = &q.kind
        && !k.iter().any(|k| k == item.kind)
    {
        return false;
    }
    if let Some(text) = q.q.as_ref().filter(|t| !t.is_empty()) {
        let hay = [
            item.kind.to_owned(),
            item.direction.to_owned(),
            item.asset.clone(),
            service_kit::money::format_amount(item.amount),
            item.tx_id.clone(),
            item.id.clone(),
            item.space_name.clone().unwrap_or_default(),
        ]
        .join("\n")
        .to_lowercase();
        if !hay.contains(&service_kit::money::js_trim(text).to_lowercase()) {
            return false;
        }
    }
    if let Some(d) = q.direction.as_ref().filter(|d| !d.is_empty())
        && item.direction != d
    {
        return false;
    }
    if let Some(f) = q.from.as_ref().filter(|f| !f.is_empty())
        && at(f).is_some_and(|f| item.posted_at.0 < f)
    {
        return false;
    }
    if let Some(t) = q.to.as_ref().filter(|t| !t.is_empty())
        && at(t).is_some_and(|t| item.posted_at.0 > t)
    {
        return false;
    }
    if let Some(a) = &q.account_id {
        let other = if a == "main" {
            account.space_id.is_some()
        } else {
            account.space_id.as_deref() != Some(a.as_str())
        };
        if other {
            return false;
        }
    }
    true
}

fn names_of(spaces: &dyn Spaces, user_id: &str) -> Result<BTreeMap<String, String>, FeedError> {
    Ok(spaces
        .all_named(user_id, None)?
        .into_iter()
        .map(|s| (s.id, s.name))
        .collect())
}

fn cursor_ok(c: &str) -> bool {
    (1..=128).contains(&c.len())
        && c.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `partnerActivityPage`.
pub fn page(
    user_id: &str,
    book: &dyn PartnerBook,
    spaces: &dyn Spaces,
    q: &Query,
    limit: usize,
) -> Result<Page, FeedError> {
    assert_supported(q)?;
    let from = q.from.as_deref().filter(|f| !f.is_empty()).map(at);
    if let (Some(Some(f)), Some(Some(t))) =
        (from, q.to.as_deref().filter(|t| !t.is_empty()).map(at))
        && t < f
    {
        return Err(FeedError::Range);
    }
    if let Some(c) = &q.cursor
        && !cursor_ok(c)
    {
        return Err(FeedError::CursorInvalid);
    }
    let names = names_of(spaces, user_id)?;
    let mut items: Vec<Item> = Vec::new();
    let mut before = q.cursor.clone().filter(|c| !c.is_empty());
    let mut scanned = 0usize;
    let mut last_taken: Option<String> = None;
    while scanned < SCAN_MAX {
        let window = book.moves(
            user_id,
            &MovesQuery {
                limit: SCAN_WINDOW,
                before: before.clone(),
                asset_id: q.asset_id.clone().filter(|a| !a.is_empty()),
                pay_ins: true,
            },
        )?;
        for m in &window {
            // Newest first: once a move is older than the range's start, nothing after it can match.
            if let Some(Some(f)) = from
                && m.moved_at.0 < f
            {
                return Ok(Page {
                    items,
                    next_cursor: None,
                });
            }
            let mine: Vec<Item> = lines(user_id, m, &names)
                .into_iter()
                .filter(|l| keeps(l, if l.direction == "out" { &m.from } else { &m.to }, q))
                .collect();
            // A page ends on a whole move, so a cursor never splits one move's two lines.
            if !items.is_empty() && items.len() + mine.len() > limit {
                return Ok(Page {
                    items,
                    next_cursor: last_taken,
                });
            }
            items.extend(mine);
            last_taken = Some(m.id.clone());
            scanned += 1;
            if items.len() >= limit {
                return Ok(Page {
                    items,
                    next_cursor: Some(m.id.clone()),
                });
            }
        }
        if window.len() < SCAN_WINDOW {
            return Ok(Page {
                items,
                next_cursor: None,
            });
        }
        before = window.last().map(|m| m.id.clone());
    }
    Ok(Page {
        items,
        next_cursor: last_taken,
    })
}

/// `partnerActivityItem`: one line of a partner move, and the person's other line of the same move.
pub fn item(
    user_id: &str,
    book: &dyn PartnerBook,
    spaces: &dyn Spaces,
    id: &str,
) -> Result<Found, FeedError> {
    let names = names_of(spaces, user_id)?;
    let mut before: Option<String> = None;
    let mut scanned = 0usize;
    while scanned < SCAN_MAX {
        let window = book.moves(
            user_id,
            &MovesQuery {
                limit: SCAN_WINDOW,
                before: before.clone(),
                asset_id: None,
                pay_ins: true,
            },
        )?;
        for m in &window {
            let all = lines(user_id, m, &names);
            if let Some(item) = all.iter().find(|l| l.id == id).cloned() {
                return Ok(Found {
                    item,
                    lines: all,
                    complete: true,
                });
            }
        }
        if window.len() < SCAN_WINDOW {
            return Err(FeedError::NotFound);
        }
        before = window.last().map(|m| m.id.clone());
        scanned += SCAN_WINDOW;
    }
    // The scan stopped before the partner's record ended, so "not found" would be a guess.
    Err(FeedError::LookupBounded)
}
