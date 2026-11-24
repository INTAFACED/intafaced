//! The owner-published page sizes the area's SQL lists take (`ambassadors/list-limit.ts`, `sql-list-limit.ts`,
//! `learning/limits.ts`): blank, non-finite or below one refuses with the list's own code; nothing invents 50 or the
//! whole table; 200 is the cap, never a default.

use crate::errors::AcademyError;

/// The cap every one of these lists shares (`ACADEMY_CUSTOMER_LIST_MAX` is the same 200).
pub const LIST_CAP: i64 = 200;

/// `assertSqlListLimit(limit, code, label)`: `Math.min(200, Math.floor(limit))`, or the refusal.
pub fn sql_list_limit(limit: Option<f64>, code: &str, label: &str) -> Result<i64, AcademyError> {
    let refuse = || {
        AcademyError::new(
            format!("{label} list limit is unset — pass limit (never invent the whole table)"),
            code,
        )
    };
    let Some(n) = limit.filter(|n| n.is_finite()) else {
        return Err(refuse());
    };
    let n = n.floor();
    if n < 1.0 {
        return Err(refuse());
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a finite whole number, capped at 200 next"
    )]
    let whole = if n > 200.0 { LIST_CAP } else { n as i64 };
    Ok(whole.min(LIST_CAP))
}

/// `assertAmbassadorsListLimit`.
pub fn ambassadors_list_limit(limit: Option<f64>) -> Result<i64, AcademyError> {
    sql_list_limit(limit, "academy.ambassadors_list_limit_unset", "Ambassadors")
}

/// `assertMyResidenciesListLimit`.
pub fn my_residencies_list_limit(limit: Option<f64>) -> Result<i64, AcademyError> {
    sql_list_limit(
        limit,
        "academy.my_residencies_list_limit_unset",
        "My residencies",
    )
}

/// `assertOpenResidenciesListLimit`.
pub fn open_residencies_list_limit(limit: Option<f64>) -> Result<i64, AcademyError> {
    sql_list_limit(
        limit,
        "academy.open_residencies_list_limit_unset",
        "Open residencies",
    )
}

/// `assertCustomerListLimit(limit, 'academy.residency_cohorts_list_limit_unset', 'Residency cohorts')`.
pub fn residency_cohorts_list_limit(limit: Option<f64>) -> Result<i64, AcademyError> {
    sql_list_limit(
        limit,
        "academy.residency_cohorts_list_limit_unset",
        "Residency cohorts",
    )
}

#[cfg(test)]
mod tests {
    //! `list-ambassadors-limit-unset.test.ts`, `list-my-residencies-limit-unset.test.ts` and the open-residencies part
    //! of `list-remaining-sql-lists-limit-unset.test.ts`. The TypeScript's `'nope'` garbage cannot reach Rust: the
    //! door's `z.number()` refuses it first, so `None` stands for every non-number.
    #![allow(clippy::unwrap_used, reason = "a test")]

    use super::*;

    type Assert = fn(Option<f64>) -> Result<i64, AcademyError>;

    const ASSERTS: [(Assert, &str); 4] = [
        (
            ambassadors_list_limit,
            "academy.ambassadors_list_limit_unset",
        ),
        (
            my_residencies_list_limit,
            "academy.my_residencies_list_limit_unset",
        ),
        (
            open_residencies_list_limit,
            "academy.open_residencies_list_limit_unset",
        ),
        (
            residency_cohorts_list_limit,
            "academy.residency_cohorts_list_limit_unset",
        ),
    ];

    #[test]
    fn unset_limits_refuse_and_never_invent_50() {
        let unset = [
            None,
            Some(f64::NAN),
            Some(f64::INFINITY),
            Some(0.0),
            Some(-1.0),
            Some(0.5),
        ];
        for (f, code) in ASSERTS {
            for limit in unset {
                assert_eq!(f(limit).unwrap_err().code, code, "{limit:?}");
            }
            let message = f(None).unwrap_err().message;
            assert!(
                !message.contains("50-row")
                    && !message.contains("default 50")
                    && !message.contains("?? 50")
            );
        }
    }

    #[test]
    fn an_owner_published_50_is_accepted_and_200_is_the_cap() {
        for (f, _) in ASSERTS {
            assert_eq!(f(Some(50.0)).unwrap(), 50);
            assert_eq!(f(Some(1.0)).unwrap(), 1);
            assert_eq!(f(Some(200.0)).unwrap(), 200);
            assert_eq!(f(Some(201.0)).unwrap(), 200);
            assert_eq!(f(Some(2.9)).unwrap(), 2, "Math.floor");
            assert_eq!(f(Some(1e300)).unwrap(), 200);
        }
    }
}
