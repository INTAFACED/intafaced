//! Spread instruments (`spread-instrument.ts`): owner-listed calendar and inter-coin spreads.
//!
//! A listing is owner data. Every field is required; a blank, zero or malformed one refuses with its own code and
//! nothing is filled in. There are no sample listings.
//!
//! For legs `i` with side sign `s_i` (+1 buy, -1 sell, from the spread buyer's side) and ratio `r_i`:
//!
//! ```text
//! spread = s_0 * r_0 * P_0 + s_1 * r_1 * P_1
//! ```
//!
//! so a spread price may be zero or negative. A fill prints at the maker's spread price `S`; leg 0, the anchor, prints at
//! the taker's anchor reference `R`, and leg 1 at the one price that makes the identity exact:
//! `P_1 = (S - s_0 * r_0 * R) / (s_1 * r_1)`. The division must be exact at 18 places and `P_1` positive, or the whole
//! spread refuses. Nothing here rounds.
//!
//! JavaScript's bigint has no width; here each product is formed in 256 bits (`mul_div`), and a sum past an i128 is a
//! value that does not fit, which refuses as one past `MAX_AMOUNT` does.

use service_kit::money::{Amount, MAX_AMOUNT, Rounding, format_amount, mul_div, parse_amount};

use super::types::{
    Reject, Side, SpreadInstrument, SpreadKind, SpreadLegDefinition, SpreadLegFill,
};

const SCALE: Amount = Amount::whole(1);

/// Exactly two legs: one anchor and one residual.
pub const SPREAD_LEG_COUNT: usize = 2;

const MAX_ID: usize = 128;

/// A listing as it arrives: strings or blanks, each part `None` when absent or null.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SpreadListingInput {
    pub spread_id: Option<String>,
    pub kind: Option<String>,
    /// `None` when `legs` is not a list.
    pub legs: Option<Vec<SpreadLegInput>>,
    pub tick: Option<String>,
    pub lot: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SpreadLegInput {
    pub symbol: Option<String>,
    pub side: Option<String>,
    pub ratio: Option<String>,
}

fn refuse(code: &str, message: impl Into<String>) -> Reject {
    Reject::new(code, message)
}

fn trim(s: &str) -> &str {
    service_kit::schema::js_trim(s)
}

fn length(s: &str) -> usize {
    service_kit::s2s::js_length(s)
}

/// A positive decimal string, or none: blank, zero, negative and malformed are all none, never a default.
fn read_positive(raw: Option<&String>) -> Option<Amount> {
    let t = trim(raw?);
    if t.is_empty() {
        return None;
    }
    parse_amount(t).ok().filter(|v| *v > Amount::ZERO)
}

fn fits(v: Amount) -> Option<Amount> {
    (-MAX_AMOUNT..=MAX_AMOUNT).contains(&v).then_some(v)
}

/// `a * b / d` when it is exact; none when it is not, or `d` is zero, or it does not fit.
fn exact(a: Amount, b: Amount, d: Amount) -> Option<Amount> {
    if d == Amount::ZERO {
        return None;
    }
    let lo = mul_div(a, b, d, Rounding::Floor);
    let hi = mul_div(a, b, d, Rounding::Ceil);
    if lo != hi {
        return None;
    }
    fits(lo)
}

/// `mulExact`: `a x b` at 18 places, or none when it is not exact or does not fit.
pub fn mul_exact(a: Amount, b: Amount) -> Option<Amount> {
    exact(a, b, SCALE)
}

/// `divExact`: `a / b` at 18 places, or none when it is not exact, `b` is zero, or it does not fit.
pub fn div_exact(a: Amount, b: Amount) -> Option<Amount> {
    exact(a, SCALE, b)
}

/// A leg's sign, `1` or `-1`: a plain factor, not money.
fn sign(side: Side) -> i128 {
    match side {
        Side::Buy => 1,
        Side::Sell => -1,
    }
}

