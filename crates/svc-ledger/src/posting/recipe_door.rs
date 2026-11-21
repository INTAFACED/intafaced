//! The `post-recipe` slice: `POST /trpc/postRecipe`, as `s2s-http.ts` `handleS2sPostRecipe` runs it. The caller names a
//! recipe and gives its business inputs; the ledger builds the post itself and books it through the same pipeline as
//! `post` ([`super::post`]: the caller binding, the recipe gate, the binding checks, the custody switch, the engine).
//!
//! In order, nothing read or booked before the last step:
//! 1. the recipe is one the door posts ([`NAMES`], `isPostRecipeName`), else `ledger.recipe_unknown`;
//! 2. a proven caller holds a grant for that recipe (`grantFor`), else `ledger.caller_forbidden`;
//! 3. the body parses with the record's input (`LEDGER_POST_RECIPE.input`, recorded as `postRecipe` in
//!    `door/schemas.json`), and the recipe takes the inputs, else `ledger.recipe_input_invalid` (`postRecipeRequest`);
//! 4. the grant's module is the post's, else `ledger.caller_forbidden`;
//! 5. the post parses with `post`'s own input (`postRequestSchema.parse(ledgerPostWire(request))`), then is booked;
//! 6. the reply is checked against the record's output (`postRecipeReply`); a reply that breaks it is the ledger's
//!    fault, a 500.
//!
//! The legs are `packages/ledger-client/src/recipes/academy-purchase.ts`'s, `charge.ts`'s (`chargeEarn`,
//! `chargeCollect`) and `recipes/index.ts` `feeCharge`'s (its asset mode), held to them case for case by
//! `tests/post_recipe_parity.rs` (what the TypeScript door hands its ledger for each recorded body and caller).

use service_kit::json::Json;
use service_kit::money::{Amount, MAX_AMOUNT, format_amount, is_js_whitespace, parse_amount};
use service_kit::schema::{Outcome as Parsed, Value, js_trim};

use crate::db::Store;
use crate::errors::{self, Failure};
use crate::posting::Posting;
use crate::posting::gate::{Caller, grant_for};

/// `POST_RECIPE_NAMES`: the recipes the door posts, in the record's order.
pub const NAMES: [&str; 5] = [
    "academyPurchase",
    "academyPurchaseRefund",
    "feeCharge",
    "chargeEarn",
    "chargeCollect",
];

/// `ACADEMY_PURCHASE_MODULE`.
const ACADEMY: &str = "academy";
/// `KEY_MAX`.
const KEY_MAX: usize = 200;

/// The post a call books, as `post`'s input parsed it, and what the receipt names beside the booking.
#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    /// `postRequestSchema.parse(ledgerPostWire(request))`.
    pub post: Json,
    pub idempotency_key: String,
    pub module: String,
    pub reason: String,
}

/// `postRecipeRequest`'s refusal of inputs the record or the recipe refuses.
fn input_invalid(named: &str, why: &str) -> Failure {
    Failure::ledger(errors::POST_RECIPE_INPUT_INVALID, format!("{named}: {why}"))
}

/// `issue.path.join('.')`: strings as they are, numbers as JavaScript writes them.
fn joined(path: &[Json]) -> String {
    path.iter()
        .map(|p| match p {
            Json::String(s) => s.clone(),
            other => other.compact(),
        })
        .collect::<Vec<_>>()
        .join(".")
}

