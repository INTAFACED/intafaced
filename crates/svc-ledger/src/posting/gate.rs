//! Who may post what, as the door decides before the book is read: the recipe gate (`recipe-gate.ts`: a body is
//! posted only when its module, reason and legs are a registry recipe's) and the caller binding (`caller-binding.ts`:
//! a proven caller posts only the recipes `caller-allowlist.ts` grants it, in the grant's module). The catalog and the
//! allowlist are recorded from the TypeScript (`recorded.rs`); the three shapes whose module or reason the caller
//! chooses are matched here, as `recipe-gate.ts` matches them.

use crate::errors::{self, Failure};
use crate::posting::recorded::{ALLOWLIST, CATALOG, KEY_REQUIRED, Repeat};
use crate::posting::rules::{AccountRef, Direction, Entry, PostRequest};

/// `RECIPE_REQUIRED_CODE`.
pub const RECIPE_REQUIRED: &str = "ledger.recipe_required";

/// `purposeHead`: the purpose up to its first `:` (the raw purpose, untrimmed, as the TypeScript reads it).
fn purpose_head(purpose: Option<&str>) -> &str {
    purpose
        .filter(|p| !p.is_empty())
        .map_or("", |p| p.split(':').next().unwrap_or(""))
}

/// `accountRole`: what part of a platform owner's id names its role.
fn account_role(a: &AccountRef) -> String {
    if a.owner_type == "user" || a.owner_type == "subaccount" {
        return String::new();
    }
    let id = a.owner_id.as_str();
    let parts: Vec<&str> = id.split(':').collect();
    if id.is_empty() || parts.iter().any(|p| p.is_empty()) {
        return id.to_owned();
    }
    if a.owner_type == "treasury" {
        if parts.len() == 1 {
            return id.to_owned();
        }
        return format!("{}:*", parts.first().copied().unwrap_or(""));
    }
    if parts.len() <= 2 {
        return id.to_owned();
    }
    format!(
        "{}:*",
        parts.get(..parts.len() - 1).unwrap_or(&[]).join(":")
    )
}

/// `legSignature`.
fn leg_signature(e: &Entry) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        e.account.owner_type,
        e.account.kind,
        e.direction.as_str(),
        purpose_head(e.account.purpose.as_deref()),
        account_role(&e.account)
    )
}

fn is_house_fees(a: &AccountRef) -> bool {
    a.owner_type == "house" && a.kind == "available" && a.owner_id.starts_with("fees:")
}

fn is_rewards_engine(a: &AccountRef) -> bool {
    a.owner_type == "house" && a.kind == "available" && a.owner_id == "rewards-engine"
}

fn two(r: &PostRequest) -> Option<(&Entry, &Entry)> {
    match r.entries.as_slice() {
        [a, b] => Some((a, b)),
        _ => None,
    }
}

/// `matchesFeeCharge`: a person's available credited, house fees debited; module and reason are the caller's.
fn matches_fee_charge(r: &PostRequest) -> bool {
    two(r).is_some_and(|(a, b)| {
        a.direction == Direction::Credit
            && a.account.owner_type == "user"
            && a.account.kind == "available"
            && b.direction == Direction::Debit
            && is_house_fees(&b.account)
    })
}

/// `matchesFeeSweep`: `token.fee.swept` from any fee pot to the rewards engine.
fn matches_fee_sweep(r: &PostRequest) -> bool {
    r.module == "token"
        && r.reason == "token.fee.swept"
        && two(r).is_some_and(|(a, b)| {
            a.direction == Direction::Credit
                && is_house_fees(&a.account)
                && b.direction == Direction::Debit
                && is_rewards_engine(&b.account)
        })
}

/// `matchesRewardPay`: the rewards engine to a person's available, module `token`; the reason is the caller's.
fn matches_reward_pay(r: &PostRequest) -> bool {
    r.module == "token"
        && two(r).is_some_and(|(a, b)| {
            a.direction == Direction::Credit
                && is_rewards_engine(&a.account)
                && b.direction == Direction::Debit
                && b.account.owner_type == "user"
                && b.account.kind == "available"
        })
}

/// `matchesRepeat`.
fn matches_repeat(rules: &[Repeat], sigs: &[String]) -> bool {
    rules.iter().any(|rule| {
        sigs.len() >= rule.prefix.len() + rule.min_tail
            && rule.prefix.iter().zip(sigs).all(|(p, s)| p == s)
            && sigs
                .get(rule.prefix.len()..)
                .unwrap_or(&[])
                .iter()
                .all(|s| rule.tokens.contains(&s.as_str()))
    })
}

/// `catalogRecipe`.
fn catalog_recipe(r: &PostRequest) -> Option<&'static str> {
    let key = format!("{}::{}", r.module, r.reason);
    let row = CATALOG.iter().find(|row| row.key == key)?;
    if r.entries.len() < row.min_legs {
        return None;
    }
    let sigs: Vec<String> = r.entries.iter().map(leg_signature).collect();
    let joined = sigs.join(";");
    if row.signatures.contains(&joined.as_str()) || matches_repeat(row.repeats, &sigs) {
        return Some(row.name);
    }
    None
}

/// `recipeCandidates`: every recipe this body matches, the caller-chosen shapes first.
pub fn recipe_candidates(r: &PostRequest) -> Vec<&'static str> {
    let mut found = Vec::new();
    if matches_fee_charge(r) {
        found.push("feeCharge");
    }
    if matches_reward_pay(r) {
        found.push("rewardPay");
    }
    if matches_fee_sweep(r) {
        found.push("sweepFeesToRewards");
    }
    if let Some(c) = catalog_recipe(r)
        && !found.contains(&c)
    {
        found.push(c);
    }
    found
}

