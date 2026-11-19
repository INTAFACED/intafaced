//! The certificate methods of `AcademyService` (`academy-service.ts`), statement for statement: progress and grants
//! with their XP and perks, the issue rules' standing and the sweep, revocation and exceptions, the public check and the
//! holder's name. Each reads and writes the `academy` schema as the TypeScript does; a grant posts no money.

use std::collections::BTreeSet;

use postgres::{Client, GenericClient, IsolationLevel};

use service_kit::json::Json;
use service_kit::schema::js_trim;
use service_kit::time::Instant;

use super::catalog::{self, CertDefinition};
use super::designs;
use super::honesty;
use super::issue_rules::{self, Rule};
use super::perks;
use super::progress::{self, Grant, Report};
use super::sql::{cell, exec, iso, lock_extended, ms, q};
use super::xp::{Emit, Publisher};
use crate::db::{self, Store};
use crate::errors::{AcademyError, Refusal};
use crate::ports::HostRights;

/// `CERT_ISSUE_SWEEP_BATCH`.
pub const SWEEP_BATCH: i64 = 100;
/// `PROGRAMME_CERT_PREFIX`: a programme's certificate is a grant under `programme:<slug>`.
pub const PROGRAMME_CERT_PREFIX: &str = "programme:";
/// `HOLDER_NAME_MAX_LENGTH`.
pub const HOLDER_NAME_MAX_LENGTH: usize = 200;

fn academy(message: impl Into<String>, code: &str) -> Refusal {
    AcademyError::new(message, code).into()
}

/// `console.error({ err, ... }, msg)`: one line on stderr.
pub fn log_error(err: &Refusal, fields: &[(&str, &str)], msg: &str) {
    let mut f = vec![("err".to_owned(), Json::str(format!("{err:?}")))];
    f.extend(fields.iter().map(|(k, v)| ((*k).to_owned(), Json::str(*v))));
    f.push(("msg".to_owned(), Json::str(msg)));
    eprintln!("{}", Json::Object(f).compact());
}

/// `isPublicId`: 32 lowercase hex characters.
pub fn is_public_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `randomPublicId()`: 128 bits from the platform CSPRNG, as hex; never derived from the account or the grant key.
pub fn random_public_id() -> Result<String, Refusal> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| Refusal::db(e.to_string(), None))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// `normaliseHolderName`: none clears; a name is trimmed; empty, too long or a control character refuses.
pub fn normalise_holder_name(raw: Option<&str>) -> Result<Option<String>, Refusal> {
    let Some(raw) = raw else { return Ok(None) };
    let trimmed = js_trim(raw);
    let control = trimmed
        .chars()
        .any(|c| matches!(u32::from(c), 0x00..=0x1f | 0x7f..=0x9f));
    if trimmed.is_empty() || trimmed.encode_utf16().count() > HOLDER_NAME_MAX_LENGTH || control {
        return Err(academy(
            "holder name is empty, too long, or contains a control character",
            "academy.holder_name_invalid",
        ));
    }
    Ok(Some(trimmed.to_owned()))
}

/// `AcademyCertIssue`: how a learner's certificate is issued.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub mode: String,
    pub delay_minutes: Option<i64>,
    pub issues_at: Option<i64>,
}

impl Issue {
    /// `MANUAL_ISSUE`.
    pub fn manual() -> Issue {
        Issue {
            mode: "manual".to_owned(),
            delay_minutes: None,
            issues_at: None,
        }
    }

    pub fn json(&self) -> Json {
        Json::obj([
            ("mode", Json::str(self.mode.clone())),
            (
                "delayMinutes",
                self.delay_minutes.map_or(Json::Null, Json::int),
            ),
            (
                "issuesAt",
                self.issues_at.map_or(Json::Null, |t| Json::str(iso(t))),
            ),
        ])
    }
}

/// A grant as the service reads it back: the record, its public code and its status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    pub grant: Grant,
    pub public_id: String,
    pub revoked: bool,
}

/// `grantCert`'s answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Granted {
    pub grant: Grant,
    pub public_id: String,
    pub already_granted: bool,
    pub xp: Emit,
    pub perks: Json,
}

impl Granted {
    /// The router's output: `{ grant, alreadyGranted, xp, perks }`.
    pub fn json(&self) -> Json {
        Json::obj([
            (
                "grant",
                Json::obj([
                    ("userId", Json::str(self.grant.user_id.clone())),
                    ("certId", Json::str(self.grant.cert_id.clone())),
                    ("grantedAt", Json::str(iso(self.grant.granted_at))),
                    (
                        "idempotencyKey",
                        Json::str(self.grant.idempotency_key.clone()),
                    ),
                    ("publicId", Json::str(self.public_id.clone())),
                ]),
            ),
            ("alreadyGranted", Json::Bool(self.already_granted)),
            ("xp", self.xp.json()),
            ("perks", self.perks.clone()),
        ])
    }
}

/// `academyCertRevocationSchema`.
fn revocation_columns() -> String {
    format!(
        "public_id, cert_id, proposed_by, approved_by, revoked_by::text, reason, {}",
        ms("revoked_at")
    )
}

