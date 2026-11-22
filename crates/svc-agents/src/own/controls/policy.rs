//! What a person's own agent may do, by action and account (`own/policy.ts`, AG-spend-02, J-agents-08 #1).
//!
//! The person writes allow and deny rules, each for one action at one scope. For an action on an account:
//! 1. a deny whose scope covers the account refuses it `agents.policy_denied`, whatever order the rules were written
//!    in and whatever allows also match;
//! 2. otherwise an allow whose scope covers the account allows it;
//! 3. otherwise, on an agent that requires rules, it is refused `agents.policy_no_match`; on one that does not, no rule
//!    touches it and the agent's other gates decide.
//!
//! Rules only narrow: they never grant a tool the agent does not carry and never move value.

use postgres::IsolationLevel;
use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::time::Instant;

use super::super::{OwnError, OwnRefusal};
use crate::db::{self, StoreError};
use crate::runtime::ms;

/// `OWN_AGENT_POLICY_ACTIONS`.
pub const POLICY_ACTIONS: [&str; 3] = ["place_order", "cancel_order", "amend_order"];

/// `OwnAgentPolicyRule`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub id: String,
    pub effect: String,
    pub action: String,
    pub scope: String,
    pub created_at: Instant,
}

impl Rule {
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("effect", Json::str(self.effect.clone())),
            ("action", Json::str(self.action.clone())),
            ("scope", Json::str(self.scope.clone())),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

/// `OwnAgentPolicyDecision`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub action: String,
    pub account: String,
    /// `denied`, `allowed`, `no_match_refused` or `no_rule`.
    pub outcome: &'static str,
    pub rule_id: Option<String>,
}

impl Decision {
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("action", Json::str(self.action.clone())),
            ("account", Json::str(self.account.clone())),
            ("outcome", Json::str(self.outcome)),
            ("ruleId", self.rule_id.clone().map_or(Json::Null, Json::str)),
        ])
    }
}

/// `decide`: the rules' decision for one action on one account. The order of `rules` never changes the answer: the
/// deciding rule is picked by id among its kind.
pub fn decide(rules: &[Rule], rules_required: bool, action: &str, account: &str) -> Decision {
    let covers = |scope: &str| scope == "all" || scope == account;
    let first = |effect: &str| {
        rules
            .iter()
            .filter(|r| r.action == action && covers(&r.scope) && r.effect == effect)
            .map(|r| r.id.clone())
            // JavaScript's default sort compares UTF-16 code units; ids are ASCII, so byte order is the same.
            .min()
    };
    let decision = |outcome, rule_id| Decision {
        action: action.to_owned(),
        account: account.to_owned(),
        outcome,
        rule_id,
    };
    if let Some(deny) = first("deny") {
        return decision("denied", Some(deny));
    }
    if let Some(allow) = first("allow") {
        return decision("allowed", Some(allow));
    }
    decision(
        if rules_required {
            "no_match_refused"
        } else {
            "no_rule"
        },
        None,
    )
}

/// `assertDecisionAllows`: the refusal the decision carries; an allowed or untouched action passes.
pub fn assert_decision_allows(d: &Decision) -> Result<(), OwnRefusal> {
    let params = || [("action", d.action.clone()), ("account", d.account.clone())];
    match d.outcome {
        "denied" => Err(OwnRefusal::with("agents.policy_denied", params())),
        "no_match_refused" => Err(OwnRefusal::with("agents.policy_no_match", params())),
        _ => Ok(()),
    }
}

/// `policyRuleKey`.
pub fn policy_rule_key(agent_id: &str, effect: &str, action: &str, scope: &str) -> String {
    format!("agents:policy:{agent_id}:{effect}:{action}:{scope}")
}

fn rule_of(r: &postgres::Row) -> Result<Rule, StoreError> {
    Ok(Rule {
        id: r.try_get(0)?,
        effect: r.try_get(1)?,
        action: r.try_get(2)?,
        scope: r.try_get(3)?,
        created_at: Instant(r.try_get(4)?),
    })
}

fn rule_columns() -> String {
    format!("id::text, effect, action, scope, {}", ms("created_at"))
}

