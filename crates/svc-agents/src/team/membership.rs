//! A business's team, read from svc-bank over S2S (`POST /internal/agents/team-membership`, `team/membership.ts`). The
//! person names the business; svc-bank answers its members only when the person is one of them. svc-agents never
//! stores who is a member: every team call reads it again. A failed read refuses `agents.membership_unavailable`; it is
//! never an empty team.

use std::sync::Arc;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::s2s::CallSigner;
use service_kit::schema::js_trim;

use super::{TeamError, team_error};

/// `AGENTS_TEAM_MEMBERSHIP_PATH`.
pub const TEAM_MEMBERSHIP_PATH: &str = "/internal/agents/team-membership";

/// `AGENTS_TEAM_BUSINESS_ROLES`: the roles a business member holds in svc-bank.
pub const BUSINESS_ROLES: [&str; 8] = [
    "admin",
    "maker",
    "checker",
    "signer",
    "editor",
    "viewer",
    "security_auditor",
    "non_signing_admin",
];

/// One member (`AgentsTeamMember`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub user_id: String,
    pub role: String,
}

/// `AgentsTeamMembershipResponse`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Membership {
    Team {
        business_id: String,
        /// The asking person's own role on the business.
        role: String,
        members: Vec<Member>,
    },
    NotMember,
    BusinessClosed,
}

/// `TeamMembershipPort`. Any failure is the port's to name; `readTeam` makes every other one unavailable.
pub trait TeamMembership: Send + Sync {
    fn read(&self, user_id: &str, business_id: &str) -> Result<Membership, TeamError>;
}

fn unavailable() -> TeamError {
    team_error(
        "agents.membership_unavailable",
        "Business team could not be read from svc-bank",
    )
}

/// zod's `uuid()`: RFC 9562 versions 1 to 8 with the variant bits, or the nil or max id.
pub fn is_zod_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if s == "00000000-0000-0000-0000-000000000000"
        || s.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff")
    {
        return true;
    }
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
        && b.get(14).is_some_and(|c| (b'1'..=b'8').contains(c))
        && b.get(19).is_some_and(|c| b"89abAB".contains(c))
}

fn keys_are(o: &Json, allowed: &[&str]) -> bool {
    match o {
        Json::Object(fields) => fields.iter().all(|(k, _)| allowed.contains(&k.as_str())),
        _ => false,
    }
}

fn role_of(v: Option<&Json>) -> Option<String> {
    match v {
        Some(Json::String(r)) if BUSINESS_ROLES.contains(&r.as_str()) => Some(r.clone()),
        _ => None,
    }
}

fn member_of(v: &Json) -> Option<Member> {
    if !keys_are(v, &["userId", "role"]) {
        return None;
    }
    let Some(Json::String(raw)) = v.get("userId") else {
        return None;
    };
    let user_id = js_trim(raw);
    if user_id.is_empty() || user_id.encode_utf16().count() > 128 {
        return None;
    }
    Some(Member {
        user_id: user_id.to_owned(),
        role: role_of(v.get("role"))?,
    })
}

/// `agentsTeamMembershipResponseSchema`, strict: anything else is none.
pub fn parse_answer(answer: &Json) -> Option<Membership> {
    match answer.get("ok") {
        Some(Json::Bool(false)) if keys_are(answer, &["ok", "reason"]) => {
            match answer.get("reason") {
                Some(Json::String(r)) if r == "not_member" => Some(Membership::NotMember),
                Some(Json::String(r)) if r == "business_closed" => Some(Membership::BusinessClosed),
                _ => None,
            }
        }
        Some(Json::Bool(true)) if keys_are(answer, &["ok", "businessId", "role", "members"]) => {
            let Some(Json::String(business_id)) = answer.get("businessId") else {
                return None;
            };
            if !is_zod_uuid(business_id) {
                return None;
            }
            let role = role_of(answer.get("role"))?;
            let Some(Json::Array(items)) = answer.get("members") else {
                return None;
            };
            if !(1..=200).contains(&items.len()) {
                return None;
            }
            let members = items.iter().map(member_of).collect::<Option<Vec<_>>>()?;
            Some(Membership::Team {
                business_id: business_id.clone(),
                role,
                members,
            })
        }
        _ => None,
    }
}

/// `createHttpTeamMembershipPort`: svc-bank's door, signed as svc-agents for svc-bank.
pub struct TeamMembershipHttp {
    pub url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
}

