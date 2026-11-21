//! The funds a run is checked against before the engine is called (\`services/svc-agents/src/funds.ts\`, OWNER 107,
//! J-agents-02 #4), and how \`index.ts\` reads them (\`teamFunds\` over \`paymentMethodFunds\`).
//!
//! A ledger reading is the person's available balance in the fee asset; a wallet reading is the chosen wallet's balance
//! as the chain reports it, with the platform balance the run is billed to. A reading that cannot be made is unread, and
//! the run refuses \`agents.funds_unread\`: an unknown balance is not a covered one.

use std::sync::Arc;
use std::time::Duration;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::s2s::CallSigner;

use crate::db;
use crate::metering::ports::{HeldBy, UsagePayment};

/// \`FundsReading\`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reading {
    Ledger(Amount),
    Wallet {
        available: Amount,
        token: String,
        address: String,
        chain_id: i64,
        block: String,
        as_of: String,
        /// The platform balance the run is billed to; none on a reading made before it was added.
        billed: Option<Amount>,
    },
}

/// \`FundsUnreadError\`'s method and reason, or neither for any other failed read.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Unread {
    /// The wallet's address when the method was a wallet.
    pub address: Option<String>,
    pub reason: Option<&'static str>,
}

/// \`FundsPort\`.
pub trait Funds: Send + Sync {
    /// The reading for this run; `pool` is the agents' database, for what the session and the agent say.
    fn available(
        &self,
        pool: &Pool,
        user_id: &str,
        asset_id: &str,
        agent_id: &str,
        session_id: &str,
    ) -> Result<Reading, Unread>;
}

/// \`FundsOutcome\`: a reading, or why there is none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Read(Reading),
    Unread(Unread),
}

/// \`fundsShortfall\`: none when the reading covers \`amount\` after \`owed\`; else the outcome the refusal names.
pub fn shortfall(reading: &Reading, owed: Amount, amount: Amount) -> Option<Outcome> {
    match reading {
        Reading::Ledger(available) => {
            (*available - owed < amount).then(|| Outcome::Read(reading.clone()))
        }
        Reading::Wallet {
            available, billed, ..
        } => {
            if *available < amount {
                return Some(Outcome::Read(reading.clone()));
            }
            let Some(billed) = billed else {
                return Some(Outcome::Unread(Unread::default()));
            };
            (*billed - owed < amount).then_some(Outcome::Read(Reading::Ledger(*billed)))
        }
    }
}

/// \`fundsRefusalParams\`: a ledger reading keeps \`{ worstCase, asset }\`; a wallet adds its method, figure, source and
/// time; an unread wallet adds its method and reason.
pub fn refusal_params(worst_case: &str, asset: &str, outcome: &Outcome) -> Vec<(String, Json)> {
    let s = |k: &str, v: &str| (k.to_owned(), Json::str(v));
    let mut base = vec![s("worstCase", worst_case), s("asset", asset)];
    match outcome {
        Outcome::Read(Reading::Ledger(_)) => {}
        Outcome::Read(Reading::Wallet {
            available,
            token,
            address,
            chain_id,
            block,
            as_of,
            ..
        }) => {
            base.extend([
                s("method", "wallet"),
                s("address", address),
                s("available", &format_amount(*available)),
                s("token", token),
                s("source", "chain"),
                ("chainId".to_owned(), Json::int(*chain_id)),
                s("block", block),
                s("asOf", as_of),
            ]);
        }
        Outcome::Unread(Unread {
            address: None,
            reason,
        }) => {
            if let Some(r) = reason {
                base.push(s("reason", r));
            }
        }
        Outcome::Unread(Unread {
            address: Some(a),
            reason,
        }) => {
            base.extend([
                s("method", "wallet"),
                s("address", a),
                s("reason", reason.unwrap_or("method_unread")),
            ]);
        }
    }
    base
}

/// The person's available balance in one asset, as svc-ledger records it (\`ledger.balance(userAvailable(...))\`).
pub trait Balances: Send + Sync {
    fn available(&self, user_id: &str, asset_id: &str) -> Result<Amount, String>;
}

/// No ledger to read: every read fails, so a run that needs a balance is refused as unread.
pub struct NoBalances;

impl Balances for NoBalances {
    fn available(&self, _: &str, _: &str) -> Result<Amount, String> {
        Err("svc-ledger is not wired".to_owned())
    }
}

/// svc-ledger's \`/trpc/balance\` door, signed as svc-agents, retried as the ledger client retries.
pub struct BalancesHttp {
    pub base_url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
    pub timeout_ms: u64,
    pub retries: u32,
    pub sleep: fn(Duration),
}

/// svc-ledger's balance read.
pub const BALANCE_PATH: &str = "/trpc/balance";