/// `handleS2sPostRecipe` up to `postChecked`: the post the door books for this caller and body (`None` is an absent
/// body), or the refusal it answers. Reads nothing.
pub fn prepare(caller: Option<&Caller>, body: Option<&Json>) -> Result<Prepared, Failure> {
    // `isRecord(body) ? body.recipe : undefined`, then `isPostRecipeName`.
    let sent = match body {
        Some(o @ Json::Object(_)) => o.get("recipe"),
        _ => None,
    };
    let Some(named) = sent.and_then(|v| match v {
        Json::String(s) => NAMES.iter().copied().find(|n| n == s),
        _ => None,
    }) else {
        let shown = sent.map_or_else(|| "null".to_owned(), Json::compact);
        return Err(Failure::ledger(
            errors::POST_RECIPE_UNKNOWN,
            format!("postRecipe does not post {shown}."),
        ));
    };
    // Before the inputs are even read: a caller learns nothing about a recipe it may not post.
    let grant = match caller {
        Some(Caller::Bound(service)) => Some(grant_for(service, named).ok_or_else(|| {
            Failure::ledger(
                errors::CALLER_FORBIDDEN,
                format!("Caller {service} may not post recipe {named}."),
            )
        })?),
        _ => None,
    };
    let value = body.map_or(Value::Undefined, Value::from_json);
    let input = match crate::door::parse("postRecipe", value) {
        Ok(Parsed::Ok(parsed)) => parsed.to_json().unwrap_or(Json::Null),
        Ok(Parsed::Issues(issues)) => {
            let why = issues.first().map_or_else(
                || "invalid".to_owned(),
                |issue| {
                    let path = joined(issue.path());
                    let at = if path.is_empty() { "(body)" } else { &path };
                    format!("{at}: {}", issue.message())
                },
            );
            return Err(input_invalid(named, &why));
        }
        Err(_) => return Err(Failure::Fault),
    };
    let fields = input.get("input").cloned().unwrap_or(Json::Null);
    let request = build(named, &fields).map_err(|why| input_invalid(named, &why))?;
    if let (Some(Caller::Bound(service)), Some(module)) = (caller, grant)
        && module != request.module
    {
        return Err(Failure::ledger(
            errors::CALLER_FORBIDDEN,
            format!(
                "Caller {service} may not post module {} as {named}.",
                request.module
            ),
        ));
    }
    let post = match crate::door::parse("post", Value::from_json(&request.wire())) {
        Ok(Parsed::Ok(parsed)) => parsed.to_json().unwrap_or(Json::Null),
        Ok(Parsed::Issues(issues)) => {
            return Err(Failure::Zod(service_kit::schema::message(&issues)));
        }
        Err(_) => return Err(Failure::Fault),
    };
    Ok(Prepared {
        post,
        idempotency_key: request.idempotency_key,
        module: request.module,
        reason: request.reason,
    })
}

/// `handleS2sPostRecipe`: the post booked through `post`'s pipeline, and the receipt the record names.
pub fn answer(
    store: &Store,
    posting: &Posting,
    caller: Option<&Caller>,
    mode: &str,
    body: Option<&Json>,
) -> Result<Json, Failure> {
    let prepared = prepare(caller, body)?;
    let ack = super::post(store, posting, caller, mode, &prepared.post)?;
    let Json::Object(mut reply) = ack else {
        return Err(Failure::Fault);
    };
    reply.push((
        "idempotencyKey".to_owned(),
        Json::str(prepared.idempotency_key),
    ));
    reply.push(("module".to_owned(), Json::str(prepared.module)));
    reply.push(("reason".to_owned(), Json::str(prepared.reason)));
    // The ledger's own reply breaking its record is this service's fault: never a 400 that blames the caller.
    match crate::door::parse("postRecipeReply", Value::from_json(&Json::Object(reply))) {
        Ok(Parsed::Ok(checked)) => checked.to_json().ok_or(Failure::Fault),
        _ => Err(Failure::Fault),
    }
}

// ── The recipes on the door (`academy-purchase.ts`) ────────────────────────────────────────────────────────────────

/// One leg of a post, before it is written for the wire.
struct Leg {
    owner_type: &'static str,
    owner_id: String,
    asset_id: String,
    direction: &'static str,
    amount: Amount,
}

/// A recipe's `PostRequest`.
struct Request {
    idempotency_key: String,
    module: String,
    reason: String,
    meta: Vec<(String, Json)>,
    entries: Vec<Leg>,
}

impl Request {
    /// `ledgerPostWire(request)`.
    fn wire(&self) -> Json {
        let entries = self
            .entries
            .iter()
            .map(|e| {
                Json::obj([
                    (
                        "account",
                        Json::obj([
                            ("ownerType", Json::str(e.owner_type)),
                            ("ownerId", Json::str(e.owner_id.clone())),
                            ("assetId", Json::str(e.asset_id.clone())),
                            ("kind", Json::str("available")),
                        ]),
                    ),
                    ("direction", Json::str(e.direction)),
                    ("amount", Json::str(format_amount(e.amount))),
                ])
            })
            .collect();
        Json::obj([
            ("idempotencyKey", Json::str(self.idempotency_key.clone())),
            ("module", Json::str(self.module.clone())),
            ("reason", Json::str(self.reason.clone())),
            ("meta", Json::Object(self.meta.clone())),
            ("entries", Json::Array(entries)),
        ])
    }
}

