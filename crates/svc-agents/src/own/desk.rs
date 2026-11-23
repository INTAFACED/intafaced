//! The support desk as an own agent's tools reach it: the port (`support-agent/desk-port.ts`, `SupportDeskPort`) and
//! its HTTP client, the comment's own limits (`support-agent/comment-draft.ts`) and the help search as
//! `invokeSupportDataTool` (`support-agent/data-tools.ts`) runs it for `support.kb.search`.
//!
//! Only what the own agent's doors call is here: the help search, the comment on the person's own request and the
//! owner's account read. The ticket and article reads (`readTicket`, `getKb`) are the support agent's, ported with
//! the factories. Nothing is invented: a desk that cannot be reached, or answers outside its record, reads as
//! unreachable or unread, never as an empty result or an active account.

use std::sync::Arc;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::jsregex::Regex;
use service_kit::s2s::{CallSigner, js_length};
use service_kit::schema::js_trim;
use service_kit::tokens::is_guid;

use crate::runtime::eligibility::Law;

/// A KB article as the desk stores it: i18n keys, never prose (`KbArticleFixture`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Article {
    pub article_key: String,
    pub title_key: String,
    pub body_key: String,
}

impl Article {
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("articleKey", Json::str(self.article_key.clone())),
            ("titleKey", Json::str(self.title_key.clone())),
            ("bodyKey", Json::str(self.body_key.clone())),
        ])
    }
}

/// `DeskSearchResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeskSearch {
    Ok(Vec<Article>),
    Unreachable,
    /// `kb_search_limit_unset`.
    LimitUnset,
}

/// `DeskAccountResult`: the owner's account projection, status and KYC tier only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeskAccount {
    Ok {
        user_id: String,
        status: String,
        kyc_tier: String,
    },
    Unread,
    Unreachable,
}

/// `DeskCommentResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeskComment {
    Ok { id: String, ticket_id: String },
    Missing,
    Refused(String),
    Unreachable,
}

/// One comment asked of the desk, on the request's own key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentInput {
    pub ticket_id: String,
    pub body: String,
    pub client_request_id: String,
}

/// `SupportDeskPort`, as far as the own agent's doors call it.
pub trait SupportDesk: Send + Sync {
    /// `searchKb(query, limit)`: a missing page size refuses, never 100.
    fn search_kb(&self, query: &str, limit: Option<i64>) -> DeskSearch;
    /// `readAccount(userId)`: identity's projection of the account.
    fn read_account(&self, user_id: &str) -> DeskAccount;
    /// Whether `commentTicket` is wired: without it the comment's door is not.
    fn comments(&self) -> bool {
        true
    }
    /// `commentTicket(input, headers)`, as the person (their forwarded principal), on `clientRequestId`.
    fn comment_ticket(&self, input: &CommentInput, headers: &[(String, String)]) -> DeskComment;
}

/// `assertKbSearchPageLimit`: a finite number of at least 1, floored and held to 500; anything else is unset.
pub fn kb_search_page(limit: Option<i64>) -> Option<i64> {
    limit.filter(|n| *n >= 1).map(|n| n.min(500))
}

// ── The comment's own limits (`draftTicketComment`) ──────────────────────────

const MAX_BODY: usize = 4_000;

/// `MONEY_INVENT`, `i`-flagged in the TypeScript: matched over the ASCII-lowercased text, which is what the flag reads
/// without `u` (no character above 127 folds to one below it).
const MONEY_INVENT: &str = r"/\b(i (have )?refunded|balance (is|now) \d+|credited \$?\d+|wired \$?\d+|sent you \$?\d+|payout of)\b/";

/// `CommentDraftResult`: the trimmed ticket and body, or the refusal's reason.
pub fn draft_ticket_comment(
    ticket_id: Option<&str>,
    body: Option<&str>,
) -> Result<(String, String), &'static str> {
    let ticket = js_trim(ticket_id.unwrap_or(""));
    if ticket.is_empty() {
        return Err("missing_ticket");
    }
    let body = js_trim(body.unwrap_or(""));
    if js_length(body) < 1 {
        return Err("empty_body");
    }
    if js_length(body) > MAX_BODY {
        return Err("body_too_long");
    }
    let invent = Regex::new(MONEY_INVENT).is_ok_and(|r| r.test(&body.to_ascii_lowercase()));
    if invent {
        return Err("money_invent_language");
    }
    Ok((ticket.to_owned(), body.to_owned()))
}

