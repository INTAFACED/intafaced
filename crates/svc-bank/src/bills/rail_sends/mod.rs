//! Part `rail_sends` of the bills slice (`rail-sends/`): send from a space to a bank account over a bank rail
//! (`sends`), the recipient book for those rails with the owner's cooling-off (`payees`), each rail's form and its
//! checks (`forms`), and the calls `railSends.*` (`rail-sends.router.ts`).
//!
//! Nothing here holds or posts money: with no banking partner on any rail, a send is kept refused with `rail.bank`.
//! Asking to send and saving a recipient take `trade:withdraw`, the step-up scope, which the door checks.

pub mod forms;
pub mod payees;
pub mod sends;

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::Deps;
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use payees::{Book, PayeeAsk};
use sends::{Ask, To};

/// What the binary hands this part.
#[derive(Default)]
pub struct Wiring {
    /// `BANK_PAYEE_COOLING_HOURS` as `env.ts` reads it (`compose.ts`'s `payeeCoolingHours`): how long a new recipient
    /// waits. None or blank refuses every send to a saved recipient; zero is no wait.
    pub cooling_hours: Option<String>,
}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring::default()
    }
}

fn principal_user<'c>(ctx: &'c Ctx<'_>) -> Result<&'c str, Refusal> {
    ctx.principal
        .map(|p| p.user_id.as_str())
        .ok_or_else(|| Refusal::Other("no principal".to_owned()))
}

fn s<'v>(v: &'v Value, k: &str) -> &'v str {
    v.get(k).as_str().unwrap_or_default()
}

fn object(v: &Value) -> &[(String, Value)] {
    match v {
        Value::Object(o) => o,
        _ => &[],
    }
}

/// The send's ask: a saved recipient when the input names one (the schema's second branch), else typed details.
fn ask(input: &Value) -> Ask<'_> {
    let to = if matches!(input.get("payeeId"), Value::Undefined) {
        To::Typed {
            rail: s(input, "rail"),
            recipient: object(input.get("recipient")),
        }
    } else {
        To::Saved {
            payee_id: s(input, "payeeId"),
        }
    };
    Ask {
        from_space_id: s(input, "fromSpaceId"),
        amount: s(input, "amount"),
        to,
    }
}

fn payee_ask(input: &Value) -> PayeeAsk<'_> {
    PayeeAsk {
        nickname: s(input, "nickname"),
        country: s(input, "country"),
        rail: s(input, "rail"),
        recipient: object(input.get("recipient")),
    }
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "a whole number from 1 to 50 the schema checked"
)]
fn limit(input: &Value) -> i64 {
    input.get("limit").as_number().map_or(0, |n| n as i64)
}

fn book<'a>(d: &'a Deps<'_>) -> Book<'a> {
    Book {
        cooling_hours: d.w.rail_sends.cooling_hours.as_deref(),
        now: crate::door::system_now,
    }
}

fn run(d: &Deps<'_>, ctx: &Ctx<'_>, call: &str) -> Option<Result<Json, Refusal>> {
    let input = &ctx.input;
    let user = || principal_user(ctx);
    Some(match call {
        "requirements" => Ok(Json::obj([
            ("rails", forms::requirements()),
            ("countries", payees::countries()),
        ])),
        "check" => user().and_then(|u| sends::check(d, u, &ask(input))),
        "send" => user().and_then(|u| sends::send(d, u, s(input, "requestId"), &ask(input))),
        "list" => user().and_then(|u| sends::list(d, u, limit(input))),
        "payees" => user().and_then(|u| book(d).list(d.store(), u, limit(input))),
        "checkPayee" => Book::check(&payee_ask(input)),
        "addPayee" => user().and_then(|u| book(d).add(d.store(), u, &payee_ask(input))),
        "removePayee" => user().and_then(|u| Book::remove(d.store(), u, s(input, "payeeId"))),
        "readPayeeWarning" => {
            user().and_then(|u| book(d).read_scam_warning(d.store(), u, s(input, "payeeId")))
        }
        "invitePayee" => Err(Book::invite(s(input, "email"))),
        _ => return None,
    })
}

/// This part's calls; `None` for any other call. Each answers through the main router's guard (`toTrpcError`).
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    let call = ctx.call.path.strip_prefix("railSends.")?;
    let out = run(d, ctx, call)?;
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}