fn revocation_of(r: &postgres::Row) -> Result<Json, Refusal> {
    Ok(Json::obj([
        ("publicId", Json::str(cell::<String>(r, 0)?)),
        ("certId", Json::str(cell::<String>(r, 1)?)),
        ("proposedBy", Json::str(cell::<String>(r, 2)?)),
        ("approvedBy", Json::str(cell::<String>(r, 3)?)),
        ("revokedBy", Json::str(cell::<String>(r, 4)?)),
        ("reason", Json::str(cell::<String>(r, 5)?)),
        ("revokedAt", Json::str(iso(cell(r, 6)?))),
    ]))
}

/// `academyCertExceptionSchema`.
fn exception_columns() -> String {
    format!(
        "public_id, user_id::text, cert_id, proposed_by, approved_by, granted_by::text, reason, {}",
        ms("granted_at")
    )
}

fn exception_of(r: &postgres::Row) -> Result<Json, Refusal> {
    Ok(Json::obj([
        ("publicId", Json::str(cell::<String>(r, 0)?)),
        ("userId", Json::str(cell::<String>(r, 1)?)),
        ("certId", Json::str(cell::<String>(r, 2)?)),
        ("proposedBy", Json::str(cell::<String>(r, 3)?)),
        ("approvedBy", Json::str(cell::<String>(r, 4)?)),
        ("grantedBy", Json::str(cell::<String>(r, 5)?)),
        ("reason", Json::str(cell::<String>(r, 6)?)),
        ("grantedAt", Json::str(iso(cell(r, 7)?))),
    ]))
}

/// Who proposed and who approved a two-person action.
pub struct Pair<'a> {
    pub proposed_by: &'a str,
    pub approved_by: &'a str,
    pub operator_id: &'a str,
}

/// The certificate half of `AcademyService`, built once per call (or per sweep) from the service's parts.
pub struct Certs<'a> {
    /// The database, or what a store that cannot serve refuses with at the first query.
    pub store: &'a Store,
    /// `options.certCatalog ?? CERT_CATALOG`.
    pub catalog: &'a [CertDefinition],
    pub xp: &'a dyn Publisher,
    pub host_rights: &'a dyn HostRights,
    /// `options.certIssueSweepSeconds !== undefined`.
    pub sweep_running: bool,
    /// `ACADEMY_CERT_ISSUED_ROWS`.
    pub issued_rows: Option<i64>,
    /// `new Date()` where the TypeScript reads the wall clock.
    pub wall: fn() -> Instant,
}