// ── The help search (`invokeSupportDataTool` for `support.kb.search`) ───────

/// `SupportDataToolResult` for the help search: the articles, or the refusal's reason.
pub type KbSearch = Result<Vec<Article>, &'static str>;

/// The answer the tool's call records: `{ status: 'ok', tool, articles }`.
pub fn kb_result_json(articles: &[Article]) -> Json {
    Json::obj([
        ("status", Json::str("ok")),
        ("tool", Json::str("support.kb.search")),
        (
            "articles",
            Json::Array(articles.iter().map(Article::to_json).collect()),
        ),
    ])
}

/// `isKeyLike`: an i18n key, not a sentence someone typed.
fn is_key_like(value: &str) -> bool {
    Regex::new(r"/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/")
        .is_ok_and(|r| r.test(&js_trim(value).to_ascii_lowercase()))
}

/// `supportTierGate`: the tools the person's tier is granted, or why none are.
fn tier_tools<'a>(law: Option<&'a Law>, tier: &str) -> Result<&'a [String], &'static str> {
    let Some(Law::Published(matrix)) = law else {
        return Err("tier_law_blank");
    };
    if matrix.is_empty() {
        return Err("tier_law_blank");
    }
    let tier = js_trim(tier);
    if tier.is_empty() {
        return Err("tier_not_granted");
    }
    matrix
        .iter()
        .find(|(t, _)| t == tier)
        .map(|(_, g)| g.tools.as_slice())
        .ok_or("tier_not_granted")
}

/// `invokeSupportDataTool({ tool: 'support.kb.search', plane: desk ? 'live' : 'dark', ... })`: the plane, the tier
/// law, the tier's grant, the requester, then the desk's search with the owner's page size.
pub fn kb_search(
    desk: Option<&dyn SupportDesk>,
    law: Option<&Law>,
    requester: &str,
    tier: &str,
    query: &str,
    limit: Option<i64>,
) -> KbSearch {
    const TOOL: &str = "support.kb.search";
    // `supportGrounded({ plane })`: no desk is the dark plane.
    let Some(desk) = desk else {
        return Err("desk_plane_dark");
    };
    let allowed = tier_tools(law, tier)?;
    if !allowed.iter().any(|t| t == TOOL) {
        return Err("tool_not_in_tier");
    }
    if js_trim(requester).is_empty() {
        return Err("missing_requester");
    }
    let Some(page) = kb_search_page(limit) else {
        return Err("kb_search_limit_unset");
    };
    match desk.search_kb(query, Some(page)) {
        DeskSearch::LimitUnset => Err("kb_search_limit_unset"),
        DeskSearch::Unreachable => Err("no_live_kb"),
        DeskSearch::Ok(articles) => {
            if articles.is_empty() {
                return Err("kb_empty");
            }
            if articles.iter().any(|a| {
                !is_key_like(&a.article_key)
                    || !is_key_like(&a.title_key)
                    || !is_key_like(&a.body_key)
            }) {
                return Err("incomplete_article");
            }
            Ok(articles)
        }
    }
}

// ── The HTTP desk (`createHttpSupportDeskPort`) ──────────────────────────────

/// `encodeURIComponent`.
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

/// `unwrapTrpc`: `result.data`, or its `json` when the reply is superjson's.
fn unwrap_trpc(body: Json) -> Json {
    match body.get("result").and_then(|r| r.get("data")) {
        Some(data) => match data.get("json") {
            Some(inner) if matches!(data, Json::Object(_)) => inner.clone(),
            _ => data.clone(),
        },
        None => body,
    }
}

