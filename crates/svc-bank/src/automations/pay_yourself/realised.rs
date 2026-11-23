//! svc-trade's read of one person's realised trading result (`pay-yourself/realised-source.ts`, J-bank-31 #2 #7):
//! `GET <TRADE_URL>/internal/venue/realised?userId=&asset=&since=&until=`, signed as svc-bank. svc-trade adds up the
//! realised result the venue reports on the closing fills of the person's main venue accounts; nothing is kept there.
//! Every failure (transport, a non-2xx, a body not in the published shape) is `Unread` with the code svc-trade gave, or
//! `bank.realised_unread`: never 0, so a read that failed is never "no profit".

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s::CallSigner;
use service_kit::time::{Instant, zod_datetime};

use crate::errors::Refusal;

/// `REALISED_UNREAD`.
pub const REALISED_UNREAD: &str = "bank.realised_unread";

/// `Realised`: the venue's realised result over the window, and each main venue account's owner with its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Realised {
    pub venue_id: String,
    pub as_of: Instant,
    pub realised: Amount,
    pub accounts: Vec<(String, Amount)>,
}

/// What a read answers: the figure, or `unread` with its code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Read {
    Realised(Realised),
    Unread(String),
}

/// `RealisedSource`. `Err` is what the TypeScript throws past the read (an amount `parseAmount` refuses).
pub trait RealisedSource: Send + Sync {
    fn realised(
        &self,
        user_id: &str,
        asset: &str,
        since: Instant,
        until: Option<Instant>,
    ) -> Result<Read, Refusal>;
}

/// `createRealisedSource`: svc-trade's door, five seconds a read.
pub struct TradeRealised {
    base: String,
    signer: CallSigner,
    fetch: Box<dyn Fetch>,
}

impl TradeRealised {
    pub fn new(trade_url: &str, signer: CallSigner, fetch: Box<dyn Fetch>) -> TradeRealised {
        TradeRealised {
            base: trade_url.strip_suffix('/').unwrap_or(trade_url).to_owned(),
            signer,
            fetch,
        }
    }
}

/// `URLSearchParams`' serialisation of one name or value (`application/x-www-form-urlencoded`).
fn form_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(b));
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `^-?\d+(\.\d+)?$`.
fn decimal(s: &str) -> bool {
    let body = s.strip_prefix('-').unwrap_or(s);
    let (whole, frac) = match body.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (body, None),
    };
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && frac.is_none_or(digits)
}

