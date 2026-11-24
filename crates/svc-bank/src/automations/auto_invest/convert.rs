//! The convert counterparty a DCA buy needs (`ConvertPort`), and svc-trade's (`auto-invest/trade-convert-port.ts`):
//! `standing.quote` and `standing.execute`, body-bound service calls signed as svc-bank with the person and the
//! instruction in the body, never a principal. The pair comes from the public markets listing (not a price); the size
//! and the fill come from svc-trade. svc-bank never invents a mid: anything trade cannot quote refuses
//! `bank.auto_invest_rate_unset`. Once the execute is sent, only a typed trade refusal is definite; a timeout, a 5xx,
//! an untyped refusal or an answer that cannot be read is an unknown outcome, so the run stays pending.

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, Rounding, format_amount, mul_div, parse_amount};
use service_kit::s2s::CallSigner;
use sha2::{Digest, Sha256};

use crate::errors::Refusal;
use crate::partner::refuse;

/// What one DCA firing asks the counterparty for.
pub struct ConvertAsk<'a> {
    pub user_id: &'a str,
    /// The standing instruction (the rule) this spend runs under.
    pub instruction_id: &'a str,
    pub from_asset: &'a str,
    pub to_asset: &'a str,
    pub from_amount: Amount,
    pub client_convert_id: &'a str,
}

/// What settled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Converted {
    pub to_amount: Amount,
    pub ledger_tx_id: String,
}

/// Why a convert did not answer with a fill.
#[derive(Debug)]
pub enum ConvertError {
    /// A `BankError`: nothing was converted.
    Refused(Refusal),
    /// The ledger's own typed refusal (`LedgerError`), definite only for the codes it decides before committing.
    Ledger(String),
    /// `ConvertOutcomeUnknown`, or any other failure: the convert may have filled.
    Unknown(String),
}

