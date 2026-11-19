//! Own-account moves (`own-moves.ts`) and withdrawals to outside (`withdrawals.ts`).
//!
//! A transaction whose customer lines are one credit on one of their own accounts and one debit on another, of the same
//! coin and amount, is a move between their own accounts: the lot book carries the lots. Lines pair only inside one
//! transaction. A withdrawal is what its own hold account held less what came back, at the moment it was held.

use std::collections::HashSet;

use crate::ports::{AccountLine, InflowLine, SpaceLine, WithdrawalHold};
use crate::tax::{Amount, locale_compare};
use crate::time::Instant;

/// `OwnMove`. `None`: the main account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnMove {
    pub tx_id: String,
    pub posted_at: Instant,
    pub asset_id: String,
    pub amount: Amount,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// `SpaceInflow`: an arrival in one of the customer's spaces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceInflow {
    pub line: InflowLine,
    pub space_id: String,
}

pub struct Paired {
    pub moves: Vec<OwnMove>,
    pub main_inflows: Vec<InflowLine>,
    pub space_inflows: Vec<SpaceInflow>,
}

struct Leg<'a> {
    at: Option<&'a str>,
    out: bool,
    tx_id: &'a str,
    posted_at: Instant,
    asset_id: &'a str,
    amount: Amount,
}

fn key(tx_id: &str, asset_id: &str) -> String {
    format!("{tx_id}|{asset_id}")
}

/// `pairOwnMoves`.
pub fn pair_own_moves(
    main_inflows: &[InflowLine],
    main_outflows: &[AccountLine],
    space_lines: &[SpaceLine],
) -> Paired {
    fn add<'a>(by_tx: &mut Vec<(String, Vec<Leg<'a>>)>, k: String, leg: Leg<'a>) {
        match by_tx.iter_mut().find(|(x, _)| *x == k) {
            Some((_, legs)) => legs.push(leg),
            None => by_tx.push((k, vec![leg])),
        }
    }
    let mut by_tx: Vec<(String, Vec<Leg<'_>>)> = Vec::new();
    let space_tx: HashSet<String> = space_lines
        .iter()
        .map(|l| key(&l.line.tx_id, &l.line.asset_id))
        .collect();
    for l in space_lines {
        add(
            &mut by_tx,
            key(&l.line.tx_id, &l.line.asset_id),
            Leg {
                at: Some(&l.space_id),
                out: !l.line.debit,
                tx_id: &l.line.tx_id,
                posted_at: l.line.posted_at,
                asset_id: &l.line.asset_id,
                amount: l.line.amount,
            },
        );
    }
    for l in main_outflows {
        let k = key(&l.tx_id, &l.asset_id);
        if space_tx.contains(&k) {
            add(
                &mut by_tx,
                k,
                Leg {
                    at: None,
                    out: true,
                    tx_id: &l.tx_id,
                    posted_at: l.posted_at,
                    asset_id: &l.asset_id,
                    amount: l.amount,
                },
            );
        }
    }
    for l in main_inflows {
        let k = key(&l.tx_id, &l.asset_id);
        if space_tx.contains(&k) {
            add(
                &mut by_tx,
                k,
                Leg {
                    at: None,
                    out: false,
                    tx_id: &l.tx_id,
                    posted_at: l.posted_at,
                    asset_id: &l.asset_id,
                    amount: l.amount,
                },
            );
        }
    }
    let mut moves = Vec::new();
    let mut paired: HashSet<String> = HashSet::new();
    for (k, legs) in &by_tx {
        let out: Vec<&Leg<'_>> = legs.iter().filter(|l| l.out).collect();
        let into: Vec<&Leg<'_>> = legs.iter().filter(|l| !l.out).collect();
        let ([from], [to]) = (out.as_slice(), into.as_slice()) else {
            continue;
        };
        if from.at == to.at || from.amount != to.amount {
            continue;
        }
        moves.push(OwnMove {
            tx_id: to.tx_id.to_owned(),
            posted_at: to.posted_at,
            asset_id: to.asset_id.to_owned(),
            amount: to.amount,
            from: from.at.map(str::to_owned),
            to: to.at.map(str::to_owned),
        });
        paired.insert(k.clone());
    }
    let main_inflows = main_inflows
        .iter()
        .filter(|l| !paired.contains(&key(&l.tx_id, &l.asset_id)))
        .cloned()
        .collect();
    let space_inflows = space_lines
        .iter()
        .filter(|l| l.line.debit && !paired.contains(&key(&l.line.tx_id, &l.line.asset_id)))
        .map(|l| SpaceInflow {
            line: InflowLine {
                tx_id: l.line.tx_id.clone(),
                posted_at: l.line.posted_at,
                asset_id: l.line.asset_id.clone(),
                amount: l.line.amount,
                reason: l.line.reason.clone(),
            },
            space_id: l.space_id.clone(),
        })
        .collect();
    moves.sort_by(|a, b| {
        a.posted_at
            .cmp(&b.posted_at)
            .then_with(|| locale_compare(&a.tx_id, &b.tx_id))
    });
    Paired {
        moves,
        main_inflows,
        space_inflows,
    }
}

pub const WITHDRAW_HELD: &str = "withdraw.held";
pub const WITHDRAW_REVERSED: &str = "withdraw.reversed";
/// `WITHDRAWAL_HOLD_PREFIX`.
pub const WITHDRAWAL_HOLD_PREFIX: &str = "withdraw:";

fn by_time(a: &AccountLine, b: &AccountLine) -> std::cmp::Ordering {
    a.posted_at
        .cmp(&b.posted_at)
        .then_with(|| locale_compare(&a.tx_id, &b.tx_id))
}

/// `outsideWithdrawals`.
pub fn outside_withdrawals(holds: &[WithdrawalHold]) -> Vec<AccountLine> {
    let mut out = Vec::new();
    for hold in holds {
        if !hold.purpose.starts_with(WITHDRAWAL_HOLD_PREFIX) {
            continue;
        }
        let mut held: Vec<AccountLine> = hold
            .lines
            .iter()
            .filter(|l| l.reason == WITHDRAW_HELD && l.debit)
            .cloned()
            .collect();
        held.sort_by(by_time);
        let mut back: Amount = hold
            .lines
            .iter()
            .filter(|l| l.reason == WITHDRAW_REVERSED && !l.debit)
            .map(|l| l.amount)
            .sum();
        for line in held.iter_mut().rev() {
            if back <= 0 {
                break;
            }
            let take = line.amount.min(back);
            line.amount -= take;
            back -= take;
        }
        out.extend(held.into_iter().filter(|l| l.amount > 0));
    }
    out.sort_by(by_time);
    out
}
