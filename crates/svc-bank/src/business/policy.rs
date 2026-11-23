//! `business/business-policy.ts`: the roles, the capability table every check asks, the separation of duties and the
//! public policy board.

use service_kit::json::Json;

/// `BUSINESS_ROLES`, in the table's order.
pub const ROLES: [&str; 8] = [
    "admin",
    "maker",
    "checker",
    "signer",
    "editor",
    "viewer",
    "security_auditor",
    "non_signing_admin",
];

/// `BusinessCapability`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    View,
    Propose,
    Approve,
    Sign,
    ManageTeam,
}

/// `BUSINESS_ROLE_CAPABILITIES`: what each role may do. A role the table does not know may do nothing.
pub fn capabilities(role: &str) -> &'static [Capability] {
    use Capability::{Approve, ManageTeam, Propose, Sign, View};
    match role {
        "admin" => &[View, Propose, Approve, Sign, ManageTeam],
        "non_signing_admin" => &[View, Propose, Approve, ManageTeam],
        "maker" | "editor" => &[View, Propose],
        "checker" => &[View, Approve],
        "signer" => &[View, Sign],
        "viewer" | "security_auditor" => &[View],
        _ => &[],
    }
}

/// `roleCan`.
pub fn role_can(role: &str, capability: Capability) -> bool {
    capabilities(role).contains(&capability)
}

/// `rolesWith(capability).join('|')`: the roles that hold a capability, in table order, for an error message.
pub fn roles_with(capability: Capability) -> String {
    ROLES
        .iter()
        .filter(|r| role_can(r, capability))
        .copied()
        .collect::<Vec<_>>()
        .join("|")
}

/// `dutyClash`: one person may not hold two duties on one request; an absent (or blank) duty is not compared.
pub fn duty_clash(
    initiator: Option<&str>,
    approver: Option<&str>,
    signer: Option<&str>,
) -> Option<&'static str> {
    fn held(v: Option<&str>) -> Option<&str> {
        v.filter(|s| !s.is_empty())
    }
    let (i, a, s) = (held(initiator), held(approver), held(signer));
    if i.is_some() && i == a {
        return Some("initiator_approver");
    }
    if i.is_some() && i == s {
        return Some("initiator_signer");
    }
    if a.is_some() && a == s {
        return Some("approver_signer");
    }
    None
}

/// `BUSINESS_PAYROLL_RATE_UNSET`.
pub const PAYROLL_RATE_UNSET: &str = "bank.business_payroll_rate_unset";

/// `describeBusinessPolicy`: the public board, in its keys' order.
pub fn describe() -> Json {
    let yes = || Json::Bool(true);
    Json::obj([
        (
            "roles",
            Json::Array(ROLES.iter().map(|r| Json::str(*r)).collect()),
        ),
        ("dualControlOverThreshold", yes()),
        ("holdBeforeCheckerApprove", yes()),
        ("makerCannotSelfApprove", yes()),
        ("thresholdPerAccountOwnerLaw", yes()),
        ("inventsDefaultThreshold", Json::Bool(false)),
        ("underThresholdPostsImmediately", yes()),
        ("payrollAtomicAllOrNothing", yes()),
        ("payrollSameAssetOnly", yes()),
        ("inventsPayrollRates", Json::Bool(false)),
        ("payrollRateUnsetCode", Json::str(PAYROLL_RATE_UNSET)),
        ("closeNeedsSecondAdmin", yes()),
        ("thresholdChangeNeedsSecondAdmin", yes()),
        ("memberHandlesFromIdentity", yes()),
        ("approvalHistoryUsesHandles", yes()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    // `business-roles.db.test.ts`, "role table" and "separation of duties".

    #[test]
    fn has_a_capability_row_for_every_role() {
        for r in ROLES {
            assert!(role_can(r, Capability::View), "{r}");
        }
        assert!(capabilities("owner").is_empty());
    }

    #[test]
    fn each_role_holds_exactly_its_capabilities() {
        use Capability::{Approve, ManageTeam, Propose, Sign, View};
        let all = [View, Propose, Approve, Sign, ManageTeam];
        let table: [(&str, &[Capability]); 8] = [
            ("admin", &all),
            ("non_signing_admin", &[View, Propose, Approve, ManageTeam]),
            ("maker", &[View, Propose]),
            ("editor", &[View, Propose]),
            ("checker", &[View, Approve]),
            ("signer", &[View, Sign]),
            ("viewer", &[View]),
            ("security_auditor", &[View]),
        ];
        for (role, can) in table {
            for c in all {
                assert_eq!(role_can(role, c), can.contains(&c), "{role} {c:?}");
            }
        }
    }

    #[test]
    fn only_admin_may_sign_among_the_administrators() {
        assert!(role_can("admin", Capability::Sign));
        assert!(!role_can("non_signing_admin", Capability::Sign));
        assert_eq!(
            roles_with(Capability::ManageTeam),
            "admin|non_signing_admin"
        );
        assert_eq!(
            roles_with(Capability::Approve),
            "admin|checker|non_signing_admin"
        );
    }

    #[test]
    fn refuses_one_person_holding_two_duties_on_the_same_request() {
        assert_eq!(
            duty_clash(Some("u1"), Some("u1"), None),
            Some("initiator_approver")
        );
        assert_eq!(
            duty_clash(Some("u1"), Some("u2"), Some("u1")),
            Some("initiator_signer")
        );
        assert_eq!(
            duty_clash(Some("u1"), Some("u2"), Some("u2")),
            Some("approver_signer")
        );
        assert_eq!(duty_clash(Some("u1"), Some("u2"), Some("u3")), None);
    }

    #[test]
    fn does_not_compare_a_duty_nobody_holds_yet() {
        assert_eq!(duty_clash(Some("u1"), None, None), None);
        assert_eq!(duty_clash(None, None, None), None);
        assert_eq!(duty_clash(Some(""), Some(""), None), None);
    }

    // `business-policy.test.ts`.

    #[test]
    fn states_dual_control_without_inventing_thresholds_or_rates() {
        let p = describe();
        assert_eq!(p.get("dualControlOverThreshold"), Some(&Json::Bool(true)));
        assert_eq!(p.get("inventsDefaultThreshold"), Some(&Json::Bool(false)));
        assert_eq!(
            p.get("thresholdPerAccountOwnerLaw"),
            Some(&Json::Bool(true))
        );
        assert_eq!(p.get("payrollAtomicAllOrNothing"), Some(&Json::Bool(true)));
        assert_eq!(p.get("inventsPayrollRates"), Some(&Json::Bool(false)));
        assert_eq!(
            p.get("payrollRateUnsetCode"),
            Some(&Json::str(PAYROLL_RATE_UNSET))
        );
    }
}
