//! The owner's own freeze as every agent action reads it (`own/self-freeze.ts`, the read half), and the owner's account
//! as an approval reads it (`own/identity.ts`, `assertOwnerActive`). Both fail closed: no reader wired, identity down
//! or an answer outside its record refuses as frozen or unread. The `selfFreezeApplied` consumer is `own-sharing`'s.

use std::sync::Arc;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::s2s::CallSigner;
use service_kit::tokens::is_guid;

use super::OwnRefusal;
use super::desk::{DeskAccount, SupportDesk};

pub const OWNER_FROZEN_SELF: &str = "agents.identity.owner_frozen_self";
pub const OWNER_FREEZE_UNREAD: &str = "agents.identity.owner_freeze_unread";

/// `SelfFreezeReading`: open with its start (none when identity sent none), or not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reading {
    Free,
    Frozen { since: Option<String> },
}

/// `SelfFreezeUnavailable`: identity could not be asked, or answered outside its contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unavailable(pub String);

/// `OwnSelfFreezeRead`.
pub trait SelfFreezeRead: Send + Sync {
    fn read(&self, user_id: &str) -> Result<Reading, Unavailable>;
}

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
        Ok(Reading::Free) => Ok(()),
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

const FETCH_MS: u64 = 3_000;

/// `createIdentitySelfFreezeRead`: `GET /internal/self-freeze/:userId` on svc-identity, signed as svc-agents.
pub struct IdentitySelfFreeze {
    pub base_url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
}

fn encode_uri_component(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// `z.string().datetime({ offset: true })`: a date, a time with optional fractions, and `Z` or an offset.
fn is_datetime(s: &str) -> bool {
    service_kit::jsregex::Regex::new(
        r"/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/",
    )
    .is_ok_and(|r| r.test(s))
}

impl SelfFreezeRead for IdentitySelfFreeze {
    fn read(&self, user_id: &str) -> Result<Reading, Unavailable> {
        let base = self.base_url.trim_end_matches('/');
        let path = format!("/internal/self-freeze/{}", encode_uri_component(user_id));
        let headers = self
            .signer
            .sign("", "GET", &path, "")
            .map_err(Unavailable)?;
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url: format!("{base}{path}"),
                headers,
                body: None,
                timeout_ms: Some(FETCH_MS),
                refuse_redirect: false,
            })
            .map_err(|_| Unavailable("identity did not answer the freeze read".to_owned()))?;
        if !res.ok() {
            return Err(Unavailable(format!(
                "identity refused the freeze read ({})",
                res.status
            )));
        }
        let off =
            || Unavailable("identity answered the freeze read outside its contract".to_owned());
        // `selfFreezeStateSchema`, strict: exactly userId, frozen and since.
        let body = json::parse(&res.body).map_err(|_| off())?;
        let Json::Object(fields) = &body else {
            return Err(off());
        };
        if fields
            .iter()
            .any(|(k, _)| !matches!(k.as_str(), "userId" | "frozen" | "since"))
        {
            return Err(off());
        }
        let (Some(Json::String(id)), Some(Json::Bool(frozen)), Some(since)) =
            (body.get("userId"), body.get("frozen"), body.get("since"))
        else {
            return Err(off());
        };
        let since = match since {
            Json::Null => None,
            Json::String(s) if is_datetime(s) => Some(s.clone()),
            _ => return Err(off()),
        };
        if !is_guid(id) || id.to_lowercase() != user_id.to_lowercase() {
            return Err(off());
        }
        Ok(if *frozen {
            Reading::Frozen { since }
        } else {
            Reading::Free
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(code(Some(&Fixed(Ok(Reading::Free)))), None);
    }

    #[test]
    fn a_datetime_needs_its_zone() {
        assert!(is_datetime("2026-01-01T00:00:00.000Z"));
        assert!(is_datetime("2026-01-01T00:00:00+08:00"));
        assert!(!is_datetime("2026-01-01T00:00:00"));
    }
}
