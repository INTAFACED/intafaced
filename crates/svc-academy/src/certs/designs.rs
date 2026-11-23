//! Certificate designs and the issued-certificates list (`certs/designs.ts`, `designs-router.ts`, AC-certificates-03).
//!
//! A design is saved as numbered revisions, each with who saved it and why; nothing is overwritten. Staff send the
//! revision they read: a save whose content is already the newest revision answers it and writes nothing, and a save
//! over an older one refuses `academy.cert_design_stale`. Activation refuses a revision with no signatory or a blank
//! disclaimer (the wording is the owner's, never filled in here). Every issued certificate keeps the revision it was
//! issued under. The issued list counts every certificate and shows the newest rows up to the owner's
//! `ACADEMY_CERT_ISSUED_ROWS`; an export stores the whole list as a CSV snapshot with its SHA-256 and refuses rather
//! than cut. A certificate carries no value: no money moves here.
//!
//! Refusals travel as `defineRefusals('CertDesignError')` sends them: the code's status, `<code>: <message>`, the code
//! as the cause. Anything else (a database failure) passes the family's guard as it is: a 500 with its own message.

use postgres::{GenericClient, IsolationLevel};
use sha2::{Digest, Sha256};

use service_kit::json::{self, Json};
use service_kit::jsregex;
use service_kit::schema::js_trim;
use service_kit::trpc::TrpcError;

use super::sql::{self, cell, exec, iso, lock, ms, q};
use crate::db::{self, Store};
use crate::errors::Refusal;

/// `certDesignRefusals`' statuses.
fn status_of(code: &str) -> &'static str {
    match code {
        "academy.cert_not_found" | "academy.cert_design_not_found" | "academy.report_not_found" => {
            "NOT_FOUND"
        }
        "academy.cert_design_stale" | "academy.report_out_of_order" => "CONFLICT",
        _ => "PRECONDITION_FAILED",
    }
}

/// `refuse(code, message)` through the family's guard.
pub fn refuse(code: &str, message: &str) -> Refusal {
    Refusal::Trpc(TrpcError::caused(
        status_of(code),
        format!("{code}: {message}"),
        code,
    ))
}

/// The family's guard: its own refusals as they are, anything else as tRPC meets it unguarded.
pub fn guard<T>(r: Result<T, Refusal>) -> Result<T, Refusal> {
    r.map_err(|e| match e {
        Refusal::Trpc(t) => Refusal::Trpc(t),
        other => Refusal::Trpc(other.unguarded()),
    })
}

/// `requireSetting(value, refusals, 'academy.report_limit_unset')`.
fn report_limit(issued_rows: Option<i64>) -> Result<i64, Refusal> {
    issued_rows.ok_or_else(|| {
        refuse(
            "academy.report_limit_unset",
            "academy.report_limit_unset: the owner has not set this value",
        )
    })
}

/// `AcademyCertDesignContent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Content {
    pub title: String,
    pub body: String,
    pub signatories: Vec<(String, String)>,
    pub disclaimer: Option<String>,
    pub language: String,
    pub size: String,
    pub effort_hours: Option<String>,
}

fn opt(s: &Option<String>) -> Json {
    s.as_ref().map_or(Json::Null, |v| Json::str(v.clone()))
}

impl Content {
    fn signatories_json(&self) -> Json {
        Json::Array(
            self.signatories
                .iter()
                .map(|(n, r)| {
                    Json::obj([
                        ("name", Json::str(n.clone())),
                        ("role", Json::str(r.clone())),
                    ])
                })
                .collect(),
        )
    }

    /// The content's fields in the schema's order.
    pub fn fields(&self) -> Vec<(String, Json)> {
        vec![
            ("title".to_owned(), Json::str(self.title.clone())),
            ("body".to_owned(), Json::str(self.body.clone())),
            ("signatories".to_owned(), self.signatories_json()),
            ("disclaimer".to_owned(), opt(&self.disclaimer)),
            ("language".to_owned(), Json::str(self.language.clone())),
            ("size".to_owned(), Json::str(self.size.clone())),
            ("effortHours".to_owned(), opt(&self.effort_hours)),
        ]
    }

