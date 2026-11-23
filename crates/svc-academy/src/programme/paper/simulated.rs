//! What a drill may say it produced (`paper/simulated-result.ts`): the seal every paper figure leaves under, and the
//! valuation of a drill from fills trade published.
//!
//! Every price and size valued here is trade's, handed in as a decimal string. There is no price source, no mid and no
//! mark of our own: a fill with no published price or size refuses (`academy.paper_price_unavailable`), and an open
//! position with no published mark is reported unmarked. Amounts are decimal strings on the wire and exact integers in
//! memory ([`super::big::Big`], the TypeScript's unbounded bigint); a simulated drill posts, holds and settles nothing.

use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};
use service_kit::schema::{Value, js_trim};

use super::big::Big;
use crate::errors::{AcademyError, Refusal};

/// `SIMULATED_VENUE`: the only venue a sealed result may claim.
pub const SIMULATED_VENUE: &str = "paper";

/// `SIMULATED_DISCLAIMER`.
pub const SIMULATED_DISCLAIMER: &str = "Simulated result from a paper trading drill. No value moved, no ledger entry exists, and nothing here is withdrawable.";

/// `SIMULATED_SEAL`'s fields, in its order.
pub fn seal_fields() -> Vec<(String, Json)> {
    vec![
        ("simulated".to_owned(), Json::Bool(true)),
        ("venue".to_owned(), Json::str(SIMULATED_VENUE)),
        ("realLedger".to_owned(), Json::Bool(false)),
        ("withdrawable".to_owned(), Json::Bool(false)),
        ("realMoney".to_owned(), Json::Bool(false)),
        ("disclaimer".to_owned(), Json::str(SIMULATED_DISCLAIMER)),
    ]
}

/// `SIMULATED_SEAL`.
pub fn simulated_seal() -> Json {
    Json::Object(seal_fields())
}

/// `sealSimulated(result)`: the only constructor for a paper figure that leaves the service.
pub fn seal_simulated(result: Json) -> Json {
    let mut fields = seal_fields();
    fields.push(("result".to_owned(), result));
    Json::Object(fields)
}

/// `isSealedSimulated(value)`: every part of the seal present and saying what it must.
pub fn is_sealed_simulated(value: &Json) -> bool {
    let Json::Object(_) = value else {
        return false;
    };
    value.get("simulated") == Some(&Json::Bool(true))
        && value.get("venue") == Some(&Json::str(SIMULATED_VENUE))
        && value.get("realLedger") == Some(&Json::Bool(false))
        && value.get("withdrawable") == Some(&Json::Bool(false))
        && value.get("realMoney") == Some(&Json::Bool(false))
        && matches!(value.get("disclaimer"), Some(Json::String(s)) if !s.is_empty())
        && value.get("result").is_some()
}

/// `assertSealedSimulated(value)`: the door every paper payload passes before it is returned.
pub fn assert_sealed_simulated(value: Json) -> Result<Json, Refusal> {
    if is_sealed_simulated(&value) {
        Ok(value)
    } else {
        Err(AcademyError::new(
            "A paper drill result reached the wire without its simulated seal — refusing to return a figure that could be read as real.",
            "academy.paper_result_unlabelled",
        )
        .into())
    }
}

/// `simulatedLabelLine()`.
pub fn simulated_label_line() -> String {
    format!("simulated=1 venue={SIMULATED_VENUE} realLedger=0 withdrawable=0 realMoney=0")
}

/// `PublishedFill`, as it may arrive: `side`, `price` and `size` are read as the TypeScript reads them, so a missing
/// one or a JSON number is refused rather than coerced.
#[derive(Debug, Clone, PartialEq)]
pub struct PublishedFill {
    pub fill_id: String,
    pub market_id: String,
    pub side: Value,
    pub price: Value,
    pub size: Value,
}

