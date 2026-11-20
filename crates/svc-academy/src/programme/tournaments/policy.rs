//! `academy.tournaments` product policy (`tournaments/tournament-policy.ts`): the public honesty board. Stage-1
//! ladders only; IFC prizes refuse-closed; no ledger recipe on this path.

use service_kit::json::Json;

use super::prize::{
    PRIZE_POOL_CLASS_M_RESIDUAL, PRIZE_POOL_UNSET_CODE, PRIZE_POOL_UNSET_RESIDUAL,
    PRIZE_REFUSE_CODE,
};

/// `TOURNAMENT_POLICY_RESIDUAL`.
pub const TOURNAMENT_POLICY_RESIDUAL: &str = "TRK-academy.tournaments D26-P1-C3 — Stage-1 ladder; IFC prizes refuse-closed; calendar never implies payout";

/// `describeTournamentPolicy()`, in its key order (`tournaments.policy` has no output schema).
pub fn describe_tournament_policy() -> Json {
    Json::obj([
        ("prizeRefuseCode", Json::str(PRIZE_REFUSE_CODE)),
        ("prizePoolUnsetCode", Json::str(PRIZE_POOL_UNSET_CODE)),
        (
            "prizePoolUnsetResidual",
            Json::str(PRIZE_POOL_UNSET_RESIDUAL),
        ),
        (
            "prizePoolClassMResidual",
            Json::str(PRIZE_POOL_CLASS_M_RESIDUAL),
        ),
        ("residual", Json::str(TOURNAMENT_POLICY_RESIDUAL)),
        ("academyHoldsPrizeBalance", Json::Bool(false)),
        ("ledgerRecipeReady", Json::Bool(false)),
        ("calendarNeverImpliesPayout", Json::Bool(true)),
        ("scoreWindowRequiresLiveSeason", Json::Bool(true)),
        ("frozenToLiveRefused", Json::Bool(true)),
        ("inventsPrizeBalances", Json::Bool(false)),
        ("inventsIfcCredits", Json::Bool(false)),
        ("movesMoney", Json::Bool(false)),
    ])
}

#[cfg(test)]
mod tests {
    //! `tournaments/tournament-policy.test.ts` and the policy half of `tournaments/tournaments.policy-route.test.ts`.
    use super::*;

    fn field(key: &str) -> Option<Json> {
        describe_tournament_policy().get(key).cloned()
    }

    #[test]
    fn states_prize_refuse_honesty_without_inventing_balances() {
        assert_eq!(field("prizeRefuseCode"), Some(Json::str(PRIZE_REFUSE_CODE)));
        assert_eq!(
            field("prizePoolUnsetCode"),
            Some(Json::str(PRIZE_POOL_UNSET_CODE))
        );
        assert_eq!(
            field("prizePoolUnsetResidual"),
            Some(Json::str(PRIZE_POOL_UNSET_RESIDUAL))
        );
        assert_eq!(
            field("prizePoolClassMResidual"),
            Some(Json::str(PRIZE_POOL_CLASS_M_RESIDUAL))
        );
        assert_eq!(
            field("residual"),
            Some(Json::str(TOURNAMENT_POLICY_RESIDUAL))
        );
        for no in [
            "academyHoldsPrizeBalance",
            "ledgerRecipeReady",
            "inventsPrizeBalances",
            "inventsIfcCredits",
            "movesMoney",
        ] {
            assert_eq!(field(no), Some(Json::Bool(false)), "{no}");
        }
        for yes in [
            "calendarNeverImpliesPayout",
            "scoreWindowRequiresLiveSeason",
            "frozenToLiveRefused",
        ] {
            assert_eq!(field(yes), Some(Json::Bool(true)), "{yes}");
        }
    }

    #[test]
    fn policy_has_no_money_fields() {
        assert_eq!(field("prizeAmount"), None);
        assert_eq!(field("ifcAmount"), None);
    }
}
