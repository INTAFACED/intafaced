//! svc-agents' read of a business team (\`agents/team-membership.ts\`, now \`business::team\`) and svc-identity's business
//! directory client (\`business/business-directory.ts\`, now \`spaces::ports::DirectoryHttp\`) against the Rust code on a real
//! Postgres. Ports \`services/svc-bank/src/agents/team-membership.pg.test.ts\` whole, and the tests of
//! \`business/business-directory.test.ts\` and \`business/business-directory-keys.test.ts\` that no Rust test covered yet
//! (none in \`spaces/\` or \`tests/\` exercised \`DirectoryHttp\`; \`spaces::shared\`'s unit test of the query shapes checks
//! other values than the TypeScript's), each test named after the TypeScript test's words.
//!
//! \`teamMembershipFor(db.sql, ...)\` is \`team::read\` over the door's store; a call through Fastify's \`app.inject\` is the
//! REST door (\`POST /internal/agents/team-membership\`) signed as the TypeScript signs it. Each test has its own database,
//! seeded as the TypeScript's \`beforeEach\` seeds it. A directory call the TypeScript makes on the client is made on
//! \`DirectoryHttp\` (or \`NoDirectory\`) here; where the TypeScript checks the error's message, the message is the one
//! the business slice refuses with (\`directoryError\` in the TypeScript passes the client's message on as the
//! \`BankError\`'s), read from \`business::service\` given a door wired with that client. Without \`TEST_DATABASE_URL\` a
//! test that needs the database skips; with \`REQUIRE_POSTGRES=1\` it fails.
//!
//! Not ported as written:
//! - "lists the same roles as svc-bank": the Rust port has one role list (\`policy::ROLES\`), which the contract check
//!   (\`team::checked\`) also reads, so the two lists cannot differ. It is checked against the database's own enum
//!   (\`bank.business_member_role\`) instead, and every role is shown to pass the contract check.
//! - The HTTP tests' injected \`read\`: the Rust door reads the database itself (\`team::answer\`), with no seam for a stand-in
//!   read. So "without reading" is shown by breaking the table first (a read would answer 503); "the read throws
//!   \`TeamMembershipIncomplete\`" is a team over the cap in the database; "the read fails" is the members table renamed
//!   away; "the read breaks the contract" is a member whose id the contract refuses (a blank id), and the TypeScript's
//!   own broken answer (\`members: []\`) is given to \`team::checked\`.
//! - "a memory directory is exact and hides frozen accounts on lookup": it tests the TypeScript's test double
//!   (\`memoryBusinessDirectory\`), not the client the slice ships; its Rust counterpart is the suites' stand-in
//!   (\`business_kit::People\`), test code too.
//! - "treats a badly shaped handle or email as no query": \`normaliseHandleQuery\` and \`normaliseEmailQuery\` are
//!   \`pub(crate)\` in Rust (\`spaces::shared::handle_query\`, \`email_query\`), so each value is put through
//!   \`business.resolveRecipientSpace\`: a badly shaped one is a miss the directory is never asked, a good one reaches the
//!   directory as exactly the TypeScript's normalised query.
//! - The keys suite's Ed25519 key is RFC 8032's first test vector, not one generated per run: svc-bank's tests have no
//!   Ed25519 crate to derive a public key. \`x-intafaced-signature\` (a header neither signer sends) is checked absent as
//!   written, and the shared secret's real signature header (\`x-intafaced-service-sig\`) beside it.
//! - "reads identity ..." pins the clock on the signer (\`CallSigner::clock\`) instead of faking \`Date\`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use service_kit::http::{FETCH_FAILED, Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::Json;
use service_kit::s2s::{
    self, CallSigner, KeyringEntry, Mode, SERVICE_HEADER, SERVICE_SIGNATURE_HEADER, ServiceSigner,
    system_seconds,
};
use service_kit::s2s_verify::{BodyBind, Incoming, RequestAuth, ServiceVerifier, verify_request};
use svc_bank::business::policy::ROLES;
use svc_bank::business::service as svc;
use svc_bank::business::team::{self, MAX, TeamError};
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::ports::{
    DirError, Directory, DirectoryHttp, HANDLES_PATH, Lookup, Lookups, NoDirectory, RECIPIENT_PATH,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::Rules;
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::{Settings, Wiring as TransfersWiring};

use crate::business_kit::{Bank, Book, FakeIdentity, INTERNAL, Identity, SECRET, bank, j, rest};
use crate::support::TestDb;

const ADMIN: &str = "11111111-1111-4111-8111-111111111111";
const MAKER: &str = "22222222-2222-4222-8222-222222222222";
const VIEWER: &str = "33333333-3333-4333-8333-333333333333";
const OUTSIDER: &str = "44444444-4444-4444-8444-444444444444";
const UNKNOWN: &str = "55555555-5555-4555-8555-555555555555";
const TEAM_URL: &str = "/internal/agents/team-membership";

// ---------------------------------------------------------------------------------------------------------------
// team-membership.pg.test.ts

/// The seeded database: \`(business, other)\`.
struct Seeded {
    b: Bank,
    business: String,
    other: String,
}

fn open(c: &mut postgres::Client, name: &str) -> String {
    c.query_one(
        "INSERT INTO bank.business_accounts (name, asset_id, spend_threshold) VALUES ($1, 'IFC', 100) RETURNING id::text",
        &[&name],
    )
    .unwrap()
    .get(0)
}

fn member(c: &mut postgres::Client, account: &str, user: &str, role: &str, ago: &str) {
    c.execute(
        "INSERT INTO bank.business_members (account_id, user_id, role, created_at) \
         VALUES ($1::text::uuid, $2, $3::text::bank.business_member_role, now() - $4::text::interval)",
        &[&account, &user, &role, &ago],
    )
    .unwrap();
}

/// \`beforeEach\`.
fn seeded() -> Option<Seeded> {
    let b = bank()?;
    let mut c = b.sql();
    let business = open(&mut c, "TEST team");
    let other = open(&mut c, "TEST other");
    member(&mut c, &business, ADMIN, "admin", "10 minutes");
    member(&mut c, &business, VIEWER, "viewer", "2 minutes");
    member(&mut c, &business, MAKER, "maker", "5 minutes");
    member(&mut c, &other, OUTSIDER, "admin", "1 minute");
    Some(Seeded { b, business, other })
}

fn team_json() -> String {
    format!(
        r#"[{{"userId":"{ADMIN}","role":"admin"}},{{"userId":"{MAKER}","role":"maker"}},{{"userId":"{VIEWER}","role":"viewer"}}]"#
    )
}

fn whole(business: &str, role: &str) -> Json {
    j(&format!(
        r#"{{"ok":true,"businessId":"{business}","role":"{role}","members":{}}}"#,
        team_json()
    ))
}

fn not_member() -> Json {
    j(r#"{"ok":false,"reason":"not_member"}"#)
}

/// \`teamMembershipFor(db.sql, user, business)\`.
fn read(s: &Seeded, user: &str, business: &str) -> Result<Json, TeamError> {
    team::read(s.b.door.store(), user, business)
}

fn answer(s: &Seeded, user: &str, business: &str) -> Json {
    match read(s, user, business) {
        Ok(a) => a,
        Err(e) => panic!("{user} on {business}: {e:?}"),
    }
}

#[test]
fn lists_the_same_roles_as_svc_bank() {
    let Some(b) = bank() else { return };
    let mut enum_roles: Vec<String> = b
        .sql()
        .query_one(
            "SELECT enum_range(NULL::bank.business_member_role)::text[]",
            &[],
        )
        .unwrap()
        .get(0);
    enum_roles.sort();
    let mut roles: Vec<String> = ROLES.iter().map(|r| (*r).to_owned()).collect();
    roles.sort();
    assert_eq!(roles, enum_roles);
    for role in ROLES {
        let a = j(&format!(
            r#"{{"ok":true,"businessId":"{UNKNOWN}","role":"{role}","members":[{{"userId":"{ADMIN}","role":"{role}"}}]}}"#
        ));
        assert_eq!(team::checked(&a), Some(a.clone()), "{role}");
    }
}

#[test]
fn answers_each_member_with_the_whole_team_by_join_time_and_the_members_own_role() {
    let Some(s) = seeded() else { return };
    for (user, role) in [(ADMIN, "admin"), (MAKER, "maker"), (VIEWER, "viewer")] {
        assert_eq!(
            answer(&s, user, &s.business),
            whole(&s.business, role),
            "{role}"
        );
    }
}

#[test]
fn answers_not_member_to_an_outsider_an_unknown_business_and_a_removed_member() {
    let Some(s) = seeded() else { return };
    assert_eq!(answer(&s, OUTSIDER, &s.business), not_member());
    assert_eq!(answer(&s, ADMIN, &s.other), not_member());
    assert_eq!(answer(&s, ADMIN, UNKNOWN), not_member());
    s.b.sql()
        .execute(
            "DELETE FROM bank.business_members WHERE account_id = $1::text::uuid AND user_id = $2",
            &[&s.business, &MAKER],
        )
        .unwrap();
    assert_eq!(answer(&s, MAKER, &s.business), not_member());
    let left = answer(&s, ADMIN, &s.business);
    assert_eq!(
        left.get("members"),
        Some(&j(&format!(
            r#"[{{"userId":"{ADMIN}","role":"admin"}},{{"userId":"{VIEWER}","role":"viewer"}}]"#
        )))
    );
}

#[test]
fn matches_ids_in_any_case() {
    let Some(s) = seeded() else { return };
    assert_eq!(
        answer(&s, &MAKER.to_uppercase(), &s.business.to_uppercase()),
        whole(&s.business, "maker")
    );
}

/// Members past the seeded three, so the team is \`count + 3\`.
fn add_viewers(s: &Seeded, count: usize) {
    s.b.sql()
        .execute(
            "INSERT INTO bank.business_members (account_id, user_id, role) \
             SELECT $1::text::uuid, gen_random_uuid()::text, 'viewer' FROM generate_series(1, $2::int)",
            &[&s.business, &i32::try_from(count).unwrap()],
        )
        .unwrap();
}

#[test]
fn refuses_a_team_over_the_cap_whole_never_a_cut_off_list() {
    let Some(s) = seeded() else { return };
    add_viewers(&s, MAX - 3 + 1);
    assert!(
        matches!(read(&s, ADMIN, &s.business), Err(TeamError::Incomplete)),
        "{:?}",
        read(&s, ADMIN, &s.business)
    );
    s.b.sql()
        .execute(
            "DELETE FROM bank.business_members WHERE account_id = $1::text::uuid \
               AND user_id = (SELECT user_id FROM bank.business_members WHERE account_id = $1::text::uuid \
                               AND role = 'viewer' AND user_id <> $2 LIMIT 1)",
            &[&s.business, &VIEWER],
        )
        .unwrap();
    let whole = answer(&s, ADMIN, &s.business);
    assert_eq!(whole.get("ok"), Some(&Json::Bool(true)));
    let Some(Json::Array(members)) = whole.get("members") else {
        panic!("{}", whole.compact())
    };
    assert_eq!(members.len(), MAX);
}

#[test]
fn answers_business_closed_never_the_team_to_a_member_of_a_closed_business() {
    let Some(s) = seeded() else { return };
    s.b.sql()
        .execute(
            "UPDATE bank.business_accounts SET status = 'closed' WHERE id = $1::text::uuid",
            &[&s.business],
        )
        .unwrap();
    for user in [ADMIN, MAKER] {
        assert_eq!(
            answer(&s, user, &s.business),
            j(r#"{"ok":false,"reason":"business_closed"}"#),
            "{user}"
        );
    }
    assert_eq!(answer(&s, OUTSIDER, &s.business), not_member());
}

/// \`post(body, service)\` through \`app.inject\`.
fn post(s: &Seeded, body: &str, service: &str) -> (u16, Json) {
    rest(&s.b, Some(service), TEAM_URL, body)
}

fn ask(user: &str, business: &str) -> String {
    format!(r#"{{"userId":"{user}","businessId":"{business}"}}"#)
}

#[test]
fn answers_svc_agents_with_the_databases_team() {
    let Some(s) = seeded() else { return };
    let (status, body) = post(&s, &ask(MAKER, &s.business), "svc-agents");
    assert_eq!(status, 200, "{}", body.compact());
    assert_eq!(body, whole(&s.business, "maker"));
    let (_, outside) = post(&s, &ask(OUTSIDER, &s.business), "svc-agents");
    assert_eq!(outside, not_member());
}

fn code(body: &Json) -> String {
    match body.get("code") {
        Some(Json::String(c)) => c.clone(),
        other => panic!("no code: {other:?} in {}", body.compact()),
    }
}

#[test]
fn refuses_an_unsigned_caller_another_service_and_a_bad_body_without_reading() {
    let Some(s) = seeded() else { return };
    // Any read now fails (503): each refusal below is answered before the database is read.
    s.b.sql()
        .batch_execute("ALTER TABLE bank.business_members RENAME TO business_members_away")
        .unwrap();
    let (status, open) = rest(&s.b, None, TEAM_URL, &ask(ADMIN, &s.business));
    assert_eq!(status, 401, "{}", open.compact());
    assert_eq!(code(&open), "bank.unauthenticated");
    let (status, other_service) = post(&s, &ask(ADMIN, &s.business), "svc-identity");
    assert_eq!(status, 403, "{}", other_service.compact());
    assert_eq!(code(&other_service), "bank.team_membership_forbidden");
    for body in [
        format!(r#"{{"userId":"{ADMIN}"}}"#),
        format!(r#"{{"userId":"x","businessId":"{}"}}"#, s.business),
        format!(
            r#"{{"userId":"{ADMIN}","businessId":"{}","role":"admin"}}"#,
            s.business
        ),
    ] {
        let (status, bad) = post(&s, &body, "svc-agents");
        assert_eq!(status, 400, "{body}: {}", bad.compact());
        assert_eq!(code(&bad), "bank.team_membership_input", "{body}");
    }
    // The control: past those checks the broken table is read, and fails.
    let (status, read) = post(&s, &ask(ADMIN, &s.business), "svc-agents");
    assert_eq!(status, 503, "{}", read.compact());
}

#[test]
fn answers_503_bank_team_membership_incomplete_for_a_team_over_the_cap() {
    let Some(s) = seeded() else { return };
    add_viewers(&s, MAX - 3 + 1);
    let (status, body) = post(&s, &ask(ADMIN, &s.business), "svc-agents");
    assert_eq!(status, 503, "{}", body.compact());
    assert_eq!(
        body,
        j(
            r#"{"error":"business team is too large to answer whole","code":"bank.team_membership_incomplete"}"#
        )
    );
}

#[test]
fn answers_503_with_a_typed_code_never_the_error_text_when_the_read_fails_or_breaks_the_contract() {
    let unavailable = j(
        r#"{"error":"business team could not be read","code":"bank.team_membership_unavailable"}"#,
    );
    // The TypeScript's broken answer: the contract refuses it.
    let Some(s) = seeded() else { return };
    let broken = j(&format!(
        r#"{{"ok":true,"businessId":"{}","role":"admin","members":[]}}"#,
        s.business
    ));
    assert_eq!(team::checked(&broken), None);
    // A read that breaks the contract: a member whose id is blank.
    member(&mut s.b.sql(), &s.business, "   ", "viewer", "1 minute");
    let (status, body) = post(&s, &ask(ADMIN, &s.business), "svc-agents");
    assert_eq!(status, 503, "{}", body.compact());
    assert_eq!(body, unavailable);
    // A read that fails.
    let Some(s) = seeded() else { return };
    s.b.sql()
        .batch_execute("ALTER TABLE bank.business_members RENAME TO business_members_away")
        .unwrap();
    let (status, body) = post(&s, &ask(ADMIN, &s.business), "svc-agents");
    assert_eq!(status, 503, "{}", body.compact());
    assert_eq!(body, unavailable);
}

// ---------------------------------------------------------------------------------------------------------------
// business-directory.test.ts

const DIR_SECRET: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// What the fake identity answers each request.
type Answerer = Arc<dyn Fn(&HttpRequest) -> Result<HttpResponse, FetchError> + Send + Sync>;

/// \`vi.fn(fetch)\`: records each request, answers with \`answerer\`.
#[derive(Clone)]
struct Wire {
    sent: Arc<Mutex<Vec<HttpRequest>>>,
    answerer: Answerer,
}

impl Wire {
    fn new(
        answerer: impl Fn(&HttpRequest) -> Result<HttpResponse, FetchError> + Send + Sync + 'static,
    ) -> Wire {
        Wire {
            sent: Arc::default(),
            answerer: Arc::new(answerer),
        }
    }
    fn sent(&self) -> Vec<HttpRequest> {
        self.sent.lock().unwrap().clone()
    }
}

impl Fetch for Wire {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        self.sent.lock().unwrap().push(req.clone());
        (self.answerer)(req)
    }
}

fn reply(status: u16, body: &str) -> Result<HttpResponse, FetchError> {
    Ok(HttpResponse {
        status,
        body: body.to_owned(),
    })
}

/// \`createIdentityBusinessDirectory('http://identity.test', secret, fetchFn, s2s)\`.
fn http_directory(
    secret: &str,
    wire: &Wire,
    s2s: Option<(Arc<ServiceSigner>, Mode)>,
) -> DirectoryHttp {
    DirectoryHttp::new(
        "http://identity.test",
        CallSigner::new("svc-bank", "svc-identity", secret, s2s),
        Box::new(wire.clone()),
    )
}

/// A directory the door holds while the test also reads it: the same client behind an \`Arc\`.
struct Shared(Arc<dyn Directory>);

impl Directory for Shared {
    fn handles_of(&self, ids: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        self.0.handles_of(ids)
    }
    fn find_active(&self, query: &Lookup) -> Result<Option<(String, String)>, DirError> {
        self.0.find_active(query)
    }
    fn published_names(&self, ids: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        self.0.published_names(ids)
    }
}

/// Records each lookup; every lookup is a miss.
#[derive(Clone, Default)]
struct Asked(Arc<Mutex<Vec<Lookup>>>);

impl Directory for Asked {
    fn handles_of(&self, _: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        Ok(BTreeMap::new())
    }
    fn find_active(&self, query: &Lookup) -> Result<Option<(String, String)>, DirError> {
        self.0.lock().unwrap().push(query.clone());
        Ok(None)
    }
}

struct Open;

impl Freeze for Open {
    fn read(&self) -> Result<FreezeReading, String> {
        Ok(FreezeReading {
            posting_enabled: true,
            cause: None,
        })
    }
}

/// A door over a fresh migrated database whose business directory is \`directory\` (\`business_kit::door_over\` with
/// another directory), with one business: \`ADMIN\` its administrator.
fn door_with(directory: Box<dyn Directory>) -> Option<(TestDb, BankDoor, String)> {
    let db = TestDb::new()?;
    db.migrated();
    let identity = Identity::default();
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut w = TransfersWiring::none();
    w.recipients = Box::new(identity.clone());
    w.lock = Box::new(identity.clone());
    w.extras = Box::new(identity.clone());
    w.handles = Some(Box::new(identity));
    w.approvals = Box::new(FakeIdentity::default());
    w.settings = Settings {
        producer: "svc-bank".to_owned(),
        ..Settings::default()
    };
    let d = BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: door::system_now,
        store: db.store(),
    })
    .unwrap()
    .with_partner(PartnerWiring {
        partner: None,
        freeze: Box::new(Open),
        custody_layer: "on".to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring {
        ledger: Box::new(Book::default()),
        directory,
        lookups: Lookups::default(),
        rules: Rules {
            space_limit: Some("50".to_owned()),
            unlock_wait_hours: Some("24".to_owned()),
        },
        terms: Terms {
            invite_minutes: None,
            people_cap: None,
            card_programme: ("card-sim".to_owned(), true),
        },
        tables: Tables {
            account_terms: None,
            currencies: None,
            plans: None,
            fees: None,
            dormancy: None,
        },
    })
    .with_transfers(w);
    let mut c = db.client();
    let business = open(&mut c, "TEST directory");
    member(&mut c, &business, ADMIN, "admin", "1 minute");
    Some((db, d, business))
}

/// The refusal's code and the sentence it is sent with.
fn refusal<T: std::fmt::Debug>(r: Result<T, Refusal>) -> (String, String) {
    match r {
        Err(Refusal::Bank(e)) => (e.row.code.to_owned(), e.message),
        other => panic!("not a bank refusal: {other:?}"),
    }
}

/// \`business.members\`: the team list, which reads every member's handle.
fn team_of(d: &BankDoor, business: &str) -> Result<Json, Refusal> {
    d.transfers_deps(|deps| svc::team(deps, business, ADMIN))
}

/// \`business.resolveRecipientSpace\` as \`ADMIN\`.
fn lookup(
    d: &BankDoor,
    business: &str,
    handle: Option<&str>,
    email: Option<&str>,
) -> Result<Json, Refusal> {
    d.transfers_deps(|deps| {
        svc::resolve_recipient_space(
            deps,
            &svc::RecipientAsk {
                account_id: business,
                actor: ADMIN,
                asset_id: "IFC",
                handle,
                email,
            },
        )
    })
}

#[test]
fn treats_a_badly_shaped_handle_or_email_as_no_query() {
    let asked = Asked::default();
    let Some((_db, d, business)) = door_with(Box::new(asked.clone())) else {
        return;
    };
    let miss = j(r#"{"found":false}"#);
    let mut want = Vec::new();
    for (handle, email, normalised) in [
        (
            Some("  @Ada_Admin "),
            None,
            Some(Lookup::Handle("Ada_Admin".to_owned())),
        ),
        (Some("%"), None, None),
        (Some("ab"), None, None),
        (
            None,
            Some(" Pat@Example.com "),
            Some(Lookup::Email("Pat@Example.com".to_owned())),
        ),
        (None, Some("not-an-email"), None),
        (None, Some("a@b"), None),
    ] {
        assert_eq!(
            lookup(&d, &business, handle, email).unwrap(),
            miss,
            "{handle:?} {email:?}"
        );
        want.extend(normalised);
        assert_eq!(*asked.0.lock().unwrap(), want, "{handle:?} {email:?}");
    }
}

#[test]
fn refuses_when_identity_is_not_connected_and_names_that() {
    assert_eq!(
        NoDirectory.handles_of(&["u".to_owned()]),
        Err(DirError::Unset)
    );
    assert_eq!(
        NoDirectory.find_active(&Lookup::Handle("ada".to_owned())),
        Err(DirError::Unset)
    );
    let Some((_db, d, business)) = door_with(Box::new(NoDirectory)) else {
        return;
    };
    let (code, message) = refusal(team_of(&d, &business));
    assert_eq!(code, "bank.business_directory_unset");
    assert!(message.contains("IDENTITY_URL is unset"), "{message}");
    let (code, _) = refusal(lookup(&d, &business, Some("ada"), None));
    assert_eq!(code, "bank.business_directory_unset");
}

/// \`2026-10-29T06:00:00.500Z\`, in whole seconds.
const PINNED: i64 = 1_793_253_600;

fn header<'a>(req: &'a HttpRequest, name: &str) -> Option<&'a str> {
    req.headers
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

#[test]
fn reads_identity_and_treats_a_missing_route_as_unset() {
    let wire = Wire::new(|req| {
        let body = req.body.clone().unwrap_or_default();
        let expected = s2s::legacy_headers("svc-bank", DIR_SECRET, &body, PINNED).unwrap();
        for (k, v) in &expected {
            assert_eq!(header(req, k), Some(v.as_str()), "{k}");
        }
        if req.url.ends_with(HANDLES_PATH) {
            return reply(200, r#"{"handles":[{"userId":"a","handle":"Ada_Admin"}]}"#);
        }
        reply(200, r#"{"found":true,"userId":"a","handle":"Ada_Admin"}"#)
    });
    let mut signer = CallSigner::new("svc-bank", "svc-identity", DIR_SECRET, None);
    signer.clock = Arc::new(|| PINNED);
    let directory = DirectoryHttp::new("http://identity.test", signer, Box::new(wire.clone()));
    assert_eq!(
        directory
            .handles_of(&["a".to_owned()])
            .unwrap()
            .into_iter()
            .collect::<Vec<_>>(),
        vec![("a".to_owned(), "Ada_Admin".to_owned())]
    );
    assert_eq!(
        directory.find_active(&Lookup::Email("ada@example.com".to_owned())),
        Ok(Some(("a".to_owned(), "Ada_Admin".to_owned())))
    );
    assert!(
        wire.sent()[1].url.contains(RECIPIENT_PATH),
        "{:?}",
        wire.sent()[1].url
    );
}

#[test]
fn a_404_names_the_unpublished_directory_route() {
    let wire = Wire::new(|_| reply(404, "no"));
    let directory = http_directory(DIR_SECRET, &wire, None);
    // Reason `unset`, as the TypeScript's `BusinessDirectoryError(UNSET_404, 'unset')`.
    let missing = directory.handles_of(&["a".to_owned()]).unwrap_err();
    assert_eq!(missing, DirError::Missing);
    assert!(missing.unset());
    // The message the slice refuses with, from this client.
    let Some((_db, d, business)) = door_with(Box::new(Shared(Arc::new(directory)))) else {
        return;
    };
    let (code, message) = refusal(team_of(&d, &business));
    assert_eq!(code, "bank.business_directory_unset");
    assert!(message.contains(HANDLES_PATH), "{message}");
}

#[test]
fn a_transport_failure_is_unavailable_and_does_not_invent_a_handle() {
    let wire = Wire::new(|_| {
        Err(FetchError {
            message: FETCH_FAILED.to_owned(),
        })
    });
    let directory = http_directory(DIR_SECRET, &wire, None);
    assert_eq!(
        directory.find_active(&Lookup::Handle("ada".to_owned())),
        Err(DirError::Unavailable)
    );
    let Some((_db, d, business)) = door_with(Box::new(Shared(Arc::new(directory)))) else {
        return;
    };
    let (code, message) = refusal(lookup(&d, &business, Some("ada"), None));
    assert_eq!(code, "bank.business_directory_unavailable");
    assert!(
        message.contains("bank.business_directory_unavailable"),
        "{message}"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// business-directory-keys.test.ts

const KEYS_SECRET: &str = "test-internal-service-secret-32-chars";

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// RFC 8032, section 7.1, test 1: the seed and its public half.
const RFC8032_SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC8032_PUBLIC: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

/// \`keys()\`: svc-bank's signer, its keyring, and svc-identity's verifier.
struct Keys {
    signer: Arc<ServiceSigner>,
    keyring: Vec<KeyringEntry>,
}

fn keys() -> Keys {
    let keyring = vec![KeyringEntry {
        kid: "svc-bank.a".to_owned(),
        svc: "svc-bank".to_owned(),
        use_: "s2s".to_owned(),
        x: URL_SAFE_NO_PAD.encode(unhex(RFC8032_PUBLIC)),
    }];
    let mut der = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    der.extend(unhex(RFC8032_SEED));
    let signer = ServiceSigner::new(
        "svc-bank",
        "svc-bank.a",
        &URL_SAFE_NO_PAD.encode(der),
        &keyring,
    )
    .unwrap();
    Keys {
        signer: Arc::new(signer),
        keyring,
    }
}

impl Keys {
    fn s2s(&self, mode: Mode) -> Option<(Arc<ServiceSigner>, Mode)> {
        Some((self.signer.clone(), mode))
    }
    /// \`createServiceVerifier({ self: 'svc-identity', keyring, bootSecond: 0 })\`.
    fn verifier(&self) -> ServiceVerifier {
        ServiceVerifier::new("svc-identity", &self.keyring, system_seconds)
            .unwrap()
            .with_boot_second(0)
    }
}

/// \`judged(s, verifier, mode)\`: \`verifyServiceRequest\` fed the request as it went on the wire (\`url.pathname +
/// url.search\`); no mode is the TypeScript's default, dual.
fn judged(
    req: &HttpRequest,
    method: &str,
    url: &str,
    verifier: &ServiceVerifier,
    mode: Option<Mode>,
) -> RequestAuth {
    let body = req.body.clone().unwrap_or_default();
    verify_request(
        &Incoming {
            method,
            url,
            headers: &req.headers,
            body: Some(body.as_bytes()),
        },
        Some(verifier),
        Some(KEYS_SECRET),
        mode.unwrap_or(Mode::Dual),
        BodyBind::Require,
        system_seconds(),
    )
}

fn path_of(req: &HttpRequest) -> &str {
    req.url.strip_prefix("http://identity.test").unwrap()
}

fn as_sent(req: &HttpRequest, verifier: &ServiceVerifier, mode: Option<Mode>) -> RequestAuth {
    judged(req, &req.method, path_of(req), verifier, mode)
}

/// \`handlesOf(['u-1'])\` through a recording wire that answers no handles.
fn handles_call(s2s: Option<(Arc<ServiceSigner>, Mode)>) -> Vec<HttpRequest> {
    let wire = Wire::new(|_| reply(200, r#"{"handles":[]}"#));
    http_directory(KEYS_SECRET, &wire, s2s)
        .handles_of(&["u-1".to_owned()])
        .unwrap();
    wire.sent()
}

#[test]
fn without_a_signing_key_the_call_is_signed_with_the_shared_secret_as_before() {
    let k = keys();
    let sent = handles_call(None);
    assert!(!sent.is_empty());
    assert!(
        !sent[0]
            .headers
            .iter()
            .any(|(h, _)| h.starts_with("x-intafaced-s2s-")),
        "{:?}",
        sent[0].headers
    );
    let auth = as_sent(&sent[0], &k.verifier(), None);
    assert_eq!(auth.service.as_deref(), Some("svc-bank"), "{auth:?}");
    assert_eq!(auth.scheme, Some("shared"), "{auth:?}");
}

#[test]
fn dual_the_callee_names_the_caller_from_the_key_and_the_shared_secret_rides_along() {
    let k = keys();
    let sent = handles_call(k.s2s(Mode::Dual));
    assert!(!sent.is_empty());
    for s in &sent {
        assert_eq!(header(s, SERVICE_HEADER), Some("svc-bank"));
        assert_eq!(
            as_sent(s, &k.verifier(), None),
            RequestAuth {
                service: Some("svc-bank".to_owned()),
                scheme: Some("keypair"),
                rejected: None,
            }
        );
    }
}

#[test]
fn keypair_only_the_key_signature_is_sent_and_a_keypair_only_callee_accepts_it() {
    let k = keys();
    let sent = handles_call(k.s2s(Mode::Keypair));
    assert!(!sent.is_empty());
    for s in &sent {
        assert_eq!(header(s, SERVICE_HEADER), None);
        assert_eq!(header(s, "x-intafaced-signature"), None);
        assert_eq!(header(s, SERVICE_SIGNATURE_HEADER), None);
        let auth = as_sent(s, &k.verifier(), Some(Mode::Keypair));
        assert_eq!(auth.service.as_deref(), Some("svc-bank"), "{auth:?}");
        assert_eq!(auth.scheme, Some("keypair"), "{auth:?}");
    }
}

#[test]
fn a_signed_call_moved_to_another_path_or_method_is_refused() {
    let k = keys();
    let sent = handles_call(k.s2s(Mode::Keypair));
    let first = &sent[0];
    assert_eq!(
        as_sent(first, &k.verifier(), Some(Mode::Keypair))
            .service
            .as_deref(),
        Some("svc-bank")
    );
    let other_path = judged(
        first,
        &first.method,
        "/elsewhere",
        &k.verifier(),
        Some(Mode::Keypair),
    );
    assert_eq!(other_path.service, None, "{other_path:?}");
    let other_method = if first.method == "POST" {
        "GET"
    } else {
        "POST"
    };
    let moved = judged(
        first,
        other_method,
        path_of(first),
        &k.verifier(),
        Some(Mode::Keypair),
    );
    assert_eq!(moved.service, None, "{moved:?}");
}
