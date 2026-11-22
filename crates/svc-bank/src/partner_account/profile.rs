//! The profile a bank call is made for (`account-home/profile.ts`): Personal, or one business the caller belongs to.
//! Only `personalOnly` is this slice's: the account reads and writes that only a personal account has. The rest of
//! `ProfileService` is slice `spaces`'.

use crate::db::{Store, StoreError, with_client};
use crate::errors::Refusal;

use super::refuse;

/// `PERSONAL_PROFILE`.
pub const PERSONAL: &str = "personal";

/// `BUSINESS_PROFILE`'s account id: `business:<lower-case uuid>` (the schema already trimmed and lower-cased it).
fn business_id(profile: &str) -> Option<&str> {
    let id = profile.strip_prefix("business:")?;
    let b = id.as_bytes();
    let ok = b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        });
    ok.then_some(id)
}

fn not_held() -> Refusal {
    refuse("bank.profile_not_held", "This profile is not one you hold")
}

/// `ProfileService.personalOnly`: Personal (or none) passes; a held business refuses
/// `bank.company_account_unwired`; one the caller does not hold refuses `bank.profile_not_held`. Reads only.
pub fn personal_only(store: &Store, user_id: &str, profile: Option<&str>) -> Result<(), Refusal> {
    let Some(profile) = profile.filter(|p| *p != PERSONAL) else {
        return Ok(());
    };
    let Some(account_id) = business_id(profile) else {
        return Err(not_held());
    };
    let held = store
        .pool()
        .and_then(|pool| {
            with_client(pool, |c| {
                let rows = c.query(
                    "SELECT a.name FROM bank.business_accounts a \
                       JOIN bank.business_members m ON m.account_id = a.id AND m.user_id = $1 \
                      WHERE a.id = $2::text::uuid AND a.status = 'active'",
                    &[&user_id, &account_id],
                )?;
                Ok::<_, StoreError>(!rows.is_empty())
            })
        })
        .map_err(|e| Refusal::Other(e.message))?;
    if !held {
        return Err(not_held());
    }
    Err(refuse(
        "bank.company_account_unwired",
        "A business profile has no company account of its own in this build, so personal money is not shown as company money",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_lower_case_uuid_names_a_business() {
        assert_eq!(
            business_id("business:0a1b2c3d-0000-4000-8000-00000000000f"),
            Some("0a1b2c3d-0000-4000-8000-00000000000f")
        );
        assert_eq!(
            business_id("business:0A1B2C3D-0000-4000-8000-00000000000F"),
            None
        );
        assert_eq!(business_id("business:nope"), None);
        assert_eq!(business_id("personal"), None);
    }

    #[test]
    fn personal_or_none_reads_nothing() {
        let down = Store::Down("no database".to_owned());
        assert!(personal_only(&down, "u", None).is_ok());
        assert!(personal_only(&down, "u", Some("personal")).is_ok());
        assert!(matches!(
            personal_only(&down, "u", Some("business:x")),
            Err(Refusal::Bank(e)) if e.row.code == "bank.profile_not_held"
        ));
    }
}