/// `readSpreadListing`: the first missing or invalid field refuses with its own code.
pub fn read_spread_listing(input: &SpreadListingInput) -> Result<SpreadInstrument, Reject> {
    let spread_id = input.spread_id.as_deref().map(trim).unwrap_or("");
    if spread_id.is_empty() || length(spread_id) > MAX_ID {
        return Err(refuse(
            "spread_id_missing",
            "a spread listing needs an id; the engine does not invent one",
        ));
    }
    let kind =
        SpreadKind::parse(input.kind.as_deref().map(trim).unwrap_or("")).ok_or_else(|| {
            refuse(
                "spread_kind_unsupported",
                "spread kind must be one of calendar, inter_coin; the engine does not guess one",
            )
        })?;
    let raw_legs = match &input.legs {
        Some(l) if l.len() == SPREAD_LEG_COUNT => l,
        _ => {
            return Err(refuse(
                "spread_legs_invalid",
                "a spread lists exactly 2 legs: an anchor leg and a residual leg",
            ));
        }
    };
    let mut legs: Vec<SpreadLegDefinition> = Vec::new();
    for (index, leg) in raw_legs.iter().enumerate() {
        let symbol = leg.symbol.as_deref().map(trim).unwrap_or("");
        if symbol.is_empty() || length(symbol) > MAX_ID {
            return Err(refuse(
                "spread_leg_symbol_missing",
                format!("spread leg {index} has no symbol; the engine does not invent one"),
            ));
        }
        let side = Side::parse(leg.side.as_deref().map(trim).unwrap_or("")).ok_or_else(|| {
            refuse(
                "spread_leg_side_missing",
                format!(
                    "spread leg {index} needs side buy or sell; the engine does not invent one"
                ),
            )
        })?;
        let ratio = read_positive(leg.ratio.as_ref()).ok_or_else(|| {
            refuse(
                "spread_ratio_missing",
                format!("spread leg {index} needs a positive ratio; blank or zero is not 1"),
            )
        })?;
        legs.push(SpreadLegDefinition {
            symbol: symbol.to_owned(),
            side,
            ratio,
        });
    }
    let Ok::<[SpreadLegDefinition; 2], _>(legs) = legs.try_into() else {
        return Err(refuse(
            "spread_legs_invalid",
            "a spread lists exactly 2 legs: an anchor leg and a residual leg",
        ));
    };
    let [anchor, residual] = &legs;
    if anchor.symbol == residual.symbol {
        return Err(refuse(
            "spread_legs_invalid",
            "spread legs must name two different symbols",
        ));
    }
    if anchor.symbol == spread_id || residual.symbol == spread_id {
        return Err(refuse(
            "spread_legs_invalid",
            "a spread leg cannot be the spread itself",
        ));
    }
    if anchor.side == residual.side {
        return Err(refuse(
            "spread_legs_invalid",
            "a spread buys one leg and sells the other",
        ));
    }
    if kind == SpreadKind::Calendar && anchor.ratio != residual.ratio {
        return Err(refuse(
            "spread_legs_invalid",
            "a calendar spread trades both legs at the same ratio",
        ));
    }
    let tick = read_positive(input.tick.as_ref()).ok_or_else(|| {
        refuse(
            "spread_tick_missing",
            "a spread listing needs a positive tick; blank is not a default",
        )
    })?;
    let lot = read_positive(input.lot.as_ref()).ok_or_else(|| {
        refuse(
            "spread_lot_missing",
            "a spread listing needs a positive lot; blank is not a default",
        )
    })?;
    for (index, leg) in legs.iter().enumerate() {
        if mul_exact(lot, leg.ratio).is_none() {
            return Err(refuse(
                "spread_size_inexact",
                format!("lot x ratio for leg {index} is not exact at 18 decimals"),
            ));
        }
    }
    if div_exact(tick, residual.ratio).is_none() {
        return Err(refuse(
            "spread_size_inexact",
            "tick / residual ratio is not exact at 18 decimals, so a residual leg price would need rounding",
        ));
    }
    Ok(SpreadInstrument {
        spread_id: spread_id.to_owned(),
        kind,
        legs,
        tick,
        lot,
    })
}

/// `spreadIdentity`: one string per listing; leg order is part of it.
pub fn spread_identity(instrument: &SpreadInstrument) -> String {
    super::wire::spread_json(instrument).compact()
}