/// `RECIPE_DOORS[named].run(input)`: the inputs as the record parsed them, `n` and `amount` made the recipe's numbers,
/// then the recipe. The error is the refusal's message (`InvalidEntryError`'s or `MoneyError`'s).
fn build(named: &str, input: &Json) -> Result<Request, String> {
    let text = |k: &str| match input.get(k) {
        Some(Json::String(s)) => s.as_str(),
        _ => "",
    };
    match named {
        "feeCharge" => return fee_charge(input),
        "chargeEarn" => return charge_earn(input),
        "chargeCollect" => return charge_collect(input),
        _ => {}
    }
    // `parseAmount(i.amount)` runs before the recipe, so a figure the book cannot hold is refused first.
    let amount = parse_amount(text("amount"))?;
    let refund = named == "academyPurchaseRefund";
    let place = input.get(if refund { "from" } else { "to" });
    academy(
        refund,
        text("course"),
        text("userId"),
        text("n"),
        text("assetId"),
        amount,
        place,
        text("paymentId"),
    )
}

fn is_course(s: &str) -> bool {
    let b = s.as_bytes();
    let ok = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty()
        && b.len() <= 64
        && b.first().is_some_and(ok)
        && b.iter().skip(1).all(|c| ok(c) || *c == b'-')
}

/// `UUID_OWNER_ID_PATTERN`: a lowercase canonical UUID.
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}

fn is_chain_tx(s: &str) -> bool {
    s.len() == 66
        && s.starts_with("0x")
        && s.bytes()
            .skip(2)
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// `own-funds.ts` `PLACE_ID`.
fn is_place_id(s: &str) -> bool {
    let b = s.as_bytes();
    let ok = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    b.first().is_some_and(ok)
        && b.iter()
            .skip(1)
            .all(|c| ok(c) || matches!(c, b':' | b'_' | b'-'))
}

/// `ownFundsPlaceAccount(place, assetId)`: the treasury account a place names, by its owner id.
fn place_owner(place: Option<&Json>) -> Result<String, String> {
    let kind = match place.and_then(|p| p.get("kind")) {
        Some(Json::String(k)) => k.as_str(),
        _ => "",
    };
    let (field, prefix) = match kind {
        "venue-builder-account" => ("venueId", "venue-builder-account:"),
        "partner-reserve" => ("partnerId", "partner-reserve:"),
        _ => ("walletId", "treasury-wallet:"),
    };
    let id = match place.and_then(|p| p.get(field)) {
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    };
    if !is_place_id(&id) {
        return Err(format!(
            "{kind} needs a lower-case id, got {}",
            Json::str(id.clone()).compact()
        ));
    }
    // Each of the three is an own-funds place (`isOwnFundsPlace`), so the TypeScript's second check never refuses.
    Ok(format!("{prefix}{id}"))
}

/// `academyPurchase` (`refund` false) and `academyPurchaseRefund`: the purchase puts academy revenue up and records the
/// money now ours at the place; the refund is its exact reverse, keyed on the same purchase.
#[allow(
    clippy::too_many_arguments,
    reason = "the recipe's own inputs, one each"
)]
fn academy(
    refund: bool,
    course: &str,
    user_id: &str,
    n: &str,
    asset_id: &str,
    amount: Amount,
    place: Option<&Json>,
    payment_id: &str,
) -> Result<Request, String> {
    if !is_course(course) {
        return Err("course must be a lower-case course id: letters, digits and dashes, at most 64 characters".to_owned());
    }
    if !is_uuid(user_id) {
        return Err("userId must be the buyer's id as stored (a lowercase UUID)".to_owned());
    }
    // `n` reached here as the record's whole number from one (`BigInt(i.n)`), written back as it came.
    if n.is_empty() || n.starts_with('0') || !n.bytes().all(|c| c.is_ascii_digit()) {
        return Err("n must be a whole number, at least one".to_owned());
    }
    if js_trim(asset_id).is_empty() || js_trim(asset_id) != asset_id {
        return Err("assetId is required, with no surrounding spaces".to_owned());
    }
    if amount <= 0 {
        return Err("an academy purchase amount must be above zero".to_owned());
    }
    if !is_chain_tx(payment_id) {
        return Err(
            "paymentId must be the chain transaction hash: lowercase 0x and 64 hex characters"
                .to_owned(),
        );
    }
    let place = place_owner(place)?;
    let purchase_key = format!("academy:purchase:{course}:{user_id}:{n}");
    let key = if refund {
        format!("academy:refund:{course}:{user_id}:{n}")
    } else {
        purchase_key.clone()
    };
    if key.encode_utf16().count() > KEY_MAX {
        return Err(format!(
            "the post key would be longer than {KEY_MAX} characters"
        ));
    }
    let s = |v: &str| Json::str(v.to_owned());
    let house = |direction| Leg {
        owner_type: "house",
        owner_id: format!("fees:{ACADEMY}"),
        asset_id: asset_id.to_owned(),
        direction,
        amount,
    };
    let at_place = |direction| Leg {
        owner_type: "treasury",
        owner_id: place.clone(),
        asset_id: asset_id.to_owned(),
        direction,
        amount,
    };
    Ok(if refund {
        Request {
            idempotency_key: key,
            module: ACADEMY.to_owned(),
            reason: "academy.purchase.refunded".to_owned(),
            meta: vec![
                ("course".to_owned(), s(course)),
                ("userId".to_owned(), s(user_id)),
                ("purchaseKey".to_owned(), s(&purchase_key)),
                ("paymentId".to_owned(), s(payment_id)),
                ("from".to_owned(), s(&place)),
            ],
            // Revenue comes back down (refused below zero); the place comes back toward zero (refused above what it
            // holds of ours).
            entries: vec![house("credit"), at_place("debit")],
        }
    } else {
        Request {
            idempotency_key: key,
            module: ACADEMY.to_owned(),
            reason: "academy.purchase.posted".to_owned(),
            meta: vec![
                ("course".to_owned(), s(course)),
                ("userId".to_owned(), s(user_id)),
                ("paymentId".to_owned(), s(payment_id)),
                ("to".to_owned(), s(&place)),
            ],
            entries: vec![house("debit"), at_place("credit")],
        }
    })
}