fn str_field<'a>(v: &'a Json, key: &str) -> Option<&'a str> {
    match v.get(key) {
        Some(Json::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

fn optional_is(v: &Json, key: &str, ok: impl Fn(&Json) -> bool) -> bool {
    v.get(key).is_none_or(&ok)
}

fn text_between(v: &Json, min: usize, max: usize) -> bool {
    matches!(v, Json::String(s) if (min..=max).contains(&js_length(s)))
}

fn positive_int(v: &Json) -> bool {
    matches!(v, Json::Number(n) if n.fract() == 0.0 && *n > 0.0)
}

/// `supportKbArticleSchema.safeParse`, as far as its fields are typed: the three keys present and non-empty, and
/// every optional field present only with its type.
fn article_of(v: &Json) -> Option<Article> {
    if !matches!(v, Json::Object(_)) {
        return None;
    }
    let non_empty = |k: &str| str_field(v, k).filter(|s| !s.is_empty()).map(str::to_owned);
    let typed = optional_is(v, "version", positive_int)
        && optional_is(v, "revision", positive_int)
        && optional_is(v, "published", |j| matches!(j, Json::Bool(_)))
        && optional_is(v, "category", |j| text_between(j, 1, 200))
        && optional_is(
            v,
            "tags",
            |j| matches!(j, Json::Array(items) if items.len() <= 20 && items.iter().all(|t| text_between(t, 1, 200))),
        )
        && optional_is(v, "language", |j| text_between(j, 2, 32))
        && optional_is(v, "title", |j| text_between(j, 1, usize::MAX))
        && optional_is(v, "body", |j| text_between(j, 1, usize::MAX));
    if !typed {
        return None;
    }
    Some(Article {
        article_key: non_empty("id")?,
        title_key: non_empty("titleKey")?,
        body_key: non_empty("bodyKey")?,
    })
}

/// svc-support's desk and identity's account read, signed as svc-agents.
pub struct SupportDeskHttp {
    pub support_url: String,
    /// `IDENTITY_URL`; blank reads every account as unread.
    pub identity_url: Option<String>,
    /// Signs the identity account read for svc-identity.
    pub identity_signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
}

impl SupportDeskHttp {
    fn base(&self) -> &str {
        self.support_url.trim_end_matches('/')
    }
}

impl SupportDesk for SupportDeskHttp {
    fn search_kb(&self, query: &str, limit: Option<i64>) -> DeskSearch {
        let Some(page) = kb_search_page(limit) else {
            return DeskSearch::LimitUnset;
        };
        let input = Json::obj([("q", Json::str(query)), ("limit", Json::int(page))]).compact();
        let res = self.fetch.fetch(&HttpRequest {
            method: "GET".to_owned(),
            url: format!(
                "{}/trpc/searchKb?input={}",
                self.base(),
                encode_uri_component(&input)
            ),
            headers: vec![("accept".to_owned(), "application/json".to_owned())],
            body: None,
            timeout_ms: None,
            refuse_redirect: false,
        });
        let Ok(res) = res else {
            return DeskSearch::Unreachable;
        };
        if !res.ok() {
            return DeskSearch::Unreachable;
        }
        let body = json::parse(&res.body).unwrap_or(Json::Null);
        let Json::Array(items) = unwrap_trpc(body) else {
            return DeskSearch::Unreachable;
        };
        items
            .iter()
            .map(article_of)
            .collect::<Option<Vec<_>>>()
            .map_or(DeskSearch::Unreachable, DeskSearch::Ok)
    }

    fn read_account(&self, user_id: &str) -> DeskAccount {
        let Some(base) = self
            .identity_url
            .as_deref()
            .map(|u| u.trim_end_matches('/'))
            .filter(|u| !u.is_empty())
        else {
            return DeskAccount::Unread;
        };
        let path = format!("/internal/account/{}", encode_uri_component(user_id));
        let Ok(signed) = self
            .identity_signer
            .sign("", "GET", &path, "application/json")
        else {
            return DeskAccount::Unreachable;
        };
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        headers.extend(signed);
        let Ok(res) = self.fetch.fetch(&HttpRequest {
            method: "GET".to_owned(),
            url: format!("{base}{path}"),
            headers,
            body: None,
            timeout_ms: None,
            refuse_redirect: false,
        }) else {
            return DeskAccount::Unreachable;
        };
        if !res.ok() {
            return DeskAccount::Unread;
        }
        // `accountStateSchema`: a guid, one of three states, one of four tiers, and `archived` a boolean if sent.
        let body = json::parse(&res.body).unwrap_or(Json::Null);
        let (Some(id), Some(status), Some(tier)) = (
            str_field(&body, "userId"),
            str_field(&body, "status"),
            str_field(&body, "kycTier"),
        ) else {
            return DeskAccount::Unread;
        };
        let shaped = is_guid(id)
            && ["active", "frozen", "closed"].contains(&status)
            && ["none", "basic", "full", "institutional"].contains(&tier)
            && optional_is(&body, "archived", |j| matches!(j, Json::Bool(_)));
        if !shaped || id != user_id {
            return DeskAccount::Unread;
        }
        DeskAccount::Ok {
            user_id: id.to_owned(),
            status: status.to_owned(),
            kyc_tier: tier.to_owned(),
        }
    }

    fn comment_ticket(&self, input: &CommentInput, forwarded: &[(String, String)]) -> DeskComment {
        let body = Json::obj([
            ("ticketId", Json::str(input.ticket_id.clone())),
            ("body", Json::str(input.body.clone())),
            (
                "clientRequestId",
                Json::str(input.client_request_id.clone()),
            ),
        ])
        .compact();
        let mut headers = vec![
            ("accept".to_owned(), "application/json".to_owned()),
            ("content-type".to_owned(), "application/json".to_owned()),
        ];
        headers.extend(forwarded.iter().cloned());
        let Ok(res) = self.fetch.fetch(&HttpRequest {
            method: "POST".to_owned(),
            url: format!("{}/trpc/comment", self.base()),
            headers,
            body: Some(body),
            timeout_ms: None,
            refuse_redirect: false,
        }) else {
            return DeskComment::Unreachable;
        };
        if res.status == 404 {
            return DeskComment::Missing;
        }
        if !res.ok() {
            return if (400..500).contains(&res.status) {
                DeskComment::Refused("desk_refused".to_owned())
            } else {
                DeskComment::Unreachable
            };
        }
        // `supportCommentSchema`, as far as the answer reads it: its id and ticket are guids, and the ticket is ours.
        let reply = unwrap_trpc(json::parse(&res.body).unwrap_or(Json::Null));
        let shaped = ["id", "ticketId", "authorId"]
            .iter()
            .all(|k| str_field(&reply, k).is_some_and(is_guid))
            && str_field(&reply, "authorRole").is_some_and(|r| r == "user" || r == "operator")
            && str_field(&reply, "visibility").is_some_and(|v| v == "public" || v == "internal")
            && reply
                .get("body")
                .is_some_and(|b| text_between(b, 1, 10_000))
            && str_field(&reply, "createdAt").is_some();
        match (
            shaped,
            str_field(&reply, "id"),
            str_field(&reply, "ticketId"),
        ) {
            (true, Some(id), Some(ticket)) if ticket == input.ticket_id => DeskComment::Ok {
                id: id.to_owned(),
                ticket_id: ticket.to_owned(),
            },
            _ => DeskComment::Unreachable,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_comment_is_drafted_only_from_a_real_ticket_and_body_that_invent_no_money() {
        assert_eq!(
            draft_ticket_comment(Some(" t "), Some(" b ")),
            Ok(("t".to_owned(), "b".to_owned()))
        );
        assert_eq!(draft_ticket_comment(None, Some("b")), Err("missing_ticket"));
        assert_eq!(
            draft_ticket_comment(Some("t"), Some("  ")),
            Err("empty_body")
        );
        assert_eq!(
            draft_ticket_comment(Some("t"), Some(&"x".repeat(4001))),
            Err("body_too_long")
        );
        for body in [
            "I have REFUNDED you",
            "your balance is 40",
            "Credited $5 today",
            "a payout of",
        ] {
            assert_eq!(
                draft_ticket_comment(Some("t"), Some(body)),
                Err("money_invent_language"),
                "{body}"
            );
        }
    }

    #[test]
    fn the_page_size_is_never_invented() {
        assert_eq!(kb_search_page(None), None);
        assert_eq!(kb_search_page(Some(0)), None);
        assert_eq!(kb_search_page(Some(5)), Some(5));
        assert_eq!(kb_search_page(Some(9_000)), Some(500));
    }
}