/// `ConvertPort`: must refuse when it has no rate, never invent one.
pub trait ConvertPort: Send + Sync {
    fn convert(&self, ask: &ConvertAsk<'_>) -> Result<Converted, ConvertError>;
}

const SCALE: Amount = Amount::whole(1);
/// `CONVERT_MARKETS_LIMIT_MAX`.
pub const MARKETS_LIMIT_MAX: i64 = 500;

fn rate_unset(detail: &str) -> ConvertError {
    ConvertError::Refused(refuse(
        "bank.auto_invest_rate_unset",
        format!("Auto-invest DCA convert refused — trade did not supply a rate ({detail})"),
    ))
}

fn unknown(detail: &str) -> ConvertError {
    ConvertError::Unknown(format!(
        "Auto-invest DCA convert outcome unknown ({detail})"
    ))
}

/// `assertConvertMarketsListLimit`: the owner's page size, 1..500; blank refuses, never 50.
pub fn markets_limit(limit: Option<i64>) -> Result<i64, Refusal> {
    match limit {
        Some(l) if (1..=MARKETS_LIMIT_MAX).contains(&l) => Ok(l),
        _ => Err(refuse(
            "bank.convert_markets_limit_unset",
            "convert markets listing page size is unset. Blank refuses — never 50. Pass a positive integer 1..500 (50 is allowed if explicit).",
        )),
    }
}

/// `convertClientId`: the id itself when 1..48 long, else the first 48 of its SHA-256.
fn client_id(raw: &str) -> String {
    let n = raw.encode_utf16().count();
    if (1..=48).contains(&n) {
        return raw.to_owned();
    }
    Sha256::digest(raw.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()[..48]
        .to_owned()
}

/// JavaScript truthiness of a field.
fn truthy(v: Option<&Json>) -> bool {
    match v {
        None | Some(Json::Null | Json::Bool(false)) => false,
        Some(Json::String(s)) => !s.is_empty(),
        Some(Json::Number(n)) => *n != 0.0 && !n.is_nan(),
        Some(_) => true,
    }
}

fn text(v: Option<&Json>) -> Option<&str> {
    match v {
        Some(Json::String(s)) => Some(s),
        _ => None,
    }
}

/// `parseWireAmount`: a decimal string; missing, blank or unreadable refuses.
fn wire_amount(raw: Option<&Json>, detail: &str) -> Result<Amount, ConvertError> {
    let Some(s) = text(raw).filter(|s| !service_kit::money::js_trim(s).is_empty()) else {
        return Err(rate_unset(detail));
    };
    parse_amount(s).map_err(|_| rate_unset(detail))
}

/// The intafaced code a refusal body names: `error.data.intafacedCode`, else `intafacedCode`.
fn code_of(body: &Json) -> Option<String> {
    let nested = body
        .get("error")
        .and_then(|e| e.get("data"))
        .and_then(|d| d.get("intafacedCode"));
    text(nested)
        .or_else(|| text(body.get("intafacedCode")))
        .map(str::to_owned)
}

fn message_of(body: &Json) -> Option<String> {
    text(body.get("error").and_then(|e| e.get("message"))).map(str::to_owned)
}

/// `unwrapTrpc`.
fn unwrap_trpc(body: Json) -> Result<Json, ConvertError> {
    if let Json::Object(_) = &body {
        if truthy(body.get("error")) {
            let code = code_of(&body)
                .or_else(|| message_of(&body))
                .unwrap_or_else(|| "trade.convert_refused".to_owned());
            return Err(rate_unset(&code));
        }
        if let Some(result) = body.get("result") {
            if let Json::Object(_) = result
                && let Some(data) = result.get("data")
            {
                return Ok(data.clone());
            }
            return Ok(result.clone());
        }
    }
    Ok(body)
}

/// One listed spot market.
struct Market {
    symbol: String,
    base: String,
    quote: String,
    min_qty: Amount,
}

/// The fields of a quote the port reads.
struct Quote {
    quote_id: String,
    avg_price: String,
    user_notional: Option<Json>,
}

/// `tradeConvertPort`: svc-trade at `TRADE_URL`, 5 s a call.
pub struct TradeConvert {
    base: String,
    signer: CallSigner,
    fetch: Box<dyn Fetch>,
    /// `CONVERT_MARKETS_LIMIT`; blank refuses at the first convert.
    markets_limit: Option<i64>,
}

impl TradeConvert {
    pub fn new(
        base: &str,
        signer: CallSigner,
        fetch: Box<dyn Fetch>,
        markets_limit: Option<i64>,
    ) -> TradeConvert {
        TradeConvert {
            base: base.trim_end_matches('/').to_owned(),
            signer,
            fetch,
            markets_limit,
        }
    }

    /// `call`: a GET with a query, or a signed POST. `settles`: the call can settle money, so past the send only a
    /// typed trade refusal is definite.
    fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Json>,
        query: Option<&str>,
        settles: bool,
    ) -> Result<Json, ConvertError> {
        let target = query.map_or_else(|| path.to_owned(), |q| format!("{path}?{q}"));
        let payload = body.map(Json::compact);
        let mut headers = vec![("accept".to_owned(), "application/json".to_owned())];
        if let Some(p) = &payload {
            headers.push(("content-type".to_owned(), "application/json".to_owned()));
            let signed = self
                .signer
                .sign(p, method, &target, "application/json")
                .map_err(|e| if settles { unknown(&e) } else { rate_unset(&e) })?;
            headers.extend(signed);
        }
        let sent = self.fetch.fetch(&HttpRequest {
            method: method.to_owned(),
            url: format!("{}{target}", self.base),
            headers,
            body: payload,
            timeout_ms: Some(5_000),
            refuse_redirect: false,
        });
        let res = match sent {
            Ok(r) => r,
            Err(e) if settles => return Err(unknown(&e.message)),
            Err(e) => return Err(rate_unset(&e.message)),
        };
        let (parsed, unreadable) = if res.body.is_empty() {
            (Json::Null, false)
        } else {
            match json::parse(&res.body) {
                Ok(j) => (j, false),
                Err(_) => {
                    let m = if res.body.is_empty() {
                        format!("http {}", res.status)
                    } else {
                        res.body.clone()
                    };
                    (
                        Json::obj([("error", Json::obj([("message", Json::str(m))]))]),
                        true,
                    )
                }
            }
        };
        let has_error = matches!(&parsed, Json::Object(f) if f.iter().any(|(k, _)| k == "error"));
        if settles && res.ok() && (unreadable || has_error) {
            return Err(unknown(
                "convert execute answered 2xx with an unreadable or error body",
            ));
        }
        if !res.ok() {
            let code = code_of(&parsed);
            if settles && (code.is_none() || res.status >= 500) {
                return Err(unknown(&format!(
                    "convert execute answered http {} without a typed refusal",
                    res.status
                )));
            }
            let detail = code
                .or_else(|| message_of(&parsed))
                .unwrap_or_else(|| format!("http {}", res.status));
            return Err(rate_unset(&detail));
        }
        unwrap_trpc(parsed)
    }

    /// `listedSpot`: the listed spot market for the pair, spot and active both true, with its published minimum.
    fn listed_spot(&self, from: &str, to: &str) -> Result<Market, ConvertError> {
        let page = markets_limit(self.markets_limit).map_err(ConvertError::Refused)?;
        let markets = self.call(
            "GET",
            "/api/v1/markets",
            None,
            Some(&format!("limit={page}")),
            false,
        )?;
        let Json::Array(list) = markets else {
            return Err(rate_unset("markets listing unreadable"));
        };
        let found = list.iter().find(|m| {
            let is_true = |k: &str| matches!(m.get(k), Some(Json::Bool(true)));
            let (base, quote) = (text(m.get("base")), text(m.get("quote")));
            let pair = (base == Some(from) && quote == Some(to))
                || (base == Some(to) && quote == Some(from));
            is_true("spot") && is_true("active") && pair && text(m.get("symbol")).is_some()
        });
        let Some(m) = found else {
            return Err(rate_unset(&format!(
                "no listed spot market for {from}/{to}"
            )));
        };
        let min = m
            .get("limits")
            .and_then(|l| l.get("amount"))
            .and_then(|a| a.get("min"));
        let min_qty = wire_amount(min, "limits.amount.min")?;
        if min_qty <= Amount::ZERO {
            return Err(rate_unset("limits.amount.min is not positive"));
        }
        Ok(Market {
            symbol: text(m.get("symbol")).unwrap_or_default().to_owned(),
            base: text(m.get("base")).unwrap_or_default().to_owned(),
            quote: text(m.get("quote")).unwrap_or_default().to_owned(),
            min_qty,
        })
    }

    fn quote(
        &self,
        ask: &ConvertAsk<'_>,
        symbol: &str,
        side: &str,
        qty: Amount,
    ) -> Result<Quote, ConvertError> {
        let q = self.call(
            "POST",
            "/trpc/standing.quote",
            Some(&Json::obj([
                ("userId", Json::str(ask.user_id)),
                ("instructionId", Json::str(ask.instruction_id)),
                ("symbol", Json::str(symbol)),
                ("side", Json::str(side)),
                ("qty", Json::str(format_amount(qty))),
            ])),
            None,
            false,
        )?;
        let field = |k: &str| text(q.get(k)).map(str::to_owned);
        let (Some(quote_id), Some(avg_price), Some(_), Some(_)) = (
            field("quoteId"),
            field("avgPrice"),
            field("userNotional"),
            field("filledQty"),
        ) else {
            return Err(rate_unset("convert quote missing amounts"));
        };
        if !matches!(q.get("fullyFilled"), Some(Json::Bool(true))) {
            return Err(rate_unset("trade.convert_insufficient_depth"));
        }
        // `parseAmount` throws a plain error on an unreadable price: no refusal, so the run is left for a person.
        let avg = parse_amount(&avg_price).map_err(ConvertError::Unknown)?;
        if avg <= Amount::ZERO {
            return Err(rate_unset("convert quote avgPrice is not a positive rate"));
        }
        Ok(Quote {
            quote_id,
            avg_price,
            user_notional: q.get("userNotional").cloned(),
        })
    }

    /// `execute`: what settled; past the send nothing reads as a refusal but trade's own typed one.
    #[allow(
        clippy::too_many_arguments,
        reason = "the execute's fields, each named"
    )]
    fn execute(
        &self,
        ask: &ConvertAsk<'_>,
        quoted: &Quote,
        symbol: &str,
        side: &str,
        qty: Amount,
        max_spend: Amount,
    ) -> Result<Converted, ConvertError> {
        let max_avg = parse_amount(&quoted.avg_price).map_err(ConvertError::Unknown)?;
        let settled = self.call(
            "POST",
            "/trpc/standing.execute",
            Some(&Json::obj([
                ("userId", Json::str(ask.user_id)),
                ("instructionId", Json::str(ask.instruction_id)),
                ("quoteId", Json::str(quoted.quote_id.clone())),
                (
                    "clientConvertId",
                    Json::str(client_id(ask.client_convert_id)),
                ),
                ("symbol", Json::str(symbol)),
                ("side", Json::str(side)),
                ("qty", Json::str(format_amount(qty))),
                ("maxAvgPrice", Json::str(format_amount(max_avg))),
            ])),
            None,
            true,
        )?;
        let fill = text(settled.get("fillId")).filter(|f| !f.is_empty());
        let Some(fill) = fill else {
            return Err(unknown("missing fill"));
        };
        let read = |k: &str| text(settled.get(k)).and_then(|s| parse_amount(s).ok());
        let (Some(spent), Some(received)) = (read("inAmount"), read("outAmount")) else {
            return Err(unknown("unreadable settled amounts"));
        };
        if spent > max_spend {
            return Err(unknown(
                "settled spend above the authorized amount, reconcile",
            ));
        }
        if received <= Amount::ZERO {
            return Err(unknown("settled with nothing received, reconcile"));
        }
        Ok(Converted {
            to_amount: received,
            ledger_tx_id: fill.to_owned(),
        })
    }
}