// ── svc-agents' usage charge (`charge.ts`, `recipes/index.ts` `feeCharge`) ─────────────────────────────────────────

/// A string field of the parsed inputs, or empty.
fn field<'a>(input: &'a Json, k: &str) -> &'a str {
    match input.get(k) {
        Some(Json::String(s)) => s.as_str(),
        _ => "",
    }
}

/// `charge.ts` `MODULE_ID`.
fn is_module(s: &str) -> bool {
    let b = s.as_bytes();
    let ok = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    b.first().is_some_and(ok) && b.iter().skip(1).all(|c| ok(c) || matches!(c, b'_' | b'-'))
}

/// `charge.ts` `REF`: no whitespace, no `:`.
fn is_ref(s: &str) -> bool {
    !s.is_empty() && !s.chars().any(|c| c == ':' || is_js_whitespace(c))
}

fn require_module(module: &str) -> Result<(), String> {
    if is_module(module) {
        Ok(())
    } else {
        Err("module must be a lower-case module id".to_owned())
    }
}

fn require_user(user_id: &str) -> Result<(), String> {
    if is_uuid(user_id) {
        Ok(())
    } else {
        Err("userId must be the customer's id as stored (a lowercase UUID)".to_owned())
    }
}

fn require_asset(asset_id: &str) -> Result<(), String> {
    if js_trim(asset_id).is_empty() || js_trim(asset_id) != asset_id {
        return Err("assetId is required, with no surrounding spaces".to_owned());
    }
    Ok(())
}

fn require_key(key: String) -> Result<String, String> {
    if key.encode_utf16().count() > KEY_MAX {
        return Err(format!(
            "the post key would be longer than {KEY_MAX} characters"
        ));
    }
    Ok(key)
}

/// `chargeReceivable(module, userId, assetId)`: what one customer owes us for one module's charges.
fn receivable(
    module: &str,
    user_id: &str,
    asset_id: &str,
    direction: &'static str,
    amount: Amount,
) -> Leg {
    Leg {
        owner_type: "treasury",
        owner_id: format!("charge-receivable:{module}.{user_id}"),
        asset_id: asset_id.to_owned(),
        direction,
        amount,
    }
}

/// `houseFees(module, assetId)`.
fn house_fees(module: &str, asset_id: &str, direction: &'static str, amount: Amount) -> Leg {
    Leg {
        owner_type: "house",
        owner_id: format!("fees:{module}"),
        asset_id: asset_id.to_owned(),
        direction,
        amount,
    }
}