/// The anchor reference is caller data: missing, not positive, or one that would need rounding refuses.
pub fn spread_reference_refuse(
    instrument: &SpreadInstrument,
    reference: Option<Amount>,
) -> Option<Reject> {
    let missing = || {
        refuse(
            "spread_reference_missing",
            "a spread order needs an anchor leg reference price; the engine does not invent a mark",
        )
    };
    let Some(reference) = reference.filter(|r| *r > Amount::ZERO) else {
        return Some(missing());
    };
    let [anchor, residual] = &instrument.legs;
    let term = mul_exact(anchor.ratio, reference);
    if term.and_then(|t| div_exact(t, residual.ratio)).is_none() {
        return Some(refuse(
            "spread_reference_missing",
            "the anchor reference is not exact at 18 decimals for this listing; the engine does not round it",
        ));
    }
    None
}

fn unfillable(message: impl Into<String>) -> Reject {
    refuse("spread_leg_unfillable", message)
}

/// `[anchor price, residual price]` for a spread price, or the refusal. Never rounds.
pub fn spread_leg_prices(
    instrument: &SpreadInstrument,
    reference: Amount,
    spread_price: Amount,
) -> Result<[Amount; 2], Reject> {
    let [anchor, residual] = &instrument.legs;
    let anchor_term = mul_exact(anchor.ratio, reference).ok_or_else(|| {
        unfillable(format!(
            "anchor leg {} cannot be priced exactly",
            anchor.symbol
        ))
    })?;
    let residual_inexact = || {
        unfillable(format!(
            "residual leg {} cannot be priced exactly",
            residual.symbol
        ))
    };
    let numerator = spread_price
        .checked_sub(sign(anchor.side) * anchor_term)
        .ok_or_else(residual_inexact)?;
    let residual_price =
        div_exact(numerator, sign(residual.side) * residual.ratio).ok_or_else(residual_inexact)?;
    if residual_price <= Amount::ZERO {
        return Err(unfillable(format!(
            "residual leg {} would print at {} for spread {}; the whole spread refuses",
            residual.symbol,
            format_amount(residual_price),
            format_amount(spread_price)
        )));
    }
    let sums = mul_exact(residual.ratio, residual_price).and_then(|residual_term| {
        (sign(anchor.side) * anchor_term).checked_add(sign(residual.side) * residual_term)
    });
    if sums != Some(spread_price) {
        return Err(unfillable(
            "leg prices do not sum to the spread price exactly",
        ));
    }
    Ok([reference, residual_price])
}

/// Every leg of one spread fill, or the refusal: quantities are `qty x ratio`, prices follow the leg-price rule, and
/// each leg carries the taker's side on that leg.
pub fn spread_leg_fills(
    instrument: &SpreadInstrument,
    reference: Amount,
    spread_price: Amount,
    qty: Amount,
    taker_side: Side,
) -> Result<Vec<SpreadLegFill>, Reject> {
    let prices = spread_leg_prices(instrument, reference, spread_price)?;
    let mut legs = Vec::new();
    for (leg, price) in instrument.legs.iter().zip(prices) {
        let leg_qty = mul_exact(qty, leg.ratio)
            .filter(|q| *q > Amount::ZERO)
            .ok_or_else(|| {
                unfillable(format!(
                    "leg {} qty is not exact at 18 decimals",
                    leg.symbol
                ))
            })?;
        legs.push(SpreadLegFill {
            symbol: leg.symbol.clone(),
            taker_side: if taker_side == Side::Buy {
                leg.side
            } else {
                leg.side.opposite()
            },
            qty: leg_qty,
            price,
        });
    }
    Ok(legs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }

    #[test]
    fn exact_products_and_quotients_refuse_what_would_round() {
        assert_eq!(mul_exact(a("100"), a("100")), Some(a("10000")));
        assert_eq!(
            mul_exact(a("0.000000001"), a("0.000000001")),
            Some(a("0.000000000000000001"))
        );
        assert_eq!(mul_exact(a("0.000000001"), a("0.0000000001")), None);
        assert_eq!(div_exact(a("1"), a("3")), None);
        assert_eq!(div_exact(a("-5"), a("2")), Some(a("-2.5")));
        assert_eq!(div_exact(a("1"), Amount::ZERO), None);
    }
}