/// `OwnPolicyStore.add`: adding a rule that is already live returns the stored row; a retry never makes a second one.
pub fn add(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    effect: &str,
    action: &str,
    scope: &str,
) -> Result<Rule, OwnError> {
    let key = policy_rule_key(agent_id, effect, action, scope);
    loop {
        let found = db::with_client(pool, |c| {
            let inserted = c.query(
                &format!(
                    "INSERT INTO agents.own_agent_policy_rules (agent_id, owner_id, effect, action, scope, rule_key)
                     VALUES ($1::text::uuid, $2::text, $3::text, $4::text, $5::text, $6::text)
                     ON CONFLICT (owner_id, rule_key) WHERE removed_at IS NULL DO NOTHING
                     RETURNING {}",
                    rule_columns()
                ),
                &[&agent_id, &owner_id, &effect, &action, &scope, &key],
            )?;
            if let Some(r) = inserted.first() {
                return Ok(Some(rule_of(r)?));
            }
            let stored = c.query(
                &format!(
                    "SELECT {} FROM agents.own_agent_policy_rules
                      WHERE owner_id = $1::text AND rule_key = $2::text AND removed_at IS NULL",
                    rule_columns()
                ),
                &[&owner_id, &key],
            )?;
            stored.first().map(rule_of).transpose()
        })?;
        // The live row was removed between the insert and this read: the add is the person's newer word, so it is
        // made again.
        if let Some(rule) = found {
            return Ok(rule);
        }
    }
}

/// `OwnPolicyStore.remove`: a repeated remove of the same rule answers the same; one not the person's is not found.
pub fn remove(pool: &Pool, owner_id: &str, agent_id: &str, rule_id: &str) -> Result<(), OwnError> {
    let removed = db::with_client(pool, |c| {
        Ok(c.query(
            "UPDATE agents.own_agent_policy_rules SET removed_at = COALESCE(removed_at, now())
              WHERE owner_id = $1::text AND agent_id = $2::text::uuid AND id = $3::text::uuid
             RETURNING id",
            &[&owner_id, &agent_id, &rule_id],
        )?
        .len())
    })?;
    if removed == 0 {
        return Err(OwnRefusal::with(
            "agents.policy_rule_not_found",
            [("rule", rule_id.to_owned())],
        )
        .into());
    }
    Ok(())
}

/// `OwnPolicyStore.setRulesRequired`. The caller has already read the agent as the person's own.
pub fn set_rules_required(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    rules_required: bool,
) -> Result<(), OwnError> {
    db::with_client(pool, |c| {
        c.execute(
            "INSERT INTO agents.own_agent_policy_settings (agent_id, owner_id, rules_required)
             VALUES ($1::text::uuid, $2::text, $3)
             ON CONFLICT (agent_id) DO UPDATE
               SET rules_required = EXCLUDED.rules_required,
                   updated_at = CASE WHEN own_agent_policy_settings.rules_required = EXCLUDED.rules_required
                                     THEN own_agent_policy_settings.updated_at ELSE now() END",
            &[&agent_id, &owner_id, &rules_required],
        )?;
        Ok(())
    })?;
    Ok(())
}

/// `OwnAgentPolicy`: the live rules, whether rules are required, and the decision for every action on the main account.
pub struct Policy {
    pub rules_required: bool,
    pub rules: Vec<Rule>,
}

impl Policy {
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("rulesRequired", Json::Bool(self.rules_required)),
            (
                "rules",
                Json::Array(self.rules.iter().map(Rule::to_json).collect()),
            ),
            (
                "decisions",
                Json::Array(
                    POLICY_ACTIONS
                        .iter()
                        .map(|a| decide(&self.rules, self.rules_required, a, "main").to_json())
                        .collect(),
                ),
            ),
        ])
    }
}

/// `OwnPolicyStore.read`: the rules and the flag from one snapshot.
pub fn read(pool: &Pool, owner_id: &str, agent_id: &str) -> Result<Policy, OwnError> {
    Ok(db::transaction(
        pool,
        IsolationLevel::RepeatableRead,
        |tx| {
            let rules = tx
                .query(
                    &format!(
                        "SELECT {} FROM agents.own_agent_policy_rules
                      WHERE owner_id = $1::text AND agent_id = $2::text::uuid AND removed_at IS NULL
                      ORDER BY created_at, id",
                        rule_columns()
                    ),
                    &[&owner_id, &agent_id],
                )?
                .iter()
                .map(rule_of)
                .collect::<Result<Vec<_>, _>>()?;
            let rules_required = tx
                .query(
                    "SELECT rules_required FROM agents.own_agent_policy_settings
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid",
                    &[&owner_id, &agent_id],
                )?
                .first()
                .map(|r| r.try_get::<_, bool>(0))
                .transpose()?
                .unwrap_or(false);
            Ok(Policy {
                rules_required,
                rules,
            })
        },
    )?)
}

