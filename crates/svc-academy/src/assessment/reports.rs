//! Time-stamped grade reports of a course staff made (`curriculum/grade-reports.ts`). Their refusals are one
//! `defineRefusals` family (`GradeReportError`): the router's guard answers each as a `TRPCError` whose message is
//! `<code>: <message>`; anything else passes through unguarded.

use crate::db::Store;
use service_kit::json::Json;
use service_kit::money::is_js_whitespace;
use service_kit::trpc::TrpcError;

use super::gradebook::view_in;
use super::{
    array, cell, field, field_str, first, int, iso, ms, one, query, sha256_hex, with_client,
};
use crate::errors::Refusal;

/// `gradeReportRefusals.refuse(code, message)` as the guard answers it.
pub fn refuse<T>(code: &str, message: impl Into<String>) -> Result<T, Refusal> {
    let status = match code {
        "academy.course_not_found" | "academy.report_not_found" => "NOT_FOUND",
        "academy.report_out_of_order" => "CONFLICT",
        _ => "PRECONDITION_FAILED",
    };
    Err(Refusal::Trpc(TrpcError::caused(
        status,
        format!("{code}: {}", message.into()),
        code.to_owned(),
    )))
}

/// `csvField(value)`.
pub fn csv_field(value: &str) -> String {
    let formula = value
        .trim_start_matches(is_js_whitespace)
        .starts_with(['=', '+', '-', '@']);
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

fn s(j: Option<&Json>) -> String {
    match j {
        Some(Json::String(v)) => v.clone(),
        _ => String::new(),
    }
}

/// `gradeReportCsv(book, n, madeAt)`.
pub fn grade_report_csv(book: &Json, n: i64, made_at: i64) -> String {
    let policy = field(book, "policy").filter(|p| !matches!(p, Json::Null));
    let types = array(policy.and_then(|p| field(p, "types")));
    let items = array(field(book, "items"));
    let line = |cells: Vec<String>| {
        cells
            .iter()
            .map(|c| csv_field(c))
            .collect::<Vec<_>>()
            .join(",")
    };
    let mut lines = vec![
        line(vec![
            "grade report".into(),
            n.to_string(),
            "made at".into(),
            iso(made_at),
        ]),
        line(
            std::iter::once("learner".to_owned())
                .chain(items.iter().map(|i| s(field(i, "title"))))
                .chain(
                    types
                        .iter()
                        .map(|t| format!("{} ({})", s(field(t, "name")), s(field(t, "weight")))),
                )
                .chain(std::iter::once("total".to_owned()))
                .collect(),
        ),
    ];
    for l in array(field(book, "learners")) {
        let cells = array(field(l, "items"));
        let averages = array(field(l, "types"));
        let mut row = vec![s(field(l, "userId"))];
        for i in items {
            let id = field_str(i, "itemId");
            let c = cells.iter().find(|c| field_str(c, "itemId") == id);
            row.push(match c.and_then(|c| field_str(c, "state")) {
                Some("graded") => s(c.and_then(|c| field(c, "score"))),
                Some("pending") => "pending".to_owned(),
                _ => "not attempted".to_owned(),
            });
        }
        for t in types {
            let name = field_str(t, "name");
            // `new Map(...)`: the last type of that name wins.
            let avg = averages
                .iter()
                .rev()
                .find(|a| field_str(a, "name") == name)
                .and_then(|a| field(a, "average"));
            row.push(match avg {
                Some(Json::String(v)) => v.clone(),
                _ => "not attempted".to_owned(),
            });
        }
        row.push(match field(l, "total") {
            Some(Json::String(v)) => v.clone(),
            _ if policy.is_some() => "not attempted".to_owned(),
            _ => "no policy".to_owned(),
        });
        lines.push(line(row));
    }
    format!("{}\r\n", lines.join("\r\n"))
}

fn columns() -> String {
    format!(
        "course_id::text AS course_id, n, sha256, rows, made_by::text AS made_by, {} AS made_at",
        ms("made_at")
    )
}

fn meta(r: &postgres::Row) -> Result<Json, Refusal> {
    Ok(Json::obj([
        ("courseId", Json::String(cell(r, "course_id")?)),
        ("n", int(i64::from(cell::<i32>(r, "n")?))),
        ("madeAt", Json::String(iso(cell(r, "made_at")?))),
        ("madeBy", Json::String(cell(r, "made_by")?)),
        ("rows", int(i64::from(cell::<i32>(r, "rows")?))),
        ("sha256", Json::String(cell(r, "sha256")?)),
    ]))
}

fn course<C: postgres::GenericClient>(c: &mut C, course_id: &str) -> Result<(), Refusal> {
    if first(
        c,
        "SELECT id FROM academy.courses WHERE id = $1::text::uuid",
        &[&course_id],
    )?
    .is_none()
    {
        return refuse("academy.course_not_found", "no course has that id");
    }
    Ok(())
}

/// `list(courseId)`: the course's stored reports, newest first.
pub fn list(pool: &Store, course_id: &str) -> Result<Json, Refusal> {
    with_client(pool, |c| {
        course(c, course_id)?;
        let rows = query(
            c,
            &format!(
                "SELECT {} FROM academy.course_grade_reports WHERE course_id = $1::text::uuid ORDER BY n DESC",
                columns()
            ),
            &[&course_id],
        )?;
        Ok(Json::obj([
            ("courseId", Json::str(course_id)),
            (
                "reports",
                Json::Array(rows.iter().map(meta).collect::<Result<_, _>>()?),
            ),
        ]))
    })
}

/// `make(input)`: report `n`, made now when it is next, the stored one when it exists. `row_limit` is
/// `ACADEMY_GRADE_REPORT_ROWS`, none when blank.
pub fn make(
    pool: &Store,
    row_limit: Option<i64>,
    course_id: &str,
    n: i64,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let Some(limit) = row_limit else {
        return refuse(
            "academy.report_limit_unset",
            "academy.report_limit_unset: the owner has not set this value",
        );
    };
    super::begin(pool, |tx| {
        let key = format!("gradereport:{course_id}");
        query(tx, "SELECT pg_advisory_xact_lock(hashtext($1))", &[&key])?;
        course(tx, course_id)?;
        let n32 = i32::try_from(n).unwrap_or(i32::MAX);
        if let Some(existing) = first(
            tx,
            &format!(
                "SELECT {} FROM academy.course_grade_reports WHERE course_id = $1::text::uuid AND n = $2::int4",
                columns()
            ),
            &[&course_id, &n32],
        )? {
            return meta(&existing);
        }
        let next = i64::from(cell::<i32>(
            &one(
                tx,
                "SELECT coalesce(max(n), 0)::int + 1 AS next FROM academy.course_grade_reports WHERE course_id = $1::text::uuid",
                &[&course_id],
            )?,
            "next",
        )?);
        if n != next {
            return refuse(
                "academy.report_out_of_order",
                format!("the next report of this course is {next}, not {n}"),
            );
        }
        let book = view_in(tx, course_id)?;
        let learners = i64::try_from(array(field(&book, "learners")).len()).unwrap_or(i64::MAX);
        if learners > limit {
            return refuse(
                "academy.report_too_large",
                format!("{learners} learners, over the {limit} rows one report holds"),
            );
        }
        let csv = grade_report_csv(&book, n, now);
        let sha = sha256_hex(csv.as_bytes());
        let rows = i32::try_from(learners).unwrap_or(i32::MAX);
        let made = first(
            tx,
            &format!(
                "INSERT INTO academy.course_grade_reports (course_id, n, csv, sha256, rows, made_by, made_at) \
                 VALUES ($1::text::uuid, $2::int4, $3, $4, $5::int4, $6::text::uuid, $7::text::timestamptz) RETURNING {}",
                columns()
            ),
            &[&course_id, &n32, &csv, &sha, &rows, &operator, &iso(now)],
        )?
        .ok_or_else(|| Refusal::db("the insert returned no row", None))?;
        meta(&made)
    })
}

/// `file(courseId, n)`: a stored report with its CSV, exactly as made.
pub fn file(pool: &Store, course_id: &str, n: i64) -> Result<Json, Refusal> {
    with_client(pool, |c| {
        let n32 = i32::try_from(n).unwrap_or(i32::MAX);
        let found = first(
            c,
            &format!(
                "SELECT {}, csv FROM academy.course_grade_reports WHERE course_id = $1::text::uuid AND n = $2::int4",
                columns()
            ),
            &[&course_id, &n32],
        )?;
        let Some(found) = found else {
            return refuse(
                "academy.report_not_found",
                format!("course {course_id} has no report {n}"),
            );
        };
        let mut out = super::fields(&meta(&found)?).to_vec();
        out.push(("csv".to_owned(), Json::String(cell(&found, "csv")?)));
        Ok(Json::Object(out))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_are_quoted_and_formulas_kept_as_text() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("=SUM(A1)"), "'=SUM(A1)");
        assert_eq!(csv_field("  -1"), "'  -1");
        assert_eq!(csv_field("@x,y"), "\"'@x,y\"");
    }
}
