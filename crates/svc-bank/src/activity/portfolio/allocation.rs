//! The allocation (`portfolio/allocation.ts`, PF-balances-02): the priced holdings of the total-value rule, grouped;
//! nothing new is priced here. Class comes from svc-ledger's asset registry (`fiat`, `crypto` for crypto and the native
//! token, `commodity`), except USDT and USDC, which are `stablecoin` by their code, and USD, which is `fiat`. What sits in
//! the bank's earn positions is `earn`. An asset the registry does not list is `unclassified` and still counted. With no
//! registry the classes are left out and `classesRefused` says why. Each grouping adds up to the total exactly; a share
//! is value / total at 18 places, half-up.

use std::collections::HashMap;

use service_kit::json::Json;
use service_kit::money::{Amount, Rounding, format_amount, mul, mul_div, parse_amount};

use super::valuation::{Holding, Summary, UnpricedRow, locale_compare};

/// `ALLOCATION_CLASSES`, in order.
pub const CLASSES: [&str; 6] = [
    "fiat",
    "stablecoin",
    "crypto",
    "commodity",
    "earn",
    "unclassified",
];

const SCALE: Amount = Amount::whole(1);

/// `classOf`: the class of an asset outside its earn part.
pub fn class_of(asset: &str, kinds: &HashMap<String, String>) -> &'static str {
    let code = asset.to_uppercase();
    if code == "USDT" || code == "USDC" {
        return "stablecoin";
    }
    if code == "USD" {
        return "fiat";
    }
    match kinds.get(&code).map(String::as_str) {
        None => "unclassified",
        Some("fiat") => "fiat",
        Some("commodity") => "commodity",
        Some(_) => "crypto",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Share {
    pub name: String,
    pub value: String,
    pub share: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassRow {
    pub class: &'static str,
    pub value: String,
    pub share: String,
    pub assets: Vec<Share>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Allocation {
    pub total_value_usd: String,
    pub classes: Vec<ClassRow>,
    pub classes_refused: bool,
    /// `available`, then `locked`; none when nothing priced is held.
    pub types: Vec<Share>,
    pub unpriced: Vec<UnpricedRow>,
    pub as_of: i64,
}

impl Allocation {
    /// The answer in `allocationOutput`'s key order.
    pub fn json(&self) -> Json {
        let classes = self
            .classes
            .iter()
            .map(|c| {
                Json::obj([
                    ("class", Json::str(c.class)),
                    ("valueUsd", Json::str(c.value.clone())),
                    ("share", Json::str(c.share.clone())),
                    (
                        "assets",
                        Json::Array(
                            c.assets
                                .iter()
                                .map(|a| {
                                    Json::obj([
                                        ("asset", Json::str(a.name.clone())),
                                        ("valueUsd", Json::str(a.value.clone())),
                                        ("share", Json::str(a.share.clone())),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                ])
            })
            .collect();
        let types = self
            .types
            .iter()
            .map(|t| {
                Json::obj([
                    ("type", Json::str(t.name.clone())),
                    ("valueUsd", Json::str(t.value.clone())),
                    ("share", Json::str(t.share.clone())),
                ])
            })
            .collect();
        Json::obj([
            ("totalValueUsd", Json::str(self.total_value_usd.clone())),
            ("classes", Json::Array(classes)),
            (
                "classesRefused",
                if self.classes_refused {
                    Json::str("bank.asset_registry_unavailable")
                } else {
                    Json::Null
                },
            ),
            ("types", Json::Array(types)),
            (
                "unpriced",
                Json::Array(self.unpriced.iter().map(UnpricedRow::json).collect()),
            ),
            ("asOf", Json::int(self.as_of)),
        ])
    }
}

struct Line {
    asset: String,
    value: Amount,
    locked: Amount,
    earn: Amount,
    available: Amount,
    class: Option<&'static str>,
}

/// `allocate`. `kinds` is the registry's kind by upper-case asset id; `None`: no registry could be read.
pub fn allocate(
    summary: &Summary,
    holdings: &[Holding],
    kinds: Option<&HashMap<String, String>>,
) -> Allocation {
    let by_asset: HashMap<&str, &Holding> =
        holdings.iter().map(|h| (h.asset_id.as_str(), h)).collect();
    let lines: Vec<Line> = summary
        .priced
        .iter()
        .map(|row| {
            let value = parse_amount(&row.value_usd).unwrap_or_default();
            let price = parse_amount(&row.price_usd).unwrap_or_default();
            let holding = by_asset.get(row.asset.as_str());
            let used = holding.map_or(Amount::ZERO, |h| h.used);
            let locked = if used > Amount::ZERO {
                mul(used, price)
            } else {
                Amount::ZERO
            };
            let earn_raw = holding.and_then(|h| h.earn).unwrap_or(Amount::ZERO);
            let earn = if earn_raw <= Amount::ZERO {
                Amount::ZERO
            } else if earn_raw >= used {
                locked
            } else {
                mul(earn_raw, price)
            };
            Line {
                asset: row.asset.clone(),
                value,
                locked,
                earn,
                available: value - locked,
                class: kinds.map(|k| class_of(&row.asset, k)),
            }
        })
        .collect();
    let total: Amount = lines.iter().map(|l| l.value).sum();
    let share = |value: Amount| -> String {
        if total > Amount::ZERO {
            format_amount(mul_div(value, SCALE, total, Rounding::HalfUp))
        } else {
            "0".to_owned()
        }
    };
    let parts: Vec<(&str, Option<&'static str>, Amount)> = lines
        .iter()
        .flat_map(|l| {
            [
                (l.asset.as_str(), l.class, l.value - l.earn),
                (l.asset.as_str(), Some("earn"), l.earn),
            ]
        })
        .collect();
    let mut classes = Vec::new();
    if kinds.is_some() {
        for class in CLASSES {
            let mut members: Vec<&(&str, Option<&'static str>, Amount)> = parts
                .iter()
                .filter(|p| p.1 == Some(class) && p.2 > Amount::ZERO)
                .collect();
            if members.is_empty() {
                continue;
            }
            members.sort_by(|a, b| {
                if a.2 == b.2 {
                    locale_compare(a.0, b.0)
                } else {
                    b.2.cmp(&a.2)
                }
            });
            let value: Amount = members.iter().map(|p| p.2).sum();
            classes.push(ClassRow {
                class,
                value: format_amount(value),
                share: share(value),
                assets: members
                    .iter()
                    .map(|p| Share {
                        name: p.0.to_owned(),
                        value: format_amount(p.2),
                        share: share(p.2),
                    })
                    .collect(),
            });
        }
    }
    let available: Amount = lines.iter().map(|l| l.available).sum();
    let locked: Amount = lines.iter().map(|l| l.locked).sum();
    let types = if lines.is_empty() {
        Vec::new()
    } else {
        vec![
            Share {
                name: "available".to_owned(),
                value: format_amount(available),
                share: share(available),
            },
            Share {
                name: "locked".to_owned(),
                value: format_amount(locked),
                share: share(locked),
            },
        ]
    };
    Allocation {
        total_value_usd: format_amount(total),
        classes,
        classes_refused: kinds.is_none(),
        types,
        unpriced: summary.unpriced.clone(),
        as_of: summary.as_of,
    }
}