/// `OwnPolicyStore.assertAllows`: the stored rules' decision for one action, refused with its code when they refuse.
pub fn assert_allows(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    action: &str,
    account: &str,
) -> Result<Decision, OwnError> {
    let policy = read(pool, owner_id, agent_id)?;
    let decision = decide(&policy.rules, policy.rules_required, action, account);
    assert_decision_allows(&decision)?;
    Ok(decision)
}

/// `OwnAccessStore.assertAllows` (`own/access.ts`): an action naming a sub-account is refused when no live access
/// covers it (`agents.access_account_denied`) or the access covering it has ended (`agents.access_expired`); the
/// main account is not decided here. The access grants themselves are the `own-sharing` slice's.
pub fn assert_access_allows(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    account: &str,
    now: Instant,
) -> Result<(), OwnError> {
    let Some(sub) = account.strip_prefix("sub:") else {
        return Ok(());
    };
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.own_agent_account_access
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid AND ended_at IS NULL
                    AND sub_account = $3::text
                  ORDER BY granted_at DESC, name, id
                  LIMIT 1",
                ms("ends_at")
            ),
            &[&owner_id, &agent_id, &sub],
        )?)
    })?;
    let Some(row) = rows.first() else {
        return Err(OwnRefusal::with(
            "agents.access_account_denied",
            [("account", account.to_owned())],
        )
        .into());
    };
    let ends_at = Instant(row.try_get(0).map_err(StoreError::from)?);
    if ends_at.0 <= now.0 {
        return Err(OwnRefusal::with(
            "agents.access_expired",
            [("account", account.to_owned()), ("endedAt", ends_at.iso())],
        )
        .into());
    }
    Ok(())
}

/// The refusals `own.policy.check` and `own.policy.forService` answer FORBIDDEN.
pub fn policy_refused(code: &str) -> Option<&'static str> {
    matches!(
        code,
        "agents.policy_denied"
            | "agents.policy_no_match"
            | "agents.access_account_denied"
            | "agents.access_expired"
    )
    .then_some("FORBIDDEN")
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const B: &str = "00000000-0000-4000-8000-00000000000b";

    fn rule(id: &str, effect: &str, action: &str, scope: &str) -> Rule {
        Rule {
            id: id.to_owned(),
            effect: effect.to_owned(),
            action: action.to_owned(),
            scope: scope.to_owned(),
            created_at: Instant(0),
        }
    }

    /// `policy.test.ts`: "a deny at any covering scope wins over an allow, in either order and whichever rule has the
    /// lower id".
    #[test]
    fn a_covering_deny_wins_in_either_order_whichever_id_is_lower() {
        for (allow_id, deny_id) in [(A, B), (B, A)] {
            let allow = rule(allow_id, "allow", "place_order", "all");
            let deny = rule(deny_id, "deny", "place_order", "main");
            for rules in [
                vec![allow.clone(), deny.clone()],
                vec![deny.clone(), allow.clone()],
            ] {
                assert_eq!(
                    decide(&rules, false, "place_order", "main"),
                    Decision {
                        action: "place_order".to_owned(),
                        account: "main".to_owned(),
                        outcome: "denied",
                        rule_id: Some(deny_id.to_owned()),
                    }
                );
            }
        }
    }

    /// "an allow alone allows; a rule for another action does not touch this one".
    #[test]
    fn an_allow_alone_allows_and_another_actions_rule_touches_nothing() {
        let allow = rule(A, "allow", "place_order", "main");
        assert_eq!(
            decide(&[allow], true, "place_order", "main").outcome,
            "allowed"
        );
        let deny = rule(A, "deny", "place_order", "main");
        assert_eq!(
            decide(&[deny], false, "cancel_order", "main").outcome,
            "no_rule"
        );
    }

    /// "no matching rule refuses on an agent that requires rules, and is left to the other gates on one that does not".
    #[test]
    fn no_match_refuses_only_when_rules_are_required() {
        let d = decide(&[], true, "cancel_order", "main");
        assert_eq!(d.outcome, "no_match_refused");
        assert_eq!(d.rule_id, None);
        assert_eq!(
            assert_decision_allows(&d).err().map(|r| r.code).as_deref(),
            Some("agents.policy_no_match")
        );
        assert_eq!(
            decide(&[], false, "cancel_order", "main").outcome,
            "no_rule"
        );
    }

    #[test]
    fn a_main_scoped_rule_does_not_cover_a_sub_account() {
        let deny = rule(A, "deny", "place_order", "main");
        let sub = "sub:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assert_eq!(
            decide(&[deny], false, "place_order", sub).outcome,
            "no_rule"
        );
    }
}
