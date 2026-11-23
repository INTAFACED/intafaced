//! The programme read and its funding (`ops/card-programme.ts`, `cards/programme-funding.ts` and the funding half of
//! `CardService`): the card counts and daily volume, the settlement reconciliation against the card partner's own
//! figures with the stablecoin conversion, and one funding instruction to the partner. The money is the partner's:
//! nothing here posts to the ledger, and an unreported figure is "not known", never 0.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{Amount, Rounding, format_amount, js_trim, mul_rounded, parse_amount};
use service_kit::schema::Value;
use service_kit::time::{Instant, js_date};
use std::collections::{BTreeMap, BTreeSet};

use super::{Deps, js_len};
use crate::cards::reads::acceptable_for_marking;
use crate::cards::terms::{PartnerTerms, is_decimal};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{pg, with};

const DAY_MS: i64 = 86_400_000;
const MAX_SPAN_DAYS: i64 = 92;
/// `NOT_KNOWN`: an unknown on the wire, so no surface can print a dash, a blank or a 0 in its place.
const NOT_KNOWN: &str = "not known";
/// `MISSING`: the app's side of a figure when the app holds no record for the asset.
const MISSING: &str = "missing";

/// `assertProgrammeSpan`: a from and a to, the to after the from, at most 92 days apart.
pub fn assert_span(from: Option<&str>, to: Option<&str>) -> Result<(Instant, Instant), Refusal> {
    let (start, end) = (from.and_then(js_date), to.and_then(js_date));
    let (Some(start), Some(end)) = (start, end) else {
        return Err(span_unset());
    };
    if end.0 <= start.0 {
        return Err(span_unset());
    }
    if end.0 - start.0 > MAX_SPAN_DAYS * DAY_MS {
        return Err(refuse(
            "bank.card_programme_span_too_long",
            "Card programme span is longer than 92 days (bank.card_programme_span_too_long)",
        ));
    }
    Ok((start, end))
}

fn span_unset() -> Refusal {
    refuse(
        "bank.card_programme_span_unset",
        "Card programme needs a from and a to, and to must be after from (bank.card_programme_span_unset)",
    )
}