impl Certs<'_> {
    fn with<T>(&self, f: impl FnOnce(&mut Client) -> Result<T, Refusal>) -> Result<T, Refusal> {
        db::with_client(self.store.pool()?, f)
    }

    /// `certDefinition(id)`.
    pub fn definition(&self, id: &str) -> Option<&CertDefinition> {
        catalog::by_id(id, self.catalog)
    }

    /// `refuseUnpublishedPath`: a path with no published certificate refuses `academy.certificate_unpublished`.
    pub fn refuse_unpublished_path(&self, path_slug: &str) -> Result<(), Refusal> {
        let path = js_trim(path_slug).to_lowercase();
        if catalog::CERT_PATHS.contains(&path.as_str())
            && catalog::for_path(&path, self.catalog).is_none()
        {
            return Err(academy(
                format!("academy.certificate_unpublished path={path}"),
                "academy.certificate_unpublished",
            ));
        }
        Ok(())
    }

    /// A published certificate, or `academy.certificate_unpublished` for a path with none, else `academy.cert_not_found`.
    fn known(&self, cert_id: &str) -> Result<&CertDefinition, Refusal> {
        match self.definition(cert_id) {
            Some(c) => Ok(c),
            None => {
                self.refuse_unpublished_path(cert_id)?;
                Err(academy("Unknown certification", "academy.cert_not_found"))
            }
        }
    }

    /// The design store over the same catalogue.
    pub fn designs(&self) -> designs::Designs<'_> {
        designs::Designs {
            store: self.store,
            catalog: self
                .catalog
                .iter()
                .map(|c| (c.id.clone(), c.title.clone()))
                .collect(),
            issued_rows: self.issued_rows,
        }
    }

    /// `listCertDefinitions()`.
    pub fn definitions_json(&self) -> Json {
        Json::Array(self.catalog.iter().map(CertDefinition::json).collect())
    }

    /// `certPaths()`.
    pub fn paths_json(&self) -> Json {
        Json::Array(
            catalog::CERT_PATHS
                .iter()
                .map(|path| {
                    let cert = catalog::for_path(path, self.catalog);
                    Json::obj([
                        ("path", Json::str(*path)),
                        (
                            "certId",
                            cert.map_or(Json::Null, |c| Json::str(c.id.clone())),
                        ),
                        (
                            "refusal",
                            if cert.is_some() {
                                Json::Null
                            } else {
                                Json::str("academy.certificate_unpublished")
                            },
                        ),
                    ])
                })
                .collect(),
        )
    }

    /// `completedSlugs(userId)`.
    pub fn completed_slugs(&self, user_id: &str) -> Result<BTreeSet<String>, Refusal> {
        self.with(|c| {
            q(
                c,
                "SELECT item_slug FROM academy.cert_item_completions WHERE user_id = $1::text::uuid",
                &[&user_id],
            )?
            .iter()
            .map(|r| cell(r, 0))
            .collect()
        })
    }

    /// `completionTimes(userId, slugs)`.
    fn completion_times(&self, user_id: &str, slugs: &[String]) -> Result<Vec<i64>, Refusal> {
        if slugs.is_empty() {
            return Ok(Vec::new());
        }
        self.with(|c| {
            q(
                c,
                &format!(
                    "SELECT item_slug, {} FROM academy.cert_item_completions \
                     WHERE user_id = $1::text::uuid AND item_slug = ANY($2)",
                    ms("completed_at")
                ),
                &[&user_id, &slugs],
            )?
            .iter()
            .map(|r| cell(r, 1))
            .collect()
        })
    }

    /// `assessments.passedSlugs(userId, now)`: the passed, unvoided assessments whose result shows by `now`.
    pub fn passed_slugs(&self, user_id: &str, now: i64) -> Result<BTreeSet<String>, Refusal> {
        self.with(|c| {
            q(
                c,
                "SELECT DISTINCT a.slug FROM academy.assessment_attempts a \
                   LEFT JOIN academy.quizzes q ON q.slug = a.slug \
                  WHERE a.user_id = $1::text::uuid AND a.passed = true AND a.voided_at IS NULL \
                    AND CASE WHEN GREATEST(a.hidden_until, q.results_hidden_until) > $2::text::timestamptz \
                             THEN GREATEST(a.hidden_until, q.results_hidden_until) END IS NULL",
                &[&user_id, &iso(now)],
            )?
            .iter()
            .map(|r| cell(r, 0))
            .collect()
        })
    }

    /// `existingGrant(userId, certId)`.
    pub fn existing_grant(&self, user_id: &str, cert_id: &str) -> Result<Option<Held>, Refusal> {
        self.with(|c| {
            q(
                c,
                &format!(
                    "SELECT user_id::text, cert_id, {}, idempotency_key, public_id, status FROM academy.cert_grants \
                     WHERE user_id = $1::text::uuid AND cert_id = $2",
                    ms("granted_at")
                ),
                &[&user_id, &cert_id],
            )?
            .first()
            .map(|r| {
                Ok(Held {
                    grant: Grant {
                        user_id: cell(r, 0)?,
                        cert_id: cell(r, 1)?,
                        granted_at: cell(r, 2)?,
                        idempotency_key: cell(r, 3)?,
                    },
                    public_id: cell(r, 4)?,
                    revoked: cell::<String>(r, 5)? == "revoked",
                })
            })
            .transpose()
        })
    }

    /// `insertCertGrant`: a new serial, keeping the design revision active as it is written; nothing when the learner
    /// already holds this certificate.
    fn insert_cert_grant(&self, grant: &Grant) -> Result<Option<(Grant, String)>, Refusal> {
        let public_id = random_public_id()?;
        self.with(|c| {
            q(
                c,
                &format!(
                    "INSERT INTO academy.cert_grants (user_id, cert_id, granted_at, idempotency_key, public_id, design_revision) \
                     VALUES ($1::text::uuid, $2, $3::text::timestamptz, $4, $5, \
                             (SELECT active_revision FROM academy.cert_designs WHERE cert_id = $2)) \
                     ON CONFLICT (user_id, cert_id) DO NOTHING \
                     RETURNING user_id::text, cert_id, {}, idempotency_key, public_id",
                    ms("granted_at")
                ),
                &[
                    &grant.user_id,
                    &grant.cert_id,
                    &iso(grant.granted_at),
                    &grant.idempotency_key,
                    &public_id,
                ],
            )?
            .first()
            .map(|r| {
                Ok((
                    Grant {
                        user_id: cell(r, 0)?,
                        cert_id: cell(r, 1)?,
                        granted_at: cell(r, 2)?,
                        idempotency_key: cell(r, 3)?,
                    },
                    cell(r, 4)?,
                ))
            })
            .transpose()
        })
    }

    /// `progressOf(userId, cert)`.
    pub fn progress_of(&self, user_id: &str, cert: &CertDefinition) -> Result<Report, Refusal> {
        let completed = self.completed_slugs(user_id)?;
        let passed = self.passed_slugs(user_id, (self.wall)().0)?;
        let existing = self.existing_grant(user_id, &cert.id)?;
        progress::report(
            user_id,
            Some(cert),
            &completed,
            existing.as_ref().map(|h| &h.grant),
            &passed,
        )
    }

    /// `issueStanding`: how the learner's certificate stands under its rule, writing nothing but the wait.
    fn issue_standing(
        &self,
        user_id: &str,
        cert: &CertDefinition,
        progress: &Report,
        now: i64,
    ) -> Result<(Issue, bool), Refusal> {
        let rule: Option<Rule> = self.with(|c| issue_rules::rule(c, &cert.id))?;
        let issuing = rule
            .as_ref()
            .filter(|r| r.mode != "manual" && !progress.granted && progress.complete);
        let Some(rule) = issuing else {
            self.with(|c| issue_rules::drop_pending(c, user_id, &cert.id))?;
            let issue = match &rule {
                Some(r) if r.mode != "manual" => Issue {
                    mode: r.mode.clone(),
                    delay_minutes: r.delay_minutes,
                    issues_at: None,
                },
                _ => Issue::manual(),
            };
            return Ok((issue, false));
        };
        let view = Issue {
            mode: rule.mode.clone(),
            delay_minutes: rule.delay_minutes,
            issues_at: None,
        };
        if rule.mode == "automatic" {
            return Ok((view, true));
        }
        let has_assessment = cert
            .required_item_slugs
            .iter()
            .any(|s| progress::assessment_requirement_slug(s).is_some());
        let lessons = self.completion_times(user_id, &cert.required_item_slugs)?;
        let mut complete_at = rule.updated_at;
        if has_assessment {
            complete_at = complete_at.max(now);
        } else {
            for at in lessons {
                complete_at = complete_at.max(at);
            }
        }
        let due_at = issue_rules::issue_due_at(complete_at, rule.delay_minutes.unwrap_or(0));
        let due_at =
            self.with(|c| issue_rules::ensure_pending(c, user_id, &cert.id, due_at, now))?;
        Ok(if due_at > now {
            (
                Issue {
                    issues_at: Some(due_at),
                    ..view
                },
                false,
            )
        } else {
            (view, true)
        })
    }

    /// `settleCertIssue`: issues the learner's certificate when its rule says it is due; answers how it is issued.
    fn settle_cert_issue(
        &self,
        user_id: &str,
        cert: &CertDefinition,
        now: i64,
        progress: Option<Report>,
    ) -> Result<Issue, Refusal> {
        let progress = match progress {
            Some(p) => p,
            None => self.progress_of(user_id, cert)?,
        };
        let (issue, due) = self.issue_standing(user_id, cert, &progress, now)?;
        if due {
            self.grant_cert(user_id, &cert.id, true, now)?;
            self.with(|c| issue_rules::drop_pending(c, user_id, &cert.id))?;
        }
        Ok(issue)
    }

    /// `settleCertificatesNeeding`: after a completion, an Undo or an assessment result, settles every certificate that
    /// needs `requirement`. A failure is logged and left for the next read or the sweep.
    pub fn settle_certificates_needing(&self, user_id: &str, requirement: &str, now: i64) {
        for cert in self
            .catalog
            .iter()
            .filter(|c| c.required_item_slugs.iter().any(|s| s == requirement))
        {
            if let Err(err) = self.settle_cert_issue(user_id, cert, now, None) {
                log_error(
                    &err,
                    &[("certId", &cert.id)],
                    "certificate issue failed; the next read or sweep retries it",
                );
            }
        }
    }

    /// `issueDueCertificates(now)`: the sweep. Issues every delayed certificate due by `now`, in batches until none is
    /// left, and answers how many it settled. One failure is logged and left for the next sweep.
    pub fn issue_due_certificates(&self, now: i64) -> Result<i64, Refusal> {
        let mut settled = 0;
        let mut seen: BTreeSet<String> = BTreeSet::new();
        loop {
            let due = self.with(|c| issue_rules::due(c, now, SWEEP_BATCH))?;
            if due.iter().any(|(u, c)| seen.contains(&format!("{u}:{c}"))) {
                return Ok(settled);
            }
            let mut failed = false;
            for (user_id, cert_id) in &due {
                seen.insert(format!("{user_id}:{cert_id}"));
                let out = match self.definition(cert_id) {
                    Some(cert) => self.settle_cert_issue(user_id, cert, now, None).map(|_| ()),
                    None => self.with(|c| issue_rules::drop_pending(c, user_id, cert_id)),
                };
                match out {
                    Ok(()) => settled += 1,
                    Err(err) => {
                        failed = true;
                        log_error(
                            &err,
                            &[("certId", cert_id)],
                            "certificate issue sweep: one certificate failed; the next sweep retries it",
                        );
                    }
                }
            }
            if i64::try_from(due.len()).unwrap_or(0) < SWEEP_BATCH || failed {
                return Ok(settled);
            }
        }
    }

    /// `grantCert`: the grant first, then the XP it is worth, then identity's perks (or a refusal). The award is
    /// published on the already-granted path too: the recovery path for an award the bus missed.
    pub fn grant_cert(
        &self,
        user_id: &str,
        cert_id: &str,
        by_rule: bool,
        now: i64,
    ) -> Result<Granted, Refusal> {
        honesty::assert_no_perk_money(&Json::obj([
            ("userId", Json::str(user_id)),
            ("certId", Json::str(cert_id)),
        ]))?;
        let cert = self.definition(cert_id);
        if cert.is_none() {
            self.refuse_unpublished_path(cert_id)?;
        }
        if let (false, Some(cert)) = (by_rule, cert) {
            let progress = self.progress_of(user_id, cert)?;
            let (issue, _) = self.issue_standing(user_id, cert, &progress, now)?;
            if let Some(at) = issue.issues_at {
                return Err(academy(
                    format!("academy.cert_not_due issuesAt={}", iso(at)),
                    "academy.cert_not_due",
                ));
            }
        }
        let completed = self.completed_slugs(user_id)?;
        let passed = self.passed_slugs(user_id, (self.wall)().0)?;
        let existing = self.existing_grant(user_id, cert_id)?;
        if existing.as_ref().is_some_and(|h| h.revoked) {
            return Err(academy(
                format!("academy.cert_revoked cert={cert_id}"),
                "academy.cert_revoked",
            ));
        }
        let (grant, already) = progress::decide_grant(
            user_id,
            cert,
            &completed,
            existing.as_ref().map(|h| &h.grant),
            &passed,
            (self.wall)().0,
        )?;
        if already {
            let Some(held) = existing else {
                return Err(academy(
                    format!("Grant marked already granted with no row for {cert_id}"),
                    "academy.cert_invalid",
                ));
            };
            return self.answered(grant, held.public_id, true);
        }
        match self.insert_cert_grant(&grant)? {
            Some((written, public_id)) => self.answered(
                written,
                public_id,
                progress::already_granted_after_insert(true),
            ),
            None => {
                let Some(raced) = self.existing_grant(user_id, cert_id)? else {
                    return Err(academy(
                        format!("Grant race left no cert row for {cert_id}"),
                        "academy.cert_invalid",
                    ));
                };
                self.answered(
                    raced.grant,
                    raced.public_id,
                    progress::already_granted_after_insert(false),
                )
            }
        }
    }

    fn answered(
        &self,
        grant: Grant,
        public_id: String,
        already_granted: bool,
    ) -> Result<Granted, Refusal> {
        let xp = self.xp.publish(&grant)?;
        let perks = perks::resolve(&grant.user_id, self.host_rights, &xp);
        Ok(Granted {
            grant,
            public_id,
            already_granted,
            xp,
            perks,
        })
    }

    /// `myCertGrants(userId, limit)`: newest first, each printing the design revision it was issued under.
    pub fn my_cert_grants(&self, user_id: &str, requested: Option<f64>) -> Result<Json, Refusal> {
        let limit = sql_list_limit(requested, "academy.my_certs_list_limit_unset", "My certs")?;
        self.with(|c| {
            let rows = q(
                c,
                &format!(
                    "SELECT user_id::text, cert_id, {}, idempotency_key, public_id, status, design_revision FROM academy.cert_grants \
                     WHERE user_id = $1::text::uuid ORDER BY granted_at DESC LIMIT $2",
                    ms("granted_at")
                ),
                &[&user_id, &limit],
            )?;
            let mut keys = Vec::new();
            for r in &rows {
                if let Some(rev) = cell::<Option<i32>>(r, 6)? {
                    keys.push((cell::<String>(r, 1)?, rev));
                }
            }
            let printed = designs::printed(c, &keys)?;
            let mut out = Vec::new();
            for r in &rows {
                let cert_id: String = cell(r, 1)?;
                let rev: Option<i32> = cell(r, 6)?;
                let design = rev.map_or(Json::Null, |rev| {
                    printed
                        .iter()
                        .find(|(k, _)| *k == format!("{cert_id}:{rev}"))
                        .map_or(Json::Null, |(_, d)| d.printed_json())
                });
                out.push(Json::obj([
                    ("userId", Json::str(cell::<String>(r, 0)?)),
                    ("certId", Json::str(cert_id)),
                    ("grantedAt", Json::str(iso(cell(r, 2)?))),
                    ("idempotencyKey", Json::str(cell::<String>(r, 3)?)),
                    ("publicId", Json::str(cell::<String>(r, 4)?)),
                    (
                        "status",
                        Json::str(if cell::<String>(r, 5)? == "revoked" { "revoked" } else { "valid" }),
                    ),
                    ("design", design),
                ]));
            }
            Ok(Json::Array(out))
        })
    }

    /// `certProgress`: the caller's progress with how it is issued; a certificate its rule says is due is issued here
    /// first (the recovery path for an issue a completion did not finish).
    pub fn cert_progress(
        &self,
        user_id: &str,
        cert_id: &str,
        now: i64,
    ) -> Result<(Report, Issue), Refusal> {
        let Some(cert) = self.definition(cert_id) else {
            self.refuse_unpublished_path(cert_id)?;
            return Err(academy("Unknown certification", "academy.cert_not_found"));
        };
        let progress = self.progress_of(user_id, cert)?;
        let (issue, due) = self.issue_standing(user_id, cert, &progress, now)?;
        if !due {
            return Ok((progress, issue));
        }
        let issued = self
            .grant_cert(user_id, &cert.id, true, now)
            .and_then(|_| self.with(|c| issue_rules::drop_pending(c, user_id, &cert.id)));
        if let Err(err) = issued {
            log_error(
                &err,
                &[("certId", &cert.id)],
                "certificate issue on a progress read failed",
            );
            return Ok((progress, issue));
        }
        Ok((self.progress_of(user_id, cert)?, issue))
    }

    /// `setCertIssueRule`.
    pub fn set_cert_issue_rule(
        &self,
        cert_id: &str,
        mode: &str,
        delay_minutes: Option<i64>,
        reason: &str,
        operator_id: &str,
        now: i64,
    ) -> Result<Rule, Refusal> {
        if self.definition(cert_id).is_none() {
            self.refuse_unpublished_path(cert_id)?;
            return Err(academy("Unknown certification", "academy.cert_not_found"));
        }
        issue_rules::set_rule(
            self.store.pool()?,
            &issue_rules::SetRule {
                cert_id,
                mode,
                delay_minutes,
                reason,
                operator_id,
                now,
                sweep_running: self.sweep_running,
            },
        )
    }

    /// `certIssueRule(certId)`.
    pub fn cert_issue_rule(&self, cert_id: &str) -> Result<Option<Rule>, Refusal> {
        self.with(|c| issue_rules::rule(c, cert_id))
    }

    /// `certRevocation(publicId, tx)`: the revocation recorded for one issued certificate, or none while it stands.
    pub fn cert_revocation_in<C: GenericClient>(
        c: &mut C,
        public_id: &str,
    ) -> Result<Option<Json>, Refusal> {
        if !is_public_id(public_id) {
            return Err(academy("Certificate not found", "academy.cert_not_found"));
        }
        if q(
            c,
            "SELECT 1 FROM academy.cert_grants WHERE public_id = $1",
            &[&public_id],
        )?
        .is_empty()
        {
            return Err(academy("Certificate not found", "academy.cert_not_found"));
        }
        q(
            c,
            &format!(
                "SELECT {} FROM academy.cert_revocations WHERE public_id = $1",
                revocation_columns()
            ),
            &[&public_id],
        )?
        .first()
        .map(revocation_of)
        .transpose()
    }

    /// `certRevocation(publicId)`.
    pub fn cert_revocation(&self, public_id: &str) -> Result<Option<Json>, Refusal> {
        if !is_public_id(public_id) {
            return Err(academy("Certificate not found", "academy.cert_not_found"));
        }
        self.with(|c| Self::cert_revocation_in(c, public_id))
    }

    /// `revokeCert`: once two people approved it, the grant turns revoked and one record names them; a repeat answers
    /// the first record. Then the XP goes back.
    pub fn revoke_cert(
        &self,
        public_id: &str,
        reason: &str,
        pair: &Pair<'_>,
        now: i64,
    ) -> Result<Json, Refusal> {
        let reason = js_trim(reason);
        if reason.is_empty() || reason.encode_utf16().count() > 500 {
            return Err(academy("A revoke needs a reason", "academy.cert_invalid"));
        }
        let record = db::transaction_retrying(
            self.store.pool()?,
            IsolationLevel::Serializable,
            |tx| {
                q(
                    tx,
                    "SELECT 1 FROM academy.cert_grants WHERE public_id = $1 FOR UPDATE",
                    &[&public_id],
                )?;
                if let Some(recorded) = Self::cert_revocation_in(tx, public_id)? {
                    return Ok(recorded);
                }
                let owner = q(
                    tx,
                    "UPDATE academy.cert_grants SET status = 'revoked' WHERE public_id = $1 RETURNING user_id::text, cert_id",
                    &[&public_id],
                )?;
                let Some(owner) = owner.first() else {
                    return Err(Refusal::db(
                        "Cannot read properties of undefined (reading 'user_id')",
                        None,
                    ));
                };
                let (user_id, cert_id): (String, String) = (cell(owner, 0)?, cell(owner, 1)?);
                q(
                tx,
                &format!(
                    "INSERT INTO academy.cert_revocations (public_id, user_id, cert_id, proposed_by, approved_by, revoked_by, reason, revoked_at) \
                     VALUES ($1, $2::text::uuid, $3, $4, $5, $6::text::uuid, $7, $8::text::timestamptz) RETURNING {}",
                    revocation_columns()
                ),
                &[
                    &public_id,
                    &user_id,
                    &cert_id,
                    &pair.proposed_by,
                    &pair.approved_by,
                    &pair.operator_id,
                    &reason,
                    &iso(now),
                ],
            )?
            .first()
            .map(revocation_of)
            .transpose()?
            .ok_or_else(|| Refusal::db("the revocation insert returned no row", None))
            },
        )?;
        self.settle_revoked_xp(public_id);
        Ok(record)
    }

    /// `settleRevokedXp`: a revoked certificate's award is published again, then its reversal. Reported, never thrown.
    pub fn settle_revoked_xp(&self, public_id: &str) -> Option<Emit> {
        let read = self.with(|c| {
            q(
                c,
                &format!(
                    "SELECT user_id::text, cert_id, {}, idempotency_key, status FROM academy.cert_grants WHERE public_id = $1",
                    ms("granted_at")
                ),
                &[&public_id],
            )?
            .first()
            .map(|r| {
                Ok((
                    Grant {
                        user_id: cell(r, 0)?,
                        cert_id: cell(r, 1)?,
                        granted_at: cell(r, 2)?,
                        idempotency_key: cell(r, 3)?,
                    },
                    cell::<String>(r, 4)?,
                ))
            })
            .transpose()
        });
        // The read is outside the TypeScript's try: its failure is thrown to the caller there. A failure here is the
        // only path the TypeScript would have thrown, and the caller has already recorded the revocation.
        let (grant, status) = match read {
            Ok(Some(row)) => row,
            Ok(None) => return None,
            Err(err) => {
                log_error(&err, &[], "revoked certificate XP read failed");
                return None;
            }
        };
        if status != "revoked" {
            return None;
        }
        let out = self
            .xp
            .publish(&grant)
            .and_then(|_| self.xp.reverse(&grant));
        match out {
            Ok(e) => Some(e),
            Err(err) => {
                log_error(
                    &err,
                    &[("certId", &grant.cert_id)],
                    "revoked certificate XP reversal failed; a repeat revoke publishes it again",
                );
                None
            }
        }
    }

    /// `certException(userId, certId, tx)`: the exception already recorded, or none; an unpublished certificate, a held
    /// one or a revoked one refuses.
    pub fn cert_exception_in<C: GenericClient>(
        &self,
        c: &mut C,
        user_id: &str,
        cert_id: &str,
    ) -> Result<Option<Json>, Refusal> {
        self.known(cert_id)?;
        let rows = q(
            c,
            &format!(
                "SELECT {} FROM academy.cert_exceptions WHERE user_id = $1::text::uuid AND cert_id = $2",
                exception_columns()
            ),
            &[&user_id, &cert_id],
        )?;
        if let Some(r) = rows.first() {
            return exception_of(r).map(Some);
        }
        let grant = q(
            c,
            "SELECT status FROM academy.cert_grants WHERE user_id = $1::text::uuid AND cert_id = $2",
            &[&user_id, &cert_id],
        )?;
        if let Some(g) = grant.first() {
            if cell::<String>(g, 0)? == "revoked" {
                return Err(academy(
                    format!("academy.cert_revoked cert={cert_id}"),
                    "academy.cert_revoked",
                ));
            }
            return Err(academy(
                format!("academy.cert_already_granted cert={cert_id}"),
                "academy.cert_already_granted",
            ));
        }
        Ok(None)
    }

    /// `certException(userId, certId)`.
    pub fn cert_exception(&self, user_id: &str, cert_id: &str) -> Result<Option<Json>, Refusal> {
        self.known(cert_id)?;
        self.with(|c| self.cert_exception_in(c, user_id, cert_id))
    }

    /// `grantCertException`: the learner's one ordinary grant without every requirement, and one record naming both
    /// people, the operator and the reason. The XP is then published as for any grant. A repeat answers the first record.
    pub fn grant_cert_exception(
        &self,
        user_id: &str,
        cert_id: &str,
        reason: &str,
        pair: &Pair<'_>,
        now: i64,
    ) -> Result<Json, Refusal> {
        let reason = js_trim(reason);
        if reason.is_empty() || reason.encode_utf16().count() > 500 {
            return Err(academy(
                "An exception needs a reason",
                "academy.cert_invalid",
            ));
        }
        let record = db::transaction_retrying(
            self.store.pool()?,
            IsolationLevel::Serializable,
            |tx| {
                lock_extended(tx, &format!("cert-exception:{user_id}:{cert_id}"))?;
                if let Some(recorded) = self.cert_exception_in(tx, user_id, cert_id)? {
                    return Ok(recorded);
                }
                let public_id = random_public_id()?;
                let grant = q(
                    tx,
                    "INSERT INTO academy.cert_grants (user_id, cert_id, granted_at, idempotency_key, public_id, design_revision) \
                 VALUES ($1::text::uuid, $2, $3::text::timestamptz, $4, $5, \
                         (SELECT active_revision FROM academy.cert_designs WHERE cert_id = $2)) \
                 RETURNING public_id",
                    &[
                        &user_id,
                        &cert_id,
                        &iso(now),
                        &progress::idempotency_key(user_id, cert_id),
                        &public_id,
                    ],
                )?;
                let written: String = grant
                    .first()
                    .map(|r| cell(r, 0))
                    .transpose()?
                    .ok_or_else(|| Refusal::db("the grant insert returned no row", None))?;
                q(
                tx,
                &format!(
                    "INSERT INTO academy.cert_exceptions (public_id, user_id, cert_id, proposed_by, approved_by, granted_by, reason, granted_at) \
                     VALUES ($1, $2::text::uuid, $3, $4, $5, $6::text::uuid, $7, $8::text::timestamptz) RETURNING {}",
                    exception_columns()
                ),
                &[
                    &written,
                    &user_id,
                    &cert_id,
                    &pair.proposed_by,
                    &pair.approved_by,
                    &pair.operator_id,
                    &reason,
                    &iso(now),
                ],
            )?
            .first()
            .map(exception_of)
            .transpose()?
            .ok_or_else(|| Refusal::db("the exception insert returned no row", None))
            },
        )?;
        // The grant is the durable fact; the XP is its consequence, published after.
        let grant = self.existing_grant(user_id, cert_id)?;
        if let Some(held) = grant.filter(|h| !h.revoked)
            && let Err(err) = self.xp.publish(&held.grant)
        {
            log_error(
                &err,
                &[("certId", cert_id)],
                "exception XP publish failed; the next claim read re-publishes it",
            );
        }
        Ok(record)
    }

    /// `certTitle`: the published definition's title, or the programme's.
    fn cert_title(&self, cert_id: &str) -> Result<Option<String>, Refusal> {
        let Some(slug) = cert_id.strip_prefix(PROGRAMME_CERT_PREFIX) else {
            return Ok(self.definition(cert_id).map(|c| c.title.clone()));
        };
        // `programmeRecords.get(slug)`: the record's select, of which the title is read.
        self.with(|c| {
            q(
                c,
                "SELECT p.slug, p.title, p.summary, p.revision, p.updated_at, \
                        (SELECT array_agg(c.course_slug ORDER BY c.position) FROM academy.programme_courses c WHERE c.programme_slug = p.slug) \
                          AS course_slugs \
                   FROM academy.programmes p \
                  WHERE p.slug = $1 AND TRUE AND TRUE \
                  ORDER BY p.created_at DESC, p.slug \
                  LIMIT ALL",
                &[&slug],
            )?
            .first()
            .map(|r| cell(r, 1))
            .transpose()
        })
    }

    /// `certVerify(publicId)`: exactly the credential's fields; malformed and unknown codes refuse alike.
    pub fn cert_verify(&self, public_id: &str) -> Result<Json, Refusal> {
        if !is_public_id(public_id) {
            return Err(academy("Certificate not found", "academy.cert_not_found"));
        }
        let row = self.with(|c| {
            q(
                c,
                &format!(
                    "SELECT cert_id, {}, status, holder_name, {} FROM academy.cert_grants WHERE public_id = $1",
                    ms("granted_at"),
                    ms("holder_consent_at")
                ),
                &[&public_id],
            )?
            .first()
            .map(|r| {
                Ok((
                    cell::<String>(r, 0)?,
                    cell::<i64>(r, 1)?,
                    cell::<String>(r, 2)?,
                    cell::<Option<String>>(r, 3)?,
                    cell::<Option<i64>>(r, 4)?,
                ))
            })
            .transpose()
        })?;
        let Some((cert_id, granted_at, status, holder_name, consent_at)) = row else {
            return Err(academy("Certificate not found", "academy.cert_not_found"));
        };
        let Some(title) = self.cert_title(&cert_id)? else {
            return Err(academy(
                format!("academy.certificate_unpublished cert={cert_id}"),
                "academy.certificate_unpublished",
            ));
        };
        let mut body = vec![
            ("certId".to_owned(), Json::str(cert_id)),
            ("title".to_owned(), Json::str(title)),
            ("grantedAt".to_owned(), Json::str(iso(granted_at))),
            (
                "status".to_owned(),
                Json::str(if status == "valid" {
                    "valid"
                } else {
                    "revoked"
                }),
            ),
        ];
        if let (Some(name), Some(_)) = (holder_name, consent_at) {
            body.push(("holderName".to_owned(), Json::str(name)));
        }
        Ok(Json::Object(body))
    }

    /// `setCertHolderName`: the holder's consented name on one of their grants, once per client request.
    pub fn set_cert_holder_name(
        &self,
        user_id: &str,
        grant_id: Option<&str>,
        public_id: Option<&str>,
        holder_name: Option<&str>,
        client_request_id: &str,
        now: i64,
    ) -> Result<Json, Refusal> {
        let client_request_id = js_trim(client_request_id);
        if client_request_id.is_empty() {
            return Err(academy(
                "clientRequestId is required",
                "academy.holder_name_invalid",
            ));
        }
        let grant_id = grant_id.map(js_trim).filter(|s| !s.is_empty());
        let public_id = public_id.map(js_trim).filter(|s| !s.is_empty());
        if usize::from(grant_id.is_some()) + usize::from(public_id.is_some()) != 1 {
            return Err(academy(
                "pass grantId or publicId",
                "academy.holder_name_invalid",
            ));
        }
        let answer = |public_id: String, name: Option<String>, consent: Option<i64>| {
            Json::obj([
                ("publicId", Json::str(public_id)),
                ("holderName", name.map_or(Json::Null, Json::str)),
                (
                    "consentAt",
                    consent.map_or(Json::Null, |t| Json::str(iso(t))),
                ),
            ])
        };
        db::transaction_retrying(self.store.pool()?, IsolationLevel::Serializable, |tx| {
            lock_extended(tx, &format!("{user_id}:holder-name"))?;
            let replay = q(
                tx,
                &format!(
                    "SELECT public_id, holder_name, {} FROM academy.cert_holder_name_requests \
                     WHERE user_id = $1::text::uuid AND client_request_id = $2",
                    ms("consent_at")
                ),
                &[&user_id, &client_request_id],
            )?;
            if let Some(r) = replay.first() {
                return Ok(answer(cell(r, 0)?, cell(r, 1)?, cell(r, 2)?));
            }
            let name = normalise_holder_name(holder_name)?;
            let owned = q(
                tx,
                "SELECT public_id FROM academy.cert_grants \
                  WHERE user_id = $1::text::uuid \
                    AND (($2::text IS NOT NULL AND public_id = $2) OR ($3::text IS NOT NULL AND cert_id = $3)) \
                  FOR UPDATE",
                &[&user_id, &public_id, &grant_id],
            )?;
            let Some(owned) = owned.first() else {
                return Err(academy("Certificate not found", "academy.cert_not_found"));
            };
            let owned: String = cell(owned, 0)?;
            let consent = name.as_ref().map(|_| now);
            let consent_iso = consent.map(iso);
            exec(
                tx,
                "UPDATE academy.cert_grants SET holder_name = $1, holder_consent_at = $2::text::timestamptz \
                  WHERE user_id = $3::text::uuid AND public_id = $4",
                &[&name, &consent_iso, &user_id, &owned],
            )?;
            exec(
                tx,
                "INSERT INTO academy.cert_holder_name_requests (user_id, client_request_id, public_id, holder_name, consent_at) \
                 VALUES ($1::text::uuid, $2, $3, $4, $5::text::timestamptz)",
                &[&user_id, &client_request_id, &owned, &name, &consent_iso],
            )?;
            Ok(answer(owned, name, consent))
        })
    }
}

/// `assertSqlListLimit` (`sql-list-limit.ts`) and `assertCustomerListLimit` (`learning/limits.ts`), which read alike:
/// blank, non-finite or below one refuses; otherwise the floor, at most 200.
pub fn sql_list_limit(limit: Option<f64>, code: &str, label: &str) -> Result<i64, Refusal> {
    let refuse = || {
        academy(
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
        reason = "a finite whole number, at most 200 once capped"
    )]
    Ok((n as i64).min(200))
}