/// `^0x[0-9a-f]{40}$`.
pub fn lower_address(s: &str) -> bool {
    s.len() == 42
        && s.starts_with("0x")
        && s.bytes()
            .skip(2)
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The body's figures as svc-trade wrote them: the venue, its time, the realised result and each account's.
struct Shaped {
    venue_id: String,
    as_of: Instant,
    realised: String,
    accounts: Vec<(String, String)>,
}

/// `realisedSchema.safeParse(body)` with the asset asked: the figures as strings, or none when not in shape.
fn in_shape(body: &Json, asset: &str) -> Option<Shaped> {
    let text = |k: &str| match body.get(k) {
        Some(Json::String(s)) => Some(s.clone()),
        _ => None,
    };
    let venue_id = text("venueId").filter(|v| !v.is_empty())?;
    let got_asset = text("asset")?;
    let as_of = zod_datetime(&text("asOf")?, true)?;
    let realised = text("realised").filter(|r| decimal(r))?;
    let Some(Json::Array(rows)) = body.get("accounts") else {
        return None;
    };
    let mut accounts = Vec::new();
    for row in rows {
        let owner = match row.get("owner") {
            Some(Json::String(o)) if lower_address(o) => o.clone(),
            _ => return None,
        };
        let r = match row.get("realised") {
            Some(Json::String(r)) if decimal(r) => r.clone(),
            _ => return None,
        };
        accounts.push((owner, r));
    }
    (got_asset == asset).then_some(Shaped {
        venue_id,
        as_of,
        realised,
        accounts,
    })
}

/// `^[a-z_.]+$`.
fn code_shape(c: &str) -> bool {
    !c.is_empty()
        && c.bytes()
            .all(|b| b.is_ascii_lowercase() || b == b'_' || b == b'.')
}

impl RealisedSource for TradeRealised {
    fn realised(
        &self,
        user_id: &str,
        asset: &str,
        since: Instant,
        until: Option<Instant>,
    ) -> Result<Read, Refusal> {
        let unread = || Ok(Read::Unread(REALISED_UNREAD.to_owned()));
        let mut query = vec![
            ("userId", user_id.to_owned()),
            ("asset", asset.to_owned()),
            ("since", since.iso()),
        ];
        if let Some(u) = until {
            query.push(("until", u.iso()));
        }
        let query: Vec<String> = query
            .iter()
            .map(|(k, v)| format!("{}={}", form_encode(k), form_encode(v)))
            .collect();
        let target = format!("/internal/venue/realised?{}", query.join("&"));
        let Ok(mut headers) = self.signer.sign("", "GET", &target, "application/json") else {
            return unread();
        };
        headers.insert(
            0,
            ("content-type".to_owned(), "application/json".to_owned()),
        );
        let Ok(res) = self.fetch.fetch(&HttpRequest {
            method: "GET".to_owned(),
            url: format!("{}{target}", self.base),
            headers,
            body: None,
            timeout_ms: Some(5_000),
            refuse_redirect: false,
        }) else {
            return unread();
        };
        let body = json::parse(&res.body).unwrap_or(Json::Null);
        if !res.ok() {
            return Ok(Read::Unread(match body.get("code") {
                Some(Json::String(c)) if code_shape(c) => c.clone(),
                _ => REALISED_UNREAD.to_owned(),
            }));
        }
        let Some(Shaped {
            venue_id,
            as_of,
            realised,
            accounts: rows,
        }) = in_shape(&body, asset)
        else {
            return unread();
        };
        // `parseAmount` past the shape: a figure it refuses is thrown, as the TypeScript's is.
        let amount = |s: &str| parse_amount(s).map_err(Refusal::Other);
        let mut accounts = Vec::new();
        let realised = amount(&realised)?;
        for (owner, r) in rows {
            accounts.push((owner, amount(&r)?));
        }
        Ok(Read::Realised(Realised {
            venue_id,
            as_of,
            realised,
            accounts,
        }))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::panic, reason = "a test")]
    use super::*;
    use service_kit::http::{FetchError, HttpResponse};
    use std::sync::Mutex;

    struct Answer {
        reply: Result<(u16, &'static str), &'static str>,
        asked: Mutex<Vec<HttpRequest>>,
    }

    impl Fetch for &'static Answer {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            self.asked.lock().unwrap().push(req.clone());
            self.reply
                .map(|(status, body)| HttpResponse {
                    status,
                    body: body.to_owned(),
                })
                .map_err(|m| FetchError {
                    message: m.to_owned(),
                })
        }
    }

    fn read(reply: Result<(u16, &'static str), &'static str>) -> (Result<Read, Refusal>, String) {
        let answer: &'static Answer = Box::leak(Box::new(Answer {
            reply,
            asked: Mutex::new(Vec::new()),
        }));
        let source = TradeRealised::new(
            "http://trade:4003/",
            CallSigner::new(
                "svc-bank",
                "svc-trade",
                "a-bank-to-trade-internal-secret-long-enough",
                None,
            ),
            Box::new(answer),
        );
        let out = source.realised(
            "user 1",
            "USDC",
            Instant(1_763_337_600_000),
            Some(Instant(1_763_942_400_000)),
        );
        let url = answer.asked.lock().unwrap()[0].url.clone();
        (out, url)
    }

    const GOOD: &str = r#"{"venueId":"v1","asset":"USDC","asOf":"2025-11-24T00:00:00.000Z","realised":"-12.5","accounts":[{"owner":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","realised":"3"}]}"#;

    #[test]
    fn the_read_asks_svc_trade_with_its_window_and_keeps_its_figures() {
        let (out, url) = read(Ok((200, GOOD)));
        assert_eq!(
            url,
            "http://trade:4003/internal/venue/realised?userId=user+1&asset=USDC&since=2025-11-17T00%3A00%3A00.000Z&until=2025-11-24T00%3A00%3A00.000Z"
        );
        let Ok(Read::Realised(r)) = out else {
            panic!("{out:?}")
        };
        assert_eq!(r.realised, parse_amount("-12.5").unwrap());
        assert_eq!(r.accounts.len(), 1);
    }

    #[test]
    fn every_failure_is_unread_never_zero() {
        let unread = |reply| match read(reply).0 {
            Ok(Read::Unread(c)) => c,
            other => panic!("{other:?}"),
        };
        assert_eq!(unread(Err("down")), REALISED_UNREAD);
        assert_eq!(
            unread(Ok((503, r#"{"code":"trade.venue_down"}"#))),
            "trade.venue_down"
        );
        assert_eq!(
            unread(Ok((503, r#"{"code":"Not A Code"}"#))),
            REALISED_UNREAD
        );
        assert_eq!(unread(Ok((200, "not json"))), REALISED_UNREAD);
        assert_eq!(
            unread(Ok((200, &*GOOD.replace("USDC", "BTC").leak()))),
            REALISED_UNREAD
        );
        assert_eq!(
            unread(Ok((200, &*GOOD.replace("0xaaaa", "0xAAAA").leak()))),
            REALISED_UNREAD
        );
        assert_eq!(
            unread(Ok((200, &*GOOD.replace("-12.5", "12.").leak()))),
            REALISED_UNREAD
        );
    }
}