fn refuse_price(what: &str) -> Refusal {
    AcademyError::new(
        format!("{what} — academy publishes no prices and will not invent one to finish a drill."),
        "academy.paper_price_unavailable",
    )
    .into()
}

/// `publishedAmount(raw, field, fillId)`.
fn published_amount(raw: &Value, field: &str, fill_id: &str) -> Result<Amount, Refusal> {
    let Some(text) = raw.as_str().filter(|s| !js_trim(s).is_empty()) else {
        return Err(refuse_price(&format!(
            "Fill {fill_id} carries no published {field}"
        )));
    };
    let trimmed = js_trim(text);
    let parsed = parse_amount(trimmed).map_err(|_| {
        refuse_price(&format!(
            "Fill {fill_id} has an unreadable published {field} \"{trimmed}\""
        ))
    })?;
    if parsed < 0 {
        return Err(refuse_price(&format!(
            "Fill {fill_id} has a negative published {field}"
        )));
    }
    Ok(parsed)
}

/// `uniquePublishedFills`: one fill per id; the same body twice counts once, a conflicting body refuses.
pub fn unique_published_fills(fills: &[PublishedFill]) -> Result<Vec<PublishedFill>, Refusal> {
    let mut unique: Vec<PublishedFill> = Vec::new();
    for fill in fills {
        let id = js_trim(&fill.fill_id);
        if id.is_empty() {
            return Err(refuse_price("A fill with no fillId cannot be valued"));
        }
        match unique.iter().find(|f| js_trim(&f.fill_id) == id) {
            None => unique.push(fill.clone()),
            Some(prior) => {
                if prior.market_id != fill.market_id
                    || prior.side != fill.side
                    || prior.price != fill.price
                    || prior.size != fill.size
                {
                    return Err(refuse_price(&format!(
                        "Fill {id} was published twice with conflicting trade data — refusing to invent a merged paper PnL"
                    )));
                }
            }
        }
    }
    Ok(unique)
}

/// `SimulatedValuation`: every figure a decimal string; `unrealised` and `total` are `None`, never a guess, when the
/// open size has no published mark.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimulatedValuation {
    pub fill_count: usize,
    pub bought_size: String,
    pub sold_size: String,
    pub open_size: String,
    pub average_buy_price: Option<String>,
    pub average_sell_price: Option<String>,
    pub realised_pnl: String,
    pub unrealised_pnl: Option<String>,
    pub total_pnl: Option<String>,
    pub mark_unavailable: bool,
}

fn opt(s: Option<&String>) -> Json {
    s.map_or(Json::Null, |v| Json::str(v.clone()))
}

impl SimulatedValuation {
    /// The valuation as returned, with its nested seal first.
    pub fn json(&self) -> Json {
        let mut fields = seal_fields();
        let count = i64::try_from(self.fill_count).unwrap_or(i64::MAX);
        fields.extend([
            ("fillCount".to_owned(), Json::int(count)),
            ("boughtSize".to_owned(), Json::str(self.bought_size.clone())),
            ("soldSize".to_owned(), Json::str(self.sold_size.clone())),
            ("openSize".to_owned(), Json::str(self.open_size.clone())),
            (
                "averageBuyPrice".to_owned(),
                opt(self.average_buy_price.as_ref()),
            ),
            (
                "averageSellPrice".to_owned(),
                opt(self.average_sell_price.as_ref()),
            ),
            (
                "realisedPnl".to_owned(),
                Json::str(self.realised_pnl.clone()),
            ),
            (
                "unrealisedPnl".to_owned(),
                opt(self.unrealised_pnl.as_ref()),
            ),
            ("totalPnl".to_owned(), opt(self.total_pnl.as_ref())),
            (
                "markUnavailable".to_owned(),
                Json::Bool(self.mark_unavailable),
            ),
        ]);
        Json::Object(fields)
    }
}