    /// `normaliseDesign`: trimmed, a blank disclaimer read as none.
    pub fn normalised(&self) -> Content {
        let disclaimer = self.disclaimer.as_deref().map_or("", js_trim);
        Content {
            title: js_trim(&self.title).to_owned(),
            body: js_trim(&self.body).to_owned(),
            signatories: self
                .signatories
                .iter()
                .map(|(n, r)| (js_trim(n).to_owned(), js_trim(r).to_owned()))
                .collect(),
            disclaimer: (!disclaimer.is_empty()).then(|| disclaimer.to_owned()),
            language: self.language.clone(),
            size: self.size.clone(),
            effort_hours: self.effort_hours.clone(),
        }
    }
}

/// `assertActivatable`.
pub fn assert_activatable(content: &Content) -> Result<(), Refusal> {
    if content.signatories.is_empty() {
        return Err(refuse(
            "academy.cert_signatory_missing",
            "a design needs at least one signatory to be active",
        ));
    }
    if content
        .disclaimer
        .as_deref()
        .is_none_or(|d| js_trim(d).is_empty())
    {
        return Err(refuse(
            "academy.cert_disclaimer_unset",
            "a design needs its disclaimer text to be active",
        ));
    }
    Ok(())
}

/// One stored revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revision {
    pub cert_id: String,
    pub revision: i64,
    pub content: Content,
    pub saved_by: String,
    pub reason: String,
    pub saved_at: i64,
}

impl Revision {
    /// `academyCertDesignRevisionSchema`.
    fn json(&self) -> Json {
        let mut f = self.content.fields();
        f.extend([
            ("revision".to_owned(), Json::int(self.revision)),
            ("savedBy".to_owned(), Json::str(self.saved_by.clone())),
            ("savedAt".to_owned(), Json::str(iso(self.saved_at))),
            ("reason".to_owned(), Json::str(self.reason.clone())),
        ]);
        Json::Object(f)
    }

    /// `academyIssuedCertDesignSchema`: the content and its revision.
    pub fn printed_json(&self) -> Json {
        let mut f = self.content.fields();
        f.push(("revision".to_owned(), Json::int(self.revision)));
        Json::Object(f)
    }
}

fn revision_columns() -> String {
    format!(
        "cert_id, revision, title, body, signatories::text, disclaimer, language, size, effort_hours, saved_by::text, reason, {}",
        ms("saved_at")
    )
}

fn signatories_of(text: &str) -> Result<Vec<(String, String)>, Refusal> {
    let parsed = json::parse(text).map_err(|e| Refusal::db(format!("{e:?}"), None))?;
    let Json::Array(items) = parsed else {
        return Ok(Vec::new());
    };
    Ok(items
        .iter()
        .map(|s| {
            let f = |k: &str| match s.get(k) {
                Some(Json::String(v)) => v.clone(),
                _ => String::new(),
            };
            (f("name"), f("role"))
        })
        .collect())
}

fn revision_of(r: &postgres::Row) -> Result<Revision, Refusal> {
    Ok(Revision {
        cert_id: cell(r, 0)?,
        revision: sql::int(cell(r, 1)?),
        content: Content {
            title: cell(r, 2)?,
            body: cell(r, 3)?,
            signatories: signatories_of(&cell::<String>(r, 4)?)?,
            disclaimer: cell(r, 5)?,
            language: cell(r, 6)?,
            size: cell(r, 7)?,
            effort_hours: cell(r, 8)?,
        },
        saved_by: cell(r, 9)?,
        reason: cell(r, 10)?,
        saved_at: cell(r, 11)?,
    })
}

struct Head {
    revision: i32,
    active_revision: Option<i32>,
    activated_by: Option<String>,
    activated_at: Option<i64>,
}

fn head<C: GenericClient>(c: &mut C, cert_id: &str) -> Result<Option<Head>, Refusal> {
    q(
        c,
        &format!(
            "SELECT revision, active_revision, activated_by::text, {} FROM academy.cert_designs WHERE cert_id = $1",
            ms("activated_at")
        ),
        &[&cert_id],
    )?
    .first()
    .map(|r| {
        Ok(Head {
            revision: cell(r, 0)?,
            active_revision: cell(r, 1)?,
            activated_by: cell(r, 2)?,
            activated_at: cell(r, 3)?,
        })
    })
    .transpose()
}

