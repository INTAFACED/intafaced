//! The owner's own freeze as every agent action of an own agent meets it (`own/self-freeze.ts`, `assertNotSelfFrozen`),
//! and the owner's account as an approval reads it (`own/identity.ts`, `assertOwnerActive`). Both fail closed: no
//! reader wired, identity down or an answer outside its record refuses as frozen or unread. The freeze is read through
//! the one reader the runtime holds (`crate::self_freeze`); the `selfFreezeApplied` consumer is `own-sharing`'s.

use super::OwnRefusal;
use super::desk::{DeskAccount, SupportDesk};
use crate::self_freeze::{OWNER_FREEZE_UNREAD, OWNER_FROZEN_SELF, Reading, SelfFreezeRead};

/// `assertNotSelfFrozen`.
pub fn assert_not_self_frozen(
    user_id: &str,
    freeze: Option<&dyn SelfFreezeRead>,
) -> Result<(), OwnRefusal> {
    let Some(freeze) = freeze else {
        return Err(OwnRefusal::new(OWNER_FREEZE_UNREAD));
    };
    match freeze.read(user_id) {
        Err(_) => Err(OwnRefusal::new(OWNER_FREEZE_UNREAD)),
        Ok(Reading::Open) => Ok(()),
        Ok(Reading::Frozen { since }) => Err(match since {
            Some(s) => OwnRefusal::with(OWNER_FROZEN_SELF, [("since", s)]),
            None => OwnRefusal::new(OWNER_FROZEN_SELF),
        }),
    }
}

/// `assertOwnerActive`: the owner's account reads active from identity, then their own freeze is not on.
pub fn assert_owner_active(
    owner_id: &str,
    accounts: Option<&dyn SupportDesk>,
    freeze: Option<&dyn SelfFreezeRead>,
) -> Result<(), OwnRefusal> {
    let read = accounts.map_or(DeskAccount::Unread, |a| a.read_account(owner_id));
    let DeskAccount::Ok { status, .. } = read else {
        return Err(OwnRefusal::new("agents.identity.owner_unread"));
    };
    if status == "frozen" {
        return Err(OwnRefusal::new("agents.identity.owner_frozen"));
    }
    if status != "active" {
        return Err(OwnRefusal::new("agents.identity.owner_inactive"));
    }
    assert_not_self_frozen(owner_id, freeze)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::self_freeze::Unavailable;

    struct Fixed(Result<Reading, Unavailable>);
    impl SelfFreezeRead for Fixed {
        fn read(&self, _: &str) -> Result<Reading, Unavailable> {
            self.0.clone()
        }
    }

    #[test]
    fn an_unread_or_open_freeze_refuses_and_only_a_read_lift_passes() {
        let code =
            |f: Option<&dyn SelfFreezeRead>| assert_not_self_frozen("u", f).err().map(|r| r.code);
        assert_eq!(code(None).as_deref(), Some(OWNER_FREEZE_UNREAD));
        let down = Fixed(Err(Unavailable("down".to_owned())));
        assert_eq!(code(Some(&down)).as_deref(), Some(OWNER_FREEZE_UNREAD));
        let frozen = Fixed(Ok(Reading::Frozen { since: None }));
        assert_eq!(code(Some(&frozen)).as_deref(), Some(OWNER_FROZEN_SELF));
        assert_eq!(code(Some(&Fixed(Ok(Reading::Open)))), None);
    }
}