impl BalancesHttp {
    pub fn new(base_url: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> BalancesHttp {
        BalancesHttp {
            base_url: base_url.trim_end_matches('/').to_owned(),
            signer,
            fetch,
            timeout_ms: 10_000,
            retries: 2,
            sleep: std::thread::sleep,
        }
    }
}

impl Balances for BalancesHttp {
    fn available(&self, user_id: &str, asset_id: &str) -> Result<Amount, String> {
        let payload = Json::obj([
            ("ownerType", Json::str("user")),
            ("ownerId", Json::str(user_id)),
            ("assetId", Json::str(asset_id)),
            ("kind", Json::str("available")),
        ])
        .compact();
        let url = format!("{}{BALANCE_PATH}", self.base_url);
        let mut attempt = 0;
        loop {
            let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
            headers.extend(
                self.signer
                    .sign(&payload, "POST", BALANCE_PATH, "application/json")?,
            );
            let sent = self.fetch.fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: url.clone(),
                headers,
                body: Some(payload.clone()),
                timeout_ms: Some(self.timeout_ms),
                refuse_redirect: false,
            });
            let retryable = match &sent {
                Err(_) => true,
                Ok(res) => [502, 503, 504].contains(&res.status),
            };
            if retryable && attempt < self.retries {
                (self.sleep)(Duration::from_millis(150 << attempt));
                attempt += 1;
                continue;
            }
            let res = sent.map_err(|e| e.message)?;
            if !res.ok() {
                return Err(format!("svc-ledger balance failed ({})", res.status));
            }
            let body = json::parse(&res.body).map_err(|e| e.message)?;
            return match (body.get("accountId"), body.get("amount")) {
                (Some(Json::String(_)), Some(Json::String(a))) => parse_amount(a),
                _ => Err("svc-ledger balance answered another shape".to_owned()),
            };
        }
    }
}

/// How \`index.ts\` reads funds: a team session by its business's payment method (\`teamFunds\`); a person's own agent
/// with a wallet chosen as its payment method by that wallet (\`paymentMethodFunds\`, owed by the \`own-controls\` slice:
/// until it lands the wallet is unread and the run refuses); everyone else by how they pay: nothing to pay with reads
/// 0, a partner's reported figure (an unreported one is unread, never 0), else the ledger balance.
pub struct PersonFunds {
    pub payment: Box<dyn UsagePayment>,
    pub balances: Box<dyn Balances>,
}

/// `UUID_RE`: an id Postgres reads as a uuid, case-insensitively.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn unread() -> Unread {
    Unread::default()
}

impl PersonFunds {
    fn by_payment(
        &self,
        user_id: &str,
        asset_id: &str,
        business: Option<&str>,
    ) -> Result<Reading, Unread> {
        match self.payment.read_available(user_id, asset_id, business) {
            Err(_) => Err(unread()),
            Ok((HeldBy::None, _)) => Ok(Reading::Ledger(0)),
            Ok((HeldBy::Partner, None)) => Err(unread()),
            Ok((HeldBy::Partner, Some(a))) => {
                parse_amount(&a).map(Reading::Ledger).map_err(|_| unread())
            }
            Ok((HeldBy::Ledger, _)) => self
                .balances
                .available(user_id, asset_id)
                .map(Reading::Ledger)
                .map_err(|_| unread()),
        }
    }
}

impl Funds for PersonFunds {
    fn available(
        &self,
        pool: &Pool,
        user_id: &str,
        asset_id: &str,
        agent_id: &str,
        session_id: &str,
    ) -> Result<Reading, Unread> {
        let team: Option<String> = db::with_client(pool, |c| {
            Ok(c.query(
                "SELECT business_id::text FROM agents.team_sessions WHERE session_id = $1::text::uuid",
                &[&session_id],
            )?
            .first()
            .map(|r| r.try_get::<_, String>(0))
            .transpose()?)
        })
        .map_err(|_| unread())?;
        if let Some(business) = team {
            return self.by_payment(user_id, asset_id, Some(&business));
        }
        if let Some(own) = agent_id.strip_prefix("own.") {
            let method: Option<String> = if is_uuid(own) {
                db::with_client(pool, |c| {
                    Ok(c.query(
                        "SELECT address FROM agents.own_agent_payment_methods
                          WHERE owner_id = $1::text AND agent_id = $2::text::uuid",
                        &[&user_id, &own],
                    )?
                    .first()
                    .map(|r| r.try_get::<_, String>(0))
                    .transpose()?)
                })
                .map_err(|_| Unread {
                    address: None,
                    reason: Some("method_unread"),
                })?
            } else {
                None
            };
            if let Some(address) = method {
                // The chain and the linked wallets are read by the own-controls slice (PORT.md).
                return Err(Unread {
                    address: Some(address),
                    reason: Some("method_unread"),
                });
            }
        }
        self.by_payment(user_id, asset_id, None)
    }
}