fn amount(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

/// `readCardProgramme`: the counts, and per UTC day of the span each asset's approved volume and the declines.
pub fn read(d: &Deps<'_>, from: Instant, to: Instant) -> Result<Json, Refusal> {
    let (counts, rows) = with(d.store(), |c| {
        let counts: (i64, i64, i64) = c
            .query(
                "SELECT count(*)::int8, (count(*) FILTER (WHERE status = 'active'))::int8, \
                        (count(*) FILTER (WHERE status = 'frozen'))::int8 FROM bank.cards",
                &[],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map_or((0, 0, 0), |r| (r.get(0), r.get(1), r.get(2)));
        let rows = c
            .query(
                "SELECT to_char(a.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), c.asset_id, a.decision::text, \
                        COALESCE(SUM(a.amount), 0)::text, count(*)::int8 \
                   FROM bank.card_authorizations a JOIN bank.cards c ON c.id = a.card_id \
                  WHERE a.decided_at >= to_timestamp($1::int8 / 1000.0) AND a.decided_at < to_timestamp($2::int8 / 1000.0) \
                  GROUP BY 1, 2, 3",
                &[&from.0, &to.0],
            )
            .map_err(|e| pg(&e))?;
        Ok((counts, rows))
    })?;
    let mut days: Vec<(String, BTreeMap<String, Amount>, i64)> = Vec::new();
    let mut cursor = from.0 - from.0.rem_euclid(DAY_MS);
    while cursor < to.0 {
        let day = Instant(cursor)
            .iso()
            .get(..10)
            .unwrap_or_default()
            .to_owned();
        days.push((day, BTreeMap::new(), 0));
        cursor += DAY_MS;
    }
    for r in &rows {
        let day: String = r.get(0);
        let Some(bucket) = days.iter_mut().find(|(d, _, _)| *d == day) else {
            continue;
        };
        let decision: String = r.get(2);
        if decision == "approved" {
            *bucket.1.entry(r.get(1)).or_insert(Amount::ZERO) += amount(&r.get::<_, String>(3))?;
        } else if decision == "declined" {
            bucket.2 += r.get::<_, i64>(4);
        }
    }
    Ok(Json::obj([
        ("simulated", Json::Bool(d.test())),
        ("issued", Json::int(counts.0)),
        ("active", Json::int(counts.1)),
        ("frozen", Json::int(counts.2)),
        (
            "days",
            Json::Array(
                days.into_iter()
                    .map(|(day, volume, declines)| {
                        Json::obj([
                            ("day", Json::str(day)),
                            (
                                "volume",
                                Json::Array(
                                    volume
                                        .into_iter()
                                        .map(|(asset, a)| {
                                            Json::obj([
                                                ("assetId", Json::str(asset)),
                                                ("amount", Json::str(format_amount(a))),
                                            ])
                                        })
                                        .collect(),
                                ),
                            ),
                            ("declines", Json::int(declines)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]))
}

/// `fundingOfferStates`: fund, defund and auto reload, each offered, not offered, or not known when the partner is silent.
pub fn offer_states(terms: &PartnerTerms) -> [(&'static str, &'static str); 3] {
    let state = |offered: Option<bool>| match offered {
        None => "not_known",
        Some(true) => "offered",
        Some(false) => "not_offered",
    };
    let o = terms.funding_offers;
    [
        ("fund", state(o.map(|o| o.fund))),
        ("defund", state(o.map(|o| o.defund))),
        ("auto_reload", state(o.map(|o| o.auto_reload))),
    ]
}

/// `assertFundingOffered`: the partner offers that kind and has said which stablecoin the programme funds in.
pub fn assert_offered(terms: &PartnerTerms, kind: &str) -> Result<String, Refusal> {
    let state = offer_states(terms)
        .iter()
        .find(|(k, _)| *k == kind)
        .map_or("not_known", |(_, s)| *s);
    let words = kind.replacen('_', " ", 1);
    if state != "offered" {
        return Err(refuse(
            "bank.card_funding_not_offered",
            if state == "not_known" {
                format!(
                    "The card partner has not said whether it offers {words} (bank.card_funding_not_offered)"
                )
            } else {
                format!(
                    "The card partner does not offer {words} for this programme (bank.card_funding_not_offered)"
                )
            },
        ));
    }
    terms.funding_asset_id.clone().ok_or_else(|| {
        refuse(
            "bank.card_funding_not_offered",
            "The card partner has not said which stablecoin the programme is funded in (bank.card_funding_not_offered)",
        )
    })
}

/// `appProgrammeFigures`: per funding asset, the open holds (what each posted hold still holds after every settled
/// capture and reversal) and the settled captures.
fn app_figures(c: &mut impl GenericClient) -> Result<BTreeMap<String, (Amount, Amount)>, Refusal> {
    let rows = c
        .query(
            "SELECT k.asset_id, \
                    COALESCE(SUM(GREATEST(a.amount - COALESCE(( \
                      SELECT SUM(s.amount) FROM bank.card_settlements s WHERE s.authorization_id = a.id AND s.status = 'settled' \
                    ), 0), 0)) FILTER (WHERE a.decision = 'approved' AND a.status = 'settled'), 0)::text, \
                    COALESCE(( \
                      SELECT SUM(s.amount) FROM bank.card_settlements s \
                        JOIN bank.card_authorizations a2 ON a2.id = s.authorization_id \
                        JOIN bank.cards k2 ON k2.id = a2.card_id \
                       WHERE k2.asset_id = k.asset_id AND s.kind = 'capture' AND s.status = 'settled' \
                    ), 0)::text \
               FROM bank.card_authorizations a JOIN bank.cards k ON k.id = a.card_id \
              GROUP BY k.asset_id",
            &[],
        )
        .map_err(|e| pg(&e))?;
    let mut out = BTreeMap::new();
    for r in &rows {
        out.insert(
            r.get::<_, String>(0),
            (
                amount(&r.get::<_, String>(1))?,
                amount(&r.get::<_, String>(2))?,
            ),
        );
    }
    Ok(out)
}

/// `displayMarks`: one unit of each asset in the funding asset; the asset in itself is 1, any other from the rate source
/// when it passes the card conversion policy's freshness and positive-price check, else left out ("not known").
fn display_marks(
    d: &Deps<'_>,
    assets: &[String],
    quote: &str,
    now: Instant,
) -> BTreeMap<String, (Amount, Instant)> {
    let mut out = BTreeMap::new();
    if assets.iter().any(|a| a == quote) {
        out.insert(quote.to_owned(), (Amount::ONE, now));
    }
    let others: Vec<String> = assets.iter().filter(|a| *a != quote).cloned().collect();
    if others.is_empty() {
        return out;
    }
    for (asset, m) in d.w.rates.marks(&others, quote) {
        if others.contains(&asset) && acceptable_for_marking(m.mark.price, m.mark.as_of, now) {
            out.insert(asset, (m.mark.price, m.mark.as_of));
        }
    }
    out
}

/// `heldFigure`'s state for the partner's figure: `known`, `stale` or `unknown`.
fn figure_state(
    sum: Option<Amount>,
    as_of: Option<Instant>,
    stale_after_ms: i64,
    now: Instant,
) -> Result<&'static str, Refusal> {
    if stale_after_ms <= 0 {
        return Err(Refusal::Other(format!(
            "the card partner declares no staleness limit (staleAfterMs {stale_after_ms})"
        )));
    }
    let Some(sum) = sum else {
        return Ok("unknown");
    };
    if !is_decimal(&format_amount(sum)) {
        return Ok("unknown");
    }
    let Some(as_of) = as_of else {
        return Ok("unknown");
    };
    let age = now.0 - as_of.0;
    Ok(if age < -stale_after_ms {
        "unknown"
    } else if age > stale_after_ms {
        "stale"
    } else {
        "known"
    })
}

const FUNDING_COLS: &str = "client_request_id, kind, asset_id, amount::text, threshold::text, partner_ref, \
     floor(extract(epoch from approved_at) * 1000)::int8, floor(extract(epoch from created_at) * 1000)::int8";

/// `FundingRow`.
struct FundingRow {
    client_request_id: String,
    kind: String,
    asset_id: String,
    amount: Amount,
    threshold: Option<Amount>,
    partner_ref: Option<String>,
    approved: bool,
    created_at: i64,
}

impl FundingRow {
    fn from_row(r: &postgres::Row) -> Result<FundingRow, Refusal> {
        Ok(FundingRow {
            client_request_id: r.get(0),
            kind: r.get(1),
            asset_id: r.get(2),
            amount: amount(&r.get::<_, String>(3))?,
            threshold: r
                .get::<_, Option<String>>(4)
                .as_deref()
                .map(amount)
                .transpose()?,
            partner_ref: r.get(5),
            approved: r.get::<_, Option<i64>>(6).is_some(),
            created_at: r.get(7),
        })
    }

    /// `toFundingRequest`: an answered instruction.
    fn json(&self) -> Json {
        Json::obj([
            ("clientRequestId", Json::str(self.client_request_id.clone())),
            ("kind", Json::str(self.kind.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("amount", Json::str(format_amount(self.amount))),
            (
                "threshold",
                self.threshold
                    .map_or(Json::Null, |t| Json::str(format_amount(t))),
            ),
            (
                "partnerRef",
                Json::str(self.partner_ref.clone().unwrap_or_default()),
            ),
            ("createdAt", Json::str(Instant(self.created_at).iso())),
        ])
    }

    /// `assertSameFunding`: the same client request id is the same instruction.
    fn assert_same(
        &self,
        kind: &str,
        amount: Amount,
        threshold: Option<Amount>,
    ) -> Result<(), Refusal> {
        if self.kind == kind && self.amount == amount && self.threshold == threshold {
            return Ok(());
        }
        Err(refuse(
            "bank.card_funding_invalid",
            "This request id was already used for a different programme funding instruction (bank.card_funding_invalid)",
        ))
    }
}

fn funding_row(c: &mut impl GenericClient, id: &str) -> Result<Option<FundingRow>, Refusal> {
    c.query(
        &format!("SELECT {FUNDING_COLS} FROM bank.card_programme_funding_requests WHERE client_request_id = $1"),
        &[&id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(FundingRow::from_row)
    .transpose()
}

/// `programmeFunding` as `ops.cardProgrammeFunding` answers it: per funding asset the app's figures beside the
/// partner's, the conversion into the funding asset, the offers and the instructions already answered.
pub fn view(d: &Deps<'_>) -> Result<Json, Refusal> {
    let terms = d.cards.issuer().partner_terms()?;
    let now = d.cards.now();
    let (app, requests) = with(d.store(), |c| {
        let app = app_figures(c)?;
        let rows = c
            .query(
                &format!(
                    "SELECT {FUNDING_COLS} FROM bank.card_programme_funding_requests WHERE partner_ref IS NOT NULL \
                     ORDER BY created_at DESC, client_request_id LIMIT 20"
                ),
                &[],
            )
            .map_err(|e| pg(&e))?;
        let requests = rows
            .iter()
            .map(FundingRow::from_row)
            .collect::<Result<Vec<_>, _>>()?;
        Ok((app, requests))
    })?;
    let partner: Vec<(String, (String, String))> =
        terms.programme_figures.clone().unwrap_or_default();
    let assets: Vec<String> = app
        .keys()
        .cloned()
        .chain(partner.iter().map(|(a, _)| a.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let marks = match &terms.funding_asset_id {
        Some(f) => display_marks(d, &assets, f, now),
        None => BTreeMap::new(),
    };
    let as_of = terms.figures_as_of_at(now);
    let mut rows = Vec::with_capacity(assets.len());
    for asset in &assets {
        let mine = app.get(asset);
        let app_figure = mine.map(|(h, c)| *h + *c);
        let sum = match partner.iter().find(|(a, _)| a == asset) {
            Some((_, (h, c))) => Some(amount(h)? + amount(c)?),
            None => None,
        };
        let state = figure_state(sum, as_of, terms.figures_stale_after_ms, now)?;
        let partner_figure = if state == "unknown" { None } else { sum };
        let difference = match (partner_figure, app_figure) {
            (Some(p), Some(a)) => Some(p - a),
            _ => None,
        };
        let mark = marks.get(asset);
        let app_side =
            |v: Option<Amount>| Json::str(v.map_or_else(|| MISSING.to_owned(), format_amount));
        let known = |v: Option<String>| Json::str(v.unwrap_or_else(|| NOT_KNOWN.to_owned()));
        let status = match (partner_figure, difference) {
            (None, _) => "not_known",
            (Some(_), None) => "missing",
            (Some(_), Some(Amount::ZERO)) => "matches",
            _ => "break",
        };
        rows.push(Json::obj([
            ("assetId", Json::str(asset.clone())),
            ("appHeld", app_side(mine.map(|m| m.0))),
            ("appCaptured", app_side(mine.map(|m| m.1))),
            ("appFigure", app_side(app_figure)),
            ("partnerFigure", known(partner_figure.map(format_amount))),
            ("partnerAsOf", known(as_of.map(|t| t.iso()))),
            ("partnerState", Json::str(state)),
            ("difference", known(difference.map(format_amount))),
            ("status", Json::str(status)),
            ("fundingRate", known(mark.map(|m| format_amount(m.0)))),
            ("fundingRateAsOf", known(mark.map(|m| m.1.iso()))),
            (
                "appFigureInFunding",
                known(match (mark, app_figure) {
                    (Some(m), Some(a)) => Some(format_amount(mul_rounded(a, m.0, Rounding::Ceil))),
                    _ => None,
                }),
            ),
        ]));
    }
    Ok(Json::obj([
        ("test", Json::Bool(terms.test)),
        (
            "fundingAssetId",
            Json::str(
                terms
                    .funding_asset_id
                    .clone()
                    .unwrap_or_else(|| NOT_KNOWN.to_owned()),
            ),
        ),
        (
            "offers",
            Json::Object(
                offer_states(&terms)
                    .iter()
                    .map(|(k, s)| ((*k).to_owned(), Json::str(*s)))
                    .collect(),
            ),
        ),
        ("rows", Json::Array(rows)),
        (
            "requests",
            Json::Array(requests.iter().map(FundingRow::json).collect()),
        ),
    ]))
}

/// `positiveOrRefuse`.
fn positive(raw: &str, what: &str) -> Result<Amount, Refusal> {
    match parse_amount(raw) {
        Ok(a) if is_decimal(raw) && a > Amount::ZERO => Ok(a),
        _ => Err(refuse(
            "bank.card_funding_invalid",
            format!("A programme funding {what} is a positive decimal (bank.card_funding_invalid)"),
        )),
    }
}

/// `requestProgrammeFunding`: one instruction to the card partner, after a second founder approved it. Refuses before
/// the approval is used when the partner does not offer the kind or the amount is not positive. The same client request
/// id replays the first answer. The row is written before the approval is used and marked approved after it, and the
/// partner is told under the same key, so a crash repeats one instruction, never two, with one approval. Nothing posts.
pub fn request(d: &Deps<'_>, input: &Value) -> Result<Json, Refusal> {
    let text = |k: &str| input.get(k).as_str().unwrap_or_default().to_owned();
    let kind = text("kind");
    let raw_amount = text("amount");
    let raw_threshold: Option<String> = input.get("threshold").as_str().map(str::to_owned);
    let client_request_id = text("clientRequestId");
    let reason = js_trim(&text("reason")).to_owned();
    if js_len(&reason) < 10 {
        return Err(refuse(
            "bank.ops_reason_too_short",
            "A programme funding request needs a reason of at least 10 characters (bank.ops_reason_too_short)",
        ));
    }
    let amount_v = positive(&raw_amount, "amount")?;
    let threshold = if kind == "auto_reload" {
        Some(positive(
            raw_threshold.as_deref().unwrap_or_default(),
            "threshold",
        )?)
    } else {
        None
    };
    if kind != "auto_reload" && raw_threshold.is_some() {
        return Err(refuse(
            "bank.card_funding_invalid",
            "Only auto reload takes a threshold (bank.card_funding_invalid)",
        ));
    }
    let mut row = with(d.store(), |c| funding_row(c, &client_request_id))?;
    if let Some(r) = &row {
        r.assert_same(&kind, amount_v, threshold)?;
        if r.partner_ref.is_some() {
            return Ok(r.json());
        }
    }
    let asset_id = assert_offered(&d.cards.issuer().partner_terms()?, &kind)?;
    let amount_text = format_amount(amount_v);
    let threshold_text = threshold.map(format_amount);
    let row = match row.take() {
        Some(r) => r,
        None => {
            let stored = with(d.store(), |c| {
                c.execute(
                    "INSERT INTO bank.card_programme_funding_requests (client_request_id, kind, asset_id, amount, threshold, reason) \
                     VALUES ($1, $2, $3, $4::text::numeric, $5::text::numeric, $6) ON CONFLICT (client_request_id) DO NOTHING",
                    &[&client_request_id, &kind, &asset_id, &amount_text, &threshold_text, &reason],
                )
                .map_err(|e| pg(&e))?;
                funding_row(c, &client_request_id)
            })?
            .ok_or_else(|| Refusal::Other("the funding request was not stored".to_owned()))?;
            stored.assert_same(&kind, amount_v, threshold)?;
            stored
        }
    };
    if !row.approved {
        let fields = [
            ("kind".to_owned(), kind.clone()),
            ("amount".to_owned(), raw_amount.clone()),
            (
                "threshold".to_owned(),
                raw_threshold.clone().unwrap_or_default(),
            ),
        ];
        crate::ops_approval::consume(
            d.cards.t.w.approvals.as_ref(),
            input,
            "bank.ops.requestCardProgrammeFunding",
            &fields,
        )?;
        with(d.store(), |c| {
            c.execute(
                "UPDATE bank.card_programme_funding_requests SET approved_at = now() \
                  WHERE client_request_id = $1 AND approved_at IS NULL",
                &[&client_request_id],
            )
            .map_err(|e| pg(&e))?;
            Ok(())
        })?;
    }
    let partner_ref = d.cards.issuer().programme_funding(
        &format!("card-funding:{client_request_id}"),
        &kind,
        &row.asset_id,
        &amount_text,
        threshold_text.as_deref(),
    )?;
    with(d.store(), |c| {
        c.execute(
            "UPDATE bank.card_programme_funding_requests SET partner_ref = $2 \
              WHERE client_request_id = $1 AND partner_ref IS NULL",
            &[&client_request_id, &partner_ref],
        )
        .map_err(|e| pg(&e))?;
        funding_row(c, &client_request_id)
    })?
    .map(|r| r.json())
    .ok_or_else(|| Refusal::Other("the funding request is gone".to_owned()))
}