/// `valueSimulatedDrill(fills, markPrice)`: realised P&L over the matched size at the two average prices; the open size
/// marked only at a mark trade published.
pub fn value_simulated_drill(
    fills: &[PublishedFill],
    mark_price: Option<&str>,
) -> Result<SimulatedValuation, Refusal> {
    let unique = unique_published_fills(fills)?;
    let mut cost = Big::zero();
    let mut proceeds = Big::zero();
    let mut bought = Big::zero();
    let mut sold = Big::zero();

    for fill in &unique {
        let id = fill.fill_id.as_str();
        let side = fill.side.as_str();
        if side != Some("buy") && side != Some("sell") {
            return Err(refuse_price(&format!(
                "Fill {id} has no side, so it cannot be valued"
            )));
        }
        let price = Big::from_amount(published_amount(&fill.price, "price", id)?);
        let size = Big::from_amount(published_amount(&fill.size, "size", id)?);
        let notional = price.mul_scaled(&size);
        if side == Some("buy") {
            cost = cost.add(&notional);
            bought = bought.add(&size);
        } else {
            proceeds = proceeds.add(&notional);
            sold = sold.add(&size);
        }
    }

    let average_buy = if bought.is_positive() {
        cost.div_scaled(&bought)
    } else {
        None
    };
    let average_sell = if sold.is_positive() {
        proceeds.div_scaled(&sold)
    } else {
        None
    };

    let matched = if bought.compare(&sold).is_lt() {
        bought.clone()
    } else {
        sold.clone()
    };
    let realised = match (&average_buy, &average_sell) {
        (Some(buy), Some(sell)) if matched.is_positive() => sell.sub(buy).mul_scaled(&matched),
        _ => Big::zero(),
    };

    let open = bought.sub(&sold);

    let mut unrealised = Some(Big::zero());
    let mut mark_unavailable = false;
    if !open.is_zero() {
        match mark_price.filter(|m| !js_trim(m).is_empty()) {
            Some(mark) => {
                let mark = Big::from_amount(published_amount(
                    &Value::String(mark.to_owned()),
                    "mark price",
                    "(drill mark)",
                )?);
                let basis = if open.is_positive() {
                    &average_buy
                } else {
                    &average_sell
                };
                match basis {
                    None => {
                        unrealised = None;
                        mark_unavailable = true;
                    }
                    Some(basis) => unrealised = Some(mark.sub(basis).mul_scaled(&open)),
                }
            }
            None => {
                unrealised = None;
                mark_unavailable = true;
            }
        }
    }

    Ok(SimulatedValuation {
        fill_count: unique.len(),
        bought_size: bought.format_amount(),
        sold_size: sold.format_amount(),
        open_size: open.format_amount(),
        average_buy_price: average_buy.as_ref().map(Big::format_amount),
        average_sell_price: average_sell.as_ref().map(Big::format_amount),
        realised_pnl: realised.format_amount(),
        unrealised_pnl: unrealised.as_ref().map(Big::format_amount),
        total_pnl: unrealised.as_ref().map(|u| realised.add(u).format_amount()),
        mark_unavailable,
    })
}

/// `simulatedTotalPnlOrRefuse`: the total, or a refusal when the open size could not be marked.
pub fn simulated_total_pnl_or_refuse(valuation: &SimulatedValuation) -> Result<String, Refusal> {
    valuation.total_pnl.clone().ok_or_else(|| {
        refuse_price("Drill has an open position and trade published no mark for it")
    })
}

/// `isValuationComplete`.
pub fn is_valuation_complete(valuation: &SimulatedValuation) -> bool {
    valuation.total_pnl.is_some() && !valuation.mark_unavailable
}

/// `simulatedValuationLine`: carries the seal so a copied log line stays labelled.
pub fn simulated_valuation_line(valuation: &SimulatedValuation) -> String {
    let total = valuation.total_pnl.as_deref().unwrap_or("unmarked");
    format!(
        "{} fills={} realised={} total={total}",
        simulated_label_line(),
        valuation.fill_count,
        valuation.realised_pnl
    )
}