/// `assertKnownRecipePost`.
pub fn assert_known_recipe(r: &PostRequest) -> Result<(), Failure> {
    if recipe_candidates(r).is_empty() {
        return Err(Failure::ledger(
            RECIPE_REQUIRED,
            format!(
                "POST /trpc/post only accepts ledger-client recipes; '{}/{}' is not a known recipe",
                r.module, r.reason
            ),
        ));
    }
    Ok(())
}

/// `grantFor(service, recipe)`: the module the grant requires.
pub fn grant_for(service: &str, recipe: &str) -> Option<&'static str> {
    ALLOWLIST
        .iter()
        .find(|(s, _)| *s == service)?
        .1
        .iter()
        .find(|(r, _)| *r == recipe)
        .map(|(_, m)| *m)
}

fn modules_for(service: &str) -> Vec<&'static str> {
    ALLOWLIST
        .iter()
        .find(|(s, _)| *s == service)
        .map_or_else(Vec::new, |(_, g)| g.iter().map(|(_, m)| *m).collect())
}

/// `PostCaller`: the owner of the key that verified, or the name claimed under the shared secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    Bound(String),
    Legacy(Option<String>),
}

/// `BindingViolation['reason']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    Unbound,
    Recipe,
    Module,
}

impl Why {
    pub fn as_str(self) -> &'static str {
        match self {
            Why::Unbound => "unbound",
            Why::Recipe => "recipe",
            Why::Module => "module",
        }
    }
}

/// `BindingViolation`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub code: &'static str,
    pub why: Why,
    pub service: Option<String>,
    pub module: String,
    pub recipe: Option<&'static str>,
}

/// `judgeCallerPost`: the recipe the caller may post this body as, or the first refusal.
pub fn judge(caller: &Caller, r: &PostRequest) -> Result<Option<&'static str>, Violation> {
    let service = match caller {
        Caller::Bound(s) => Some(s.as_str()),
        Caller::Legacy(c) => c.as_deref(),
    }
    .filter(|s| !s.is_empty());
    let fail = |code, why, service: Option<&str>, recipe| Violation {
        code,
        why,
        service: service.map(str::to_owned),
        module: r.module.clone(),
        recipe,
    };
    let Some(service) = service else {
        return Err(fail(errors::CALLER_UNBOUND, Why::Unbound, None, None));
    };
    let candidates = recipe_candidates(r);
    if candidates.is_empty() {
        if !modules_for(service).contains(&r.module.as_str()) {
            return Err(fail(
                errors::CALLER_FORBIDDEN,
                Why::Module,
                Some(service),
                None,
            ));
        }
        return Ok(None);
    }
    let mut first = None;
    for recipe in &candidates {
        match grant_for(service, recipe) {
            None => {
                first.get_or_insert_with(|| {
                    fail(
                        errors::CALLER_FORBIDDEN,
                        Why::Recipe,
                        Some(service),
                        Some(*recipe),
                    )
                });
            }
            Some(m) if m != r.module => {
                first.get_or_insert_with(|| {
                    fail(
                        errors::CALLER_FORBIDDEN,
                        Why::Module,
                        Some(service),
                        Some(*recipe),
                    )
                });
            }
            Some(_) => return Ok(Some(*recipe)),
        }
    }
    Err(first.unwrap_or_else(|| {
        fail(
            errors::CALLER_FORBIDDEN,
            Why::Recipe,
            Some(service),
            candidates.first().copied(),
        )
    }))
}

/// `violationMessage`.
fn violation_message(v: &Violation) -> String {
    let service = v.service.as_deref().unwrap_or("null");
    if v.code == errors::CALLER_UNBOUND {
        return "Ledger post requires a per-service key.".to_owned();
    }
    if v.why == Why::Module {
        let recipe = v.recipe.map(|r| format!(" as {r}")).unwrap_or_default();
        return format!("Caller {service} may not post module {}{recipe}.", v.module);
    }
    format!(
        "Caller {service} may not post recipe {} (module {}).",
        v.recipe.unwrap_or("unknown"),
        v.module
    )
}

/// `applyCallerBinding`: every violation it observes, in order, then the refusal if there is one. A shared-secret post
/// is counted unbound and still posts, except a key-required recipe once keys are configured; a proven key outside its
/// allowlist is refused.
pub fn apply_binding(
    caller: &Caller,
    r: &PostRequest,
    keys_configured: bool,
) -> (Vec<Violation>, Result<(), Failure>) {
    let judgment = judge(caller, r);
    let mut seen = Vec::new();
    if let Caller::Legacy(claimed) = caller {
        let already = matches!(&judgment, Err(v) if v.why == Why::Unbound);
        if !already {
            seen.push(Violation {
                code: errors::CALLER_UNBOUND,
                why: Why::Unbound,
                service: claimed.clone(),
                module: r.module.clone(),
                recipe: None,
            });
        }
    }
    if let Err(v) = &judgment {
        seen.push(v.clone());
    }
    if let (Err(v), Caller::Bound(_)) = (&judgment, caller) {
        let refused = Failure::ledger(v.code, violation_message(v));
        return (seen, Err(refused));
    }
    if let Caller::Legacy(claimed) = caller
        && keys_configured
        && recipe_candidates(r)
            .iter()
            .any(|c| KEY_REQUIRED.contains(c))
    {
        let v = Violation {
            code: errors::CALLER_UNBOUND,
            why: Why::Unbound,
            service: claimed.clone(),
            module: r.module.clone(),
            recipe: None,
        };
        return (
            seen,
            Err(Failure::ledger(
                errors::CALLER_UNBOUND,
                violation_message(&v),
            )),
        );
    }
    (seen, Ok(()))
}