fn current<C: GenericClient>(c: &mut C, cert_id: &str, revision: i32) -> Result<Revision, Refusal> {
    q(
        c,
        &format!(
            "SELECT {} FROM academy.cert_design_revisions WHERE cert_id = $1 AND revision = $2",
            revision_columns()
        ),
        &[&cert_id, &revision],
    )?
    .first()
    .map(revision_of)
    .transpose()?
    // `current!`: the head names a revision the foreign key keeps.
    .ok_or_else(|| {
        Refusal::db(
            "Cannot read properties of undefined (reading 'title')",
            None,
        )
    })
}

/// `CertDesigns`: the published certificates a design may belong to, and the owner's list size.
pub struct Designs<'a> {
    pub store: &'a Store,
    /// `(id, title)` in the catalogue's order.
    pub catalog: Vec<(String, String)>,
    /// `ACADEMY_CERT_ISSUED_ROWS`: none while blank.
    pub issued_rows: Option<i64>,
}

/// A design read: `academyCertDesignSchema`, with what `saved` needs.
pub struct Design {
    pub json: Json,
    pub active_revision: Option<i64>,
    pub issued: Vec<(Option<i64>, i64)>,
}

impl Designs<'_> {
    fn assert_known(&self, cert_id: &str) -> Result<&str, Refusal> {
        self.catalog
            .iter()
            .find(|(id, _)| id == cert_id)
            .map(|(_, t)| t.as_str())
            .ok_or_else(|| {
                refuse(
                    "academy.cert_not_found",
                    &format!("no published certificate {cert_id}"),
                )
            })
    }

    /// `list()`: every published certificate with its design, in the catalogue's order.
    pub fn list(&self) -> Result<Json, Refusal> {
        let mut items = Vec::new();
        for (id, _) in &self.catalog {
            items.push(db::with_client(self.store.pool()?, |c| self.design_in(c, id))?.json);
        }
        Ok(Json::obj([("items", Json::Array(items))]))
    }

    /// `design(certId)`.
    pub fn design(&self, cert_id: &str) -> Result<Json, Refusal> {
        self.assert_known(cert_id)?;
        db::with_client(self.store.pool()?, |c| self.design_in(c, cert_id)).map(|d| d.json)
    }

    fn design_in<C: GenericClient>(&self, c: &mut C, cert_id: &str) -> Result<Design, Refusal> {
        let title = self.assert_known(cert_id)?.to_owned();
        let head = head(c, cert_id)?;
        let issued: Vec<(Option<i64>, i64)> = q(
            c,
            "SELECT design_revision AS revision, count(*)::int AS count FROM academy.cert_grants \
             WHERE cert_id = $1 GROUP BY design_revision ORDER BY design_revision NULLS FIRST",
            &[&cert_id],
        )?
        .iter()
        .map(|r| {
            Ok((
                cell::<Option<i32>>(r, 0)?.map(sql::int),
                sql::int(cell(r, 1)?),
            ))
        })
        .collect::<Result<_, Refusal>>()?;
        let issued_json = Json::Array(
            issued
                .iter()
                .map(|(rev, n)| {
                    Json::obj([
                        ("revision", rev.map_or(Json::Null, Json::int)),
                        ("count", Json::int(*n)),
                    ])
                })
                .collect(),
        );
        let Some(head) = head else {
            return Ok(Design {
                json: Json::obj([
                    ("certId", Json::str(cert_id)),
                    ("title", Json::str(title)),
                    ("design", Json::Null),
                    ("issuedByRevision", issued_json),
                ]),
                active_revision: None,
                issued,
            });
        };
        let cur = current(c, cert_id, head.revision)?;
        let active = head.active_revision.map(sql::int);
        Ok(Design {
            json: Json::obj([
                ("certId", Json::str(cert_id)),
                ("title", Json::str(title)),
                (
                    "design",
                    Json::obj([
                        ("current", cur.json()),
                        ("activeRevision", active.map_or(Json::Null, Json::int)),
                        (
                            "activatedAt",
                            head.activated_at.map_or(Json::Null, |a| Json::str(iso(a))),
                        ),
                        ("activatedBy", opt(&head.activated_by)),
                    ]),
                ),
                ("issuedByRevision", issued_json),
            ]),
            active_revision: active,
            issued,
        })
    }

    /// `saved`: the design and, while it is active, how many issued certificates keep an earlier revision.
    fn saved<C: GenericClient>(&self, c: &mut C, cert_id: &str) -> Result<Json, Refusal> {
        let d = self.design_in(c, cert_id)?;
        let warning = d.active_revision.and_then(|active| {
            let earlier: i64 = d
                .issued
                .iter()
                .filter(|(rev, _)| *rev != Some(active))
                .map(|(_, n)| n)
                .sum();
            (earlier > 0).then(|| {
                Json::obj([
                    ("issuedKeepingEarlier", Json::int(earlier)),
                    ("activeRevision", Json::int(active)),
                ])
            })
        });
        Ok(Json::obj([
            ("design", d.json),
            ("warning", warning.unwrap_or(Json::Null)),
        ]))
    }

    /// `save`: a new revision over the one staff read; an active design moves to it and stays active.
    pub fn save(
        &self,
        cert_id: &str,
        content: &Content,
        revision: i64,
        reason: &str,
        operator_id: &str,
        now: i64,
    ) -> Result<Json, Refusal> {
        self.assert_known(cert_id)?;
        let content = content.normalised();
        db::transaction(self.store.pool()?, IsolationLevel::ReadCommitted, |tx| {
            lock(tx, &format!("certdesign:{cert_id}"))?;
            let head = head(tx, cert_id)?;
            let stored = head.as_ref().map_or(0, |h| sql::int(h.revision));
            if let Some(h) = &head {
                let cur = current(tx, cert_id, h.revision)?;
                // A replay of the save that made the newest revision answers it and writes nothing.
                if revision == stored - 1 && cur.content == content {
                    return self.saved(tx, cert_id);
                }
            }
            if revision != stored {
                return Err(refuse(
                    "academy.cert_design_stale",
                    &format!("the design is at revision {stored}, not {revision}"),
                ));
            }
            if head.as_ref().is_some_and(|h| h.active_revision.is_some()) {
                assert_activatable(&content)?;
            }
            let next = i32::try_from(stored + 1).unwrap_or(i32::MAX);
            exec(
                tx,
                "INSERT INTO academy.cert_design_revisions (cert_id, revision, title, body, signatories, disclaimer, language, size, \
                                                           effort_hours, saved_by, reason, saved_at) \
                 VALUES ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8, $9, $10::text::uuid, $11, $12::text::timestamptz)",
                &[
                    &cert_id,
                    &next,
                    &content.title,
                    &content.body,
                    &content.signatories_json().compact(),
                    &content.disclaimer,
                    &content.language,
                    &content.size,
                    &content.effort_hours,
                    &operator_id,
                    &js_trim(reason),
                    &iso(now),
                ],
            )?;
            if head.is_some() {
                exec(
                    tx,
                    "UPDATE academy.cert_designs \
                        SET revision = $1, \
                            active_revision = CASE WHEN active_revision IS NULL THEN NULL ELSE $2::int END \
                      WHERE cert_id = $3",
                    &[&next, &next, &cert_id],
                )?;
            } else {
                exec(
                    tx,
                    "INSERT INTO academy.cert_designs (cert_id, revision) VALUES ($1, $2)",
                    &[&cert_id, &next],
                )?;
            }
            self.saved(tx, cert_id)
        })
    }

    /// `activate`: makes the revision staff read the one certificates are issued under; a repeat answers unchanged.
    pub fn activate(
        &self,
        cert_id: &str,
        revision: i64,
        reason: &str,
        operator_id: &str,
        now: i64,
    ) -> Result<Json, Refusal> {
        self.assert_known(cert_id)?;
        db::transaction(self.store.pool()?, IsolationLevel::ReadCommitted, |tx| {
            lock(tx, &format!("certdesign:{cert_id}"))?;
            let Some(h) = head(tx, cert_id)? else {
                return Err(refuse(
                    "academy.cert_design_not_found",
                    &format!("certificate {cert_id} has no design yet"),
                ));
            };
            if sql::int(h.revision) != revision {
                return Err(refuse(
                    "academy.cert_design_stale",
                    &format!("the design is at revision {}, not {revision}", h.revision),
                ));
            }
            if h.active_revision == Some(h.revision) {
                return self.design_in(tx, cert_id).map(|d| d.json);
            }
            let cur = current(tx, cert_id, h.revision)?;
            assert_activatable(&cur.content)?;
            exec(
                tx,
                "UPDATE academy.cert_designs \
                    SET active_revision = $1, activated_by = $2::text::uuid, activated_at = $3::text::timestamptz, \
                        activate_reason = $4 \
                  WHERE cert_id = $5",
                &[
                    &h.revision,
                    &operator_id,
                    &iso(now),
                    &js_trim(reason),
                    &cert_id,
                ],
            )?;
            self.design_in(tx, cert_id).map(|d| d.json)
        })
    }

    /// `deactivate`: certificates issued from now print no design; those issued keep theirs.
    pub fn deactivate(
        &self,
        cert_id: &str,
        reason: &str,
        operator_id: &str,
        now: i64,
    ) -> Result<Json, Refusal> {
        self.assert_known(cert_id)?;
        db::transaction(self.store.pool()?, IsolationLevel::ReadCommitted, |tx| {
            lock(tx, &format!("certdesign:{cert_id}"))?;
            let Some(h) = head(tx, cert_id)? else {
                return Err(refuse(
                    "academy.cert_design_not_found",
                    &format!("certificate {cert_id} has no design yet"),
                ));
            };
            if h.active_revision.is_none() {
                return self.design_in(tx, cert_id).map(|d| d.json);
            }
            exec(
                tx,
                "UPDATE academy.cert_designs \
                    SET active_revision = NULL, activated_by = $1::text::uuid, activated_at = $2::text::timestamptz, \
                        activate_reason = $3 \
                  WHERE cert_id = $4",
                &[&operator_id, &iso(now), &js_trim(reason), &cert_id],
            )?;
            self.design_in(tx, cert_id).map(|d| d.json)
        })
    }

    /// `issued(certificate)`: counts over every issued certificate and the newest rows up to the owner's list size.
    pub fn issued(&self, certificate: Option<&str>) -> Result<Json, Refusal> {
        let limit = report_limit(self.issued_rows)?;
        let counts: Vec<(String, i64, i64)> = db::with_client(self.store.pool()?, |c| {
            q(
                c,
                "SELECT cert_id, count(*) FILTER (WHERE status <> 'revoked')::int AS valid, \
                        count(*) FILTER (WHERE status = 'revoked')::int AS revoked \
                   FROM academy.cert_grants \
                  WHERE $1::text IS NULL OR cert_id = $1 \
                  GROUP BY cert_id ORDER BY cert_id",
                &[&certificate],
            )?
            .iter()
            .map(|r| Ok((cell(r, 0)?, sql::int(cell(r, 1)?), sql::int(cell(r, 2)?))))
            .collect()
        })?;
        let items = db::with_client(self.store.pool()?, |c| {
            issued_rows_of(c, certificate, limit)
        })?;
        let total: i64 = counts.iter().map(|(_, v, r)| v + r).sum();
        Ok(Json::obj([
            (
                "counts",
                Json::Array(
                    counts
                        .iter()
                        .map(|(id, v, r)| {
                            Json::obj([
                                ("certId", Json::str(id.clone())),
                                ("valid", Json::int(*v)),
                                ("revoked", Json::int(*r)),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("total", Json::int(total)),
            (
                "items",
                Json::Array(items.iter().map(IssuedRow::json).collect()),
            ),
        ]))
    }

    /// `exports()`: every stored export, newest first.
    pub fn exports(&self) -> Result<Json, Refusal> {
        let rows = db::with_client(self.store.pool()?, |c| {
            q(
                c,
                &format!(
                    "SELECT {} FROM academy.cert_issued_exports ORDER BY n DESC",
                    export_columns()
                ),
                &[],
            )
        })?;
        let exports = rows.iter().map(export_of).collect::<Result<Vec<_>, _>>()?;
        Ok(Json::obj([("exports", Json::Array(exports))]))
    }

    /// `makeExport(n)`: made now when n is next, the stored one when it already exists.
    pub fn make_export(&self, n: i64, operator_id: &str, now: i64) -> Result<Json, Refusal> {
        let limit = report_limit(self.issued_rows)?;
        let n32 = i32::try_from(n).unwrap_or(i32::MAX);
        db::transaction(self.store.pool()?, IsolationLevel::ReadCommitted, |tx| {
            q(
                tx,
                "SELECT pg_advisory_xact_lock(hashtext('certexport'))",
                &[],
            )?;
            let existing = q(
                tx,
                &format!(
                    "SELECT {} FROM academy.cert_issued_exports WHERE n = $1",
                    export_columns()
                ),
                &[&n32],
            )?;
            if let Some(e) = existing.first() {
                return export_of(e);
            }
            let next: i64 = q(
                tx,
                "SELECT coalesce(max(n), 0)::int + 1 AS next FROM academy.cert_issued_exports",
                &[],
            )?
            .first()
            .map_or(Ok(1), |r| cell::<i32>(r, 0).map(sql::int))?;
            if n != next {
                return Err(refuse(
                    "academy.report_out_of_order",
                    &format!("the next export is {next}, not {n}"),
                ));
            }
            // One more than the limit is read, so a list too long for one export refuses instead of being cut.
            let rows = issued_rows_of(tx, None, limit + 1)?;
            if i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit {
                return Err(refuse(
                    "academy.report_too_large",
                    &format!("more than the {limit} rows one export holds"),
                ));
            }
            let csv = issued_export_csv(n, now, &rows);
            let sha256: String = Sha256::digest(csv.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            let count = i32::try_from(rows.len()).unwrap_or(i32::MAX);
            let made = q(
                tx,
                &format!(
                    "INSERT INTO academy.cert_issued_exports (n, csv, sha256, rows, made_by, made_at) \
                     VALUES ($1, $2, $3, $4, $5::text::uuid, $6::text::timestamptz) RETURNING {}",
                    export_columns()
                ),
                &[&n32, &csv, &sha256, &count, &operator_id, &iso(now)],
            )?;
            made.first()
                .map(export_of)
                .transpose()?
                .ok_or_else(|| Refusal::db("the export insert returned no row", None))
        })
    }

    /// `exportFile(n)`.
    pub fn export_file(&self, n: i64) -> Result<Json, Refusal> {
        let n32 = i32::try_from(n).unwrap_or(i32::MAX);
        let rows = db::with_client(self.store.pool()?, |c| {
            q(
                c,
                &format!(
                    "SELECT {}, csv FROM academy.cert_issued_exports WHERE n = $1",
                    export_columns()
                ),
                &[&n32],
            )
        })?;
        let Some(found) = rows.first() else {
            return Err(refuse(
                "academy.report_not_found",
                &format!("no export {n}"),
            ));
        };
        let Json::Object(mut f) = export_of(found)? else {
            return Err(Refusal::db("an export is an object", None));
        };
        f.push(("csv".to_owned(), Json::str(cell::<String>(found, 5)?)));
        Ok(Json::Object(f))
    }
}

/// `printed(keys)`: what each issued revision prints, by `<cert>:<revision>`.
pub fn printed<C: GenericClient>(
    c: &mut C,
    keys: &[(String, i32)],
) -> Result<Vec<(String, Revision)>, Refusal> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let cert_ids: Vec<String> = keys.iter().map(|(c, _)| c.clone()).collect();
    let revisions: Vec<i32> = keys.iter().map(|(_, r)| *r).collect();
    q(
        c,
        &format!(
            "SELECT {} FROM academy.cert_design_revisions \
             WHERE (cert_id, revision) IN (SELECT * FROM unnest($1::text[], $2::int[]))",
            revision_columns()
        ),
        &[&cert_ids, &revisions],
    )?
    .iter()
    .map(|r| {
        let rev = revision_of(r)?;
        Ok((format!("{}:{}", rev.cert_id, rev.revision), rev))
    })
    .collect()
}

/// One issued row.
pub struct IssuedRow {
    pub public_id: String,
    pub account_id: String,
    pub cert_id: String,
    pub status: &'static str,
    pub granted_at: i64,
    pub design_revision: Option<i64>,
    pub exception_reason: Option<String>,
}

impl IssuedRow {
    fn json(&self) -> Json {
        Json::obj([
            ("publicId", Json::str(self.public_id.clone())),
            ("accountId", Json::str(self.account_id.clone())),
            ("certId", Json::str(self.cert_id.clone())),
            ("status", Json::str(self.status)),
            ("grantedAt", Json::str(iso(self.granted_at))),
            (
                "designRevision",
                self.design_revision.map_or(Json::Null, Json::int),
            ),
            ("exceptionReason", opt(&self.exception_reason)),
        ])
    }
}

fn issued_rows_of<C: GenericClient>(
    c: &mut C,
    certificate: Option<&str>,
    limit: i64,
) -> Result<Vec<IssuedRow>, Refusal> {
    q(
        c,
        &format!(
            "SELECT g.public_id, g.user_id::text, g.cert_id, g.status, {}, g.design_revision, x.reason AS exception_reason \
               FROM academy.cert_grants g \
               LEFT JOIN academy.cert_exceptions x ON x.public_id = g.public_id \
              WHERE $1::text IS NULL OR g.cert_id = $1 \
              ORDER BY g.granted_at DESC, g.public_id \
              LIMIT $2",
            ms("g.granted_at")
        ),
        &[&certificate, &limit],
    )?
    .iter()
    .map(|r| {
        Ok(IssuedRow {
            public_id: cell(r, 0)?,
            account_id: cell(r, 1)?,
            cert_id: cell(r, 2)?,
            status: if cell::<String>(r, 3)? == "revoked" { "revoked" } else { "valid" },
            granted_at: cell(r, 4)?,
            design_revision: cell::<Option<i32>>(r, 5)?.map(sql::int),
            exception_reason: cell(r, 6)?,
        })
    })
    .collect()
}

fn export_columns() -> String {
    format!("n, sha256, rows, made_by::text, {}", ms("made_at"))
}

fn export_of(r: &postgres::Row) -> Result<Json, Refusal> {
    Ok(Json::obj([
        ("n", Json::int(sql::int(cell(r, 0)?))),
        ("madeAt", Json::str(iso(cell(r, 4)?))),
        ("madeBy", Json::str(cell::<String>(r, 3)?)),
        ("rows", Json::int(sql::int(cell(r, 2)?))),
        ("sha256", Json::str(cell::<String>(r, 1)?)),
    ]))
}

/// `csvField` (`curriculum/grade-reports.ts`): a formula-looking cell is quoted with `'`, a cell holding a quote, comma
/// or line break is wrapped in quotes.
pub fn csv_field(value: &str) -> String {
    let formula = value
        .encode_utf16()
        .find(|u| !jsregex::is_js_space(*u))
        .is_some_and(|u| matches!(u, 0x3d | 0x2b | 0x2d | 0x40));
    let text = if formula {
        format!("'{value}")
    } else {
        value.to_owned()
    };
    if text.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

/// `issuedExportCsv`: one line naming the export, the header, then one row per issued certificate, CRLF.
pub fn issued_export_csv(n: i64, made_at: i64, rows: &[IssuedRow]) -> String {
    let line = |cells: Vec<String>| {
        cells
            .iter()
            .map(|c| csv_field(c))
            .collect::<Vec<_>>()
            .join(",")
    };
    let mut lines = vec![
        line(vec![
            "issued certificates export".to_owned(),
            n.to_string(),
            "made at".to_owned(),
            iso(made_at),
        ]),
        line(
            [
                "code",
                "account",
                "certificate",
                "status",
                "issued at",
                "design revision",
            ]
            .iter()
            .map(|s| (*s).to_owned())
            .collect(),
        ),
    ];
    for r in rows {
        lines.push(line(vec![
            r.public_id.clone(),
            r.account_id.clone(),
            r.cert_id.clone(),
            r.status.to_owned(),
            iso(r.granted_at),
            r.design_revision
                .map_or("none".to_owned(), |d| d.to_string()),
        ]));
    }
    format!("{}\r\n", lines.join("\r\n"))
}