impl TeamMembershipHttp {
    pub fn new(bank_url: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> TeamMembershipHttp {
        TeamMembershipHttp {
            url: format!("{}{TEAM_MEMBERSHIP_PATH}", bank_url.trim_end_matches('/')),
            signer,
            fetch,
        }
    }
}

impl TeamMembership for TeamMembershipHttp {
    fn read(&self, user_id: &str, business_id: &str) -> Result<Membership, TeamError> {
        let body = Json::obj([
            ("userId", Json::str(user_id)),
            ("businessId", Json::str(business_id)),
        ])
        .compact();
        let headers = self
            .signer
            .sign(&body, "POST", TEAM_MEMBERSHIP_PATH, "application/json")
            .map_err(|_| unavailable())?;
        let mut all = vec![
            ("accept".to_owned(), "application/json".to_owned()),
            ("content-type".to_owned(), "application/json".to_owned()),
        ];
        all.extend(headers);
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: self.url.clone(),
                headers: all,
                body: Some(body),
                timeout_ms: None,
                refuse_redirect: false,
            })
            .map_err(|_| unavailable())?;
        if !res.ok() {
            return Err(unavailable());
        }
        let answer = json::parse(&res.body).map_err(|_| unavailable())?;
        let parsed = parse_answer(&answer).ok_or_else(unavailable)?;
        // svc-bank's answer must be about the business asked for; any other is not this team.
        if let Membership::Team { business_id: b, .. } = &parsed
            && *b != business_id.to_lowercase()
        {
            return Err(unavailable());
        }
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use std::sync::Mutex;

    use service_kit::http::{FetchError, HttpResponse};

    use super::*;

    const USER: &str = "22222222-2222-4222-8222-222222222222";
    const BUSINESS: &str = "33333333-3333-4333-8333-333333333333";
    const OTHER: &str = "44444444-4444-4444-8444-444444444444";

    struct Canned {
        answer: Result<(u16, String), ()>,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl Fetch for Canned {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            self.seen.lock().unwrap().push(req.clone());
            match &self.answer {
                Ok((status, body)) => Ok(HttpResponse {
                    status: *status,
                    body: body.clone(),
                }),
                Err(()) => Err(FetchError {
                    message: "connect ECONNREFUSED".to_owned(),
                }),
            }
        }
    }

    fn port(answer: Result<(u16, String), ()>) -> (TeamMembershipHttp, Arc<Canned>) {
        let canned = Arc::new(Canned {
            answer,
            seen: Mutex::new(Vec::new()),
        });
        (
            TeamMembershipHttp::new(
                "http://bank.test/",
                CallSigner::new(
                    "svc-agents",
                    "svc-bank",
                    "internal-secret-for-agents-team-port-test",
                    None,
                ),
                canned.clone(),
            ),
            canned,
        )
    }

    fn team_body(business: &str) -> String {
        format!(
            r#"{{"ok":true,"businessId":"{business}","role":"admin","members":[{{"userId":"{USER}","role":"admin"}}]}}"#
        )
    }

    #[test]
    fn posts_the_persons_id_and_the_business_signed_as_svc_agents_and_returns_svc_banks_answer() {
        let (p, seen) = port(Ok((200, team_body(BUSINESS))));
        assert_eq!(
            p.read(USER, BUSINESS).unwrap(),
            Membership::Team {
                business_id: BUSINESS.to_owned(),
                role: "admin".to_owned(),
                members: vec![Member {
                    user_id: USER.to_owned(),
                    role: "admin".to_owned()
                }],
            }
        );
        let seen = seen.seen.lock().unwrap();
        assert_eq!(
            seen[0].url,
            "http://bank.test/internal/agents/team-membership"
        );
        assert_eq!(
            seen[0].body.as_deref(),
            Some(format!(r#"{{"userId":"{USER}","businessId":"{BUSINESS}"}}"#).as_str())
        );
        assert!(
            seen[0]
                .headers
                .iter()
                .any(|(_, v)| v.contains("svc-agents"))
        );
    }

    #[test]
    fn passes_not_member_and_business_closed_through_as_svc_bank_said_them() {
        for (reason, want) in [
            ("not_member", Membership::NotMember),
            ("business_closed", Membership::BusinessClosed),
        ] {
            let (p, _) = port(Ok((200, format!(r#"{{"ok":false,"reason":"{reason}"}}"#))));
            assert_eq!(p.read(USER, BUSINESS).unwrap(), want);
        }
    }

    #[test]
    fn refuses_membership_unavailable_on_a_network_failure_a_non_200_an_off_contract_body_or_another_business()
     {
        for answer in [
            Err(()),
            Ok((503, "{}".to_owned())),
            Ok((
                200,
                format!(r#"{{"ok":true,"businessId":"{BUSINESS}","role":"admin","members":[]}}"#),
            )),
            Ok((200, team_body(OTHER))),
        ] {
            let (p, _) = port(answer);
            assert_eq!(
                p.read(USER, BUSINESS).unwrap_err().code,
                "agents.membership_unavailable"
            );
        }
    }
}
