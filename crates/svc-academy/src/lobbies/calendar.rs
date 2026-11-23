//! RFC 5545 for one session (`learning/calendar.ts`): the instant is UTC, said with a trailing `Z` and
//! `X-WR-TIMEZONE:UTC`; no local zone is stored and none is invented.

use service_kit::time::Instant;

/// `formatUtcIcs`: `YYYYMMDDTHHMMSSZ` from the ISO form (the year as JavaScript prints it).
pub fn format_utc_ics(at: Instant) -> String {
    // `2026-12-01T15:30:00.000Z` → `20261201T153000Z`.
    let iso = at.iso();
    let (date, time) = iso.split_once('T').unwrap_or((&iso, ""));
    let date: String = date.chars().filter(|c| *c != '-').collect();
    let date = date.trim_start_matches('+').to_owned();
    let hms: String = time.chars().take(8).filter(|c| *c != ':').collect();
    format!("{date}T{hms}Z")
}

/// `escapeIcs`: backslash, newline, semicolon and comma, in that order.
fn escape_ics(text: &str) -> String {
    text.replace('\\', r"\\")
        .replace('\n', r"\n")
        .replace(';', r"\;")
        .replace(',', r"\,")
}

/// `sessionCalendarText`.
pub fn session_calendar_text(
    session_id: &str,
    title: &str,
    starts_at: Instant,
    ends_at: Option<Instant>,
    now: Instant,
) -> String {
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_owned(),
        "VERSION:2.0".to_owned(),
        "PRODID:-//Intafaced//Academy//EN".to_owned(),
        "CALSCALE:GREGORIAN".to_owned(),
        "METHOD:PUBLISH".to_owned(),
        "X-WR-TIMEZONE:UTC".to_owned(),
        "BEGIN:VEVENT".to_owned(),
        format!("UID:{session_id}@academy"),
        format!("DTSTAMP:{}", format_utc_ics(now)),
        format!("DTSTART:{}", format_utc_ics(starts_at)),
    ];
    if let Some(end) = ends_at {
        lines.push(format!("DTEND:{}", format_utc_ics(end)));
    }
    lines.push(format!("SUMMARY:{}", escape_ics(title)));
    lines.push("END:VEVENT".to_owned());
    lines.push("END:VCALENDAR".to_owned());
    format!("{}\r\n", lines.join("\r\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_calendar_says_utc_and_escapes_the_title() {
        let starts = Instant(1_796_139_000_000); // 2026-12-01T15:30:00.000Z
        assert_eq!(format_utc_ics(starts), "20261201T153000Z");
        let text = session_calendar_text("s-1", "A; b, c\\d\ne", starts, None, Instant(0));
        assert_eq!(
            text,
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Intafaced//Academy//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-TIMEZONE:UTC\r\nBEGIN:VEVENT\r\nUID:s-1@academy\r\nDTSTAMP:19700101T000000Z\r\nDTSTART:20261201T153000Z\r\nSUMMARY:A\\; b\\, c\\\\d\\ne\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
        );
        assert!(
            session_calendar_text("s", "t", starts, Some(Instant(1_796_142_600_000)), starts)
                .contains("DTEND:20261201T163000Z")
        );
    }
}