/// `feeCharge({ ...i, amount: parseAmount(i.amount) })` in its asset mode: the person's available down, the module's fee
/// pot up. Custodial: the custody switch refuses it while the layer is off.
fn fee_charge(input: &Json) -> Result<Request, String> {
    let amount = parse_amount(field(input, "amount"))?;
    if amount <= 0 {
        return Err("fee amount must be positive".to_owned());
    }
    let module = field(input, "module");
    let asset_id = field(input, "assetId");
    let reason = match input.get("reason") {
        Some(Json::String(r)) => r.clone(),
        _ => "fee.charged".to_owned(),
    };
    Ok(Request {
        idempotency_key: format!("fee:{module}:{}", field(input, "chargeId")),
        module: module.to_owned(),
        reason,
        meta: vec![("mode".to_owned(), Json::str("asset"))],
        entries: vec![
            Leg {
                owner_type: "user",
                owner_id: field(input, "userId").to_owned(),
                asset_id: asset_id.to_owned(),
                direction: "credit",
                amount,
            },
            house_fees(module, asset_id, "debit", amount),
        ],
    })
}

/// `chargeEarn`: the price and the units made the recipe's numbers (the charge they give must fit the book), then the
/// receivable down and the module's revenue up.
fn charge_earn(input: &Json) -> Result<Request, String> {
    let per_unit = parse_amount(input.get("price").map_or("", |p| field(p, "perUnit")))?;
    let units_text = field(input, "units");
    let units: Amount = units_text
        .parse()
        .map_err(|_| "units must be a whole number, at least one".to_owned())?;
    // `parseAmount(perUnit * units)`: `fitsColumn`.
    let amount = per_unit
        .checked_mul(units)
        .filter(|a| (-MAX_AMOUNT..=MAX_AMOUNT).contains(a))
        .ok_or_else(|| "Amount does not fit numeric(38,18)".to_owned())?;
    let module = field(input, "module");
    let sale_id = field(input, "saleId");
    let user_id = field(input, "userId");
    let asset_id = field(input, "assetId");
    require_module(module)?;
    if !is_ref(sale_id) {
        return Err("saleId must be an id with no spaces or colons".to_owned());
    }
    require_user(user_id)?;
    require_asset(asset_id)?;
    if units < 1 {
        return Err("units must be a whole number, at least one".to_owned());
    }
    if per_unit < 0 {
        return Err("the price must be an amount, zero or more".to_owned());
    }
    if amount == 0 {
        return Err("a charge must be above zero; a free sale posts nothing".to_owned());
    }
    let member = match input.get("memberUserId") {
        Some(Json::String(m)) => {
            require_user(m)?;
            Some(m.clone())
        }
        _ => None,
    };
    let key = require_key(format!("charge:earned:{module}:{sale_id}"))?;
    let mut meta = vec![
        ("saleId".to_owned(), Json::str(sale_id)),
        ("userId".to_owned(), Json::str(user_id)),
        ("perUnit".to_owned(), Json::str(format_amount(per_unit))),
        ("units".to_owned(), Json::str(units.to_string())),
    ];
    if let Some(m) = member {
        meta.push(("memberUserId".to_owned(), Json::str(m)));
    }
    Ok(Request {
        idempotency_key: key,
        module: module.to_owned(),
        reason: "charge.earned".to_owned(),
        meta,
        entries: vec![
            house_fees(module, asset_id, "debit", amount),
            receivable(module, user_id, asset_id, "credit", amount),
        ],
    })
}

/// `chargeCollect({ ...i, amount: parseAmount(i.amount) })`: what the customer owes comes down; the own-funds place
/// records the money now ours.
fn charge_collect(input: &Json) -> Result<Request, String> {
    let amount = parse_amount(field(input, "amount"))?;
    let module = field(input, "module");
    let user_id = field(input, "userId");
    let asset_id = field(input, "assetId");
    let payment_id = field(input, "paymentId");
    require_module(module)?;
    require_user(user_id)?;
    require_asset(asset_id)?;
    if !is_ref(payment_id) {
        return Err("paymentId must be an id with no spaces or colons".to_owned());
    }
    if payment_id.encode_utf16().count() > 128 {
        return Err("paymentId must be at most 128 characters".to_owned());
    }
    if amount <= 0 {
        return Err("a collected charge must be above zero".to_owned());
    }
    let place = place_owner(input.get("to"))?;
    let key = require_key(format!("charge:collected:{place}:{asset_id}:{payment_id}"))?;
    Ok(Request {
        idempotency_key: key,
        module: module.to_owned(),
        reason: "charge.collected".to_owned(),
        meta: vec![
            ("userId".to_owned(), Json::str(user_id)),
            ("to".to_owned(), Json::str(place.clone())),
            ("paymentId".to_owned(), Json::str(payment_id)),
        ],
        entries: vec![
            receivable(module, user_id, asset_id, "debit", amount),
            Leg {
                owner_type: "treasury",
                owner_id: place,
                asset_id: asset_id.to_owned(),
                direction: "credit",
                amount,
            },
        ],
    })
}