impl ConvertPort for TradeConvert {
    fn convert(&self, ask: &ConvertAsk<'_>) -> Result<Converted, ConvertError> {
        let market = self.listed_spot(ask.from_asset, ask.to_asset)?;
        let selling_base = ask.from_asset == market.base && ask.to_asset == market.quote;
        let buying_base = ask.from_asset == market.quote && ask.to_asset == market.base;
        if !selling_base && !buying_base {
            return Err(rate_unset("assets do not match listed market"));
        }
        if selling_base {
            let q = self.quote(ask, &market.symbol, "sell", ask.from_amount)?;
            return self.execute(
                ask,
                &q,
                &market.symbol,
                "sell",
                ask.from_amount,
                ask.from_amount,
            );
        }
        // Spend the quote asset, receive the base: size the base from trade's own average at the published minimum.
        let probe = self.quote(ask, &market.symbol, "buy", market.min_qty)?;
        let avg = parse_amount(&probe.avg_price).map_err(ConvertError::Unknown)?;
        let raw = mul_div(ask.from_amount, SCALE, avg, Rounding::Floor);
        let sized = raw - raw % market.min_qty;
        if sized <= Amount::ZERO {
            return Err(rate_unset(
                "spend amount below convert min qty at trade rate",
            ));
        }
        let live = self.quote(ask, &market.symbol, "buy", sized)?;
        let notional = wire_amount(live.user_notional.as_ref(), "buy convert userNotional")?;
        if notional <= Amount::ZERO {
            return Err(rate_unset("buy convert notional is not positive"));
        }
        if notional > ask.from_amount {
            return Err(rate_unset(
                "buy convert notional exceeds authorized fromAmount",
            ));
        }
        self.execute(ask, &live, &market.symbol, "buy", sized, ask.from_amount)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assert_convert_markets_list_limit_refuses_blank_0_and_501_never_invents_50() {
        for l in [None, Some(0), Some(501)] {
            assert!(markets_limit(l).is_err(), "{l:?}");
        }
        assert_eq!(markets_limit(Some(50)).ok(), Some(50));
        assert_eq!(markets_limit(Some(500)).ok(), Some(500));
    }

    #[test]
    fn a_long_client_id_is_hashed_to_48() {
        assert_eq!(client_id("dca-1"), "dca-1");
        let long = "x".repeat(60);
        assert_eq!(client_id(&long).len(), 48);
    }
}
