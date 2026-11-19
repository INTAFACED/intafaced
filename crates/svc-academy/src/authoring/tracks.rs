//! Videos on curriculum items and their caption tracks (`video/tracks.ts`): the WebVTT and SRT readers, and the item →
//! video and video → tracks rows. A track is stored as uploaded and read back as cues; nothing invents a cue.

use postgres::GenericClient;

use service_kit::json::Json;
use crate::db::Store;
use service_kit::schema::js_trim;

use super::refuse;
use super::sql::{self, at, first, get, query};
use crate::errors::Refusal;

const MAX_CUES: usize = 5000;
const MAX_CUE_TEXT: usize = 1000;

/// One cue, in milliseconds (a JavaScript number).
#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

impl Cue {
    fn json(&self) -> Json {
        Json::obj([
            ("startMs", Json::int(self.start_ms)),
            ("endMs", Json::int(self.end_ms)),
            ("text", Json::str(&self.text)),
        ])
    }
}

/// One language's track.
#[derive(Debug, Clone, PartialEq)]
pub struct Track {
    pub language: String,
    pub label: String,
    pub cues: Vec<Cue>,
}

impl Track {
    pub fn json(&self) -> Json {
        Json::obj([
            ("language", Json::str(&self.language)),
            ("label", Json::str(&self.label)),
            ("cues", Json::Array(self.cues.iter().map(Cue::json).collect())),
        ])
    }
}

fn invalid<T>(why: &str) -> Result<T, Refusal> {
    refuse(format!("academy.captions_invalid {why}"), "academy.captions_invalid")
}

/// `s.slice(0, n)` in UTF-16 code units.
fn js_slice(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn num(s: &str) -> Option<i64> {
    s.parse().ok()
}

/// `((h * 60 + m) * 60 + s) * 1000 + ms`; hours past i64 are not a timestamp here (JavaScript would read a float).
fn stamp_ms(h: i64, m: i64, s: i64, frac: i64) -> Option<i64> {
    h.checked_mul(60)?.checked_add(m)?.checked_mul(60)?.checked_add(s)?.checked_mul(1000)?.checked_add(frac)
}

/// `[0-5]\d`.
fn sixty(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 2 && matches!(b.first(), Some(b'0'..=b'5')) && b.get(1).is_some_and(u8::is_ascii_digit)
}

/// `^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$`.
fn vtt_stamp(stamp: &str) -> Option<i64> {
    let (head, frac) = stamp.rsplit_once('.')?;
    if frac.len() != 3 || !digits(frac) {
        return None;
    }
    let parts: Vec<&str> = head.split(':').collect();
    let (h, m, s) = match parts.as_slice() {
        [m, s] => (None, *m, *s),
        [h, m, s] => (Some(*h), *m, *s),
        _ => return None,
    };
    if h.is_some_and(|h| h.len() < 2 || !digits(h)) || !sixty(m) || !sixty(s) {
        return None;
    }
    stamp_ms(h.map_or(Some(0), num)?, num(m)?, num(s)?, num(frac)?)
}

/// `^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$`.
fn srt_stamp(stamp: &str) -> Option<i64> {
    let (head, frac) = stamp.rsplit_once(',')?;
    if frac.len() != 3 || !digits(frac) {
        return None;
    }
    let [h, m, s] = head.split(':').collect::<Vec<_>>()[..] else {
        return None;
    };
    if h.len() < 2 || !digits(h) || !sixty(m) || !sixty(s) {
        return None;
    }
    stamp_ms(num(h)?, num(m)?, num(s)?, num(frac)?)
}

fn lines_of(text: &str) -> Vec<&str> {
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = Vec::new();
    let mut rest = t;
    loop {
        match rest.find(['\r', '\n']) {
            Some(i) => {
                out.push(rest.get(..i).unwrap_or(""));
                let skip = if rest.get(i..i + 2) == Some("\r\n") { 2 } else { 1 };
                rest = rest.get(i + skip..).unwrap_or("");
            }
            None => {
                out.push(rest);
                return out;
            }
        }
    }
}

/// `[ \t]+` split's first piece.
fn first_token(s: &str) -> &str {
    s.split([' ', '\t']).next().unwrap_or("")
}

fn sort(cues: &mut [Cue]) {
    cues.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then(a.end_ms.cmp(&b.end_ms)));
}

/// `.` in a JavaScript regex: anything but a line terminator.
fn no_terminator(s: &str) -> bool {
    !s.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// `parseVtt`.
pub fn parse_vtt(vtt: &str) -> Result<Vec<Cue>, Refusal> {
    let lines = lines_of(vtt);
    let head = lines.first().copied().unwrap_or("");
    let ok = head.strip_prefix("WEBVTT").is_some_and(|rest| {
        rest.is_empty() || ((rest.starts_with(' ') || rest.starts_with('\t')) && no_terminator(rest))
    });
    if !ok {
        return invalid("the file does not start with WEBVTT");
    }
    let line = |i: usize| lines.get(i).copied().unwrap_or("");
    let mut cues = Vec::new();
    let mut i = 1;
    while i < lines.len() && !js_trim(line(i)).is_empty() {
        if line(i).contains("-->") {
            return invalid(&format!("line {}: a cue needs a blank line after the header", i + 1));
        }
        i += 1;
    }
    while i < lines.len() {
        while i < lines.len() && js_trim(line(i)).is_empty() {
            i += 1;
        }
        if i >= lines.len() {
            break;
        }
        let start = i;
        while i < lines.len() && !js_trim(line(i)).is_empty() {
            i += 1;
        }
        let block: Vec<&str> = lines.get(start..i).unwrap_or_default().to_vec();
        let b0 = block.first().copied().unwrap_or("");
        let skipped = ["NOTE", "STYLE", "REGION"].iter().any(|k| {
            b0.strip_prefix(k)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\t'))
        });
        if skipped {
            continue;
        }
        let at = block.iter().position(|l| l.contains("-->"));
        let Some(at) = at.filter(|a| *a <= 1) else {
            return invalid(&format!("line {}: a cue block has no timing line", start + 1));
        };
        let timing = block.get(at).copied().unwrap_or("");
        let mut parts = timing.split("-->").map(js_trim);
        let from = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        let n = start + at + 1;
        let Some(start_ms) = vtt_stamp(from) else {
            return invalid(&format!("line {n}: \"{}\" is not a WebVTT timestamp", js_slice(from, 40)));
        };
        let to = first_token(rest);
        let Some(end_ms) = vtt_stamp(to) else {
            return invalid(&format!("line {n}: \"{}\" is not a WebVTT timestamp", js_slice(to, 40)));
        };
        if end_ms <= start_ms {
            return invalid(&format!("line {n}: a cue ends before it starts"));
        }
        let text = js_trim(&block.get(at + 1..).unwrap_or_default().join("\n")).to_owned();
        if text.is_empty() {
            return invalid(&format!("line {n}: a cue has no text"));
        }
        if js_len(&text) > MAX_CUE_TEXT {
            return invalid(&format!("line {n}: a cue is longer than {MAX_CUE_TEXT} characters"));
        }
        cues.push(Cue { start_ms, end_ms, text });
        if cues.len() > MAX_CUES {
            return invalid(&format!("more than {MAX_CUES} cues"));
        }
    }
    sort(&mut cues);
    Ok(cues)
}

/// `parseSrt`.
pub fn parse_srt(srt: &str) -> Result<Vec<Cue>, Refusal> {
    let lines = lines_of(srt);
    let line = |i: usize| lines.get(i).copied().unwrap_or("");
    let mut cues = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        while i < lines.len() && js_trim(line(i)).is_empty() {
            i += 1;
        }
        if i >= lines.len() {
            break;
        }
        if !digits(js_trim(line(i))) {
            return invalid(&format!("line {}: \"{}\" is not a cue number", i + 1, js_slice(line(i), 40)));
        }
        let timing = lines.get(i + 1).copied();
        let Some(timing) = timing.filter(|t| t.contains("-->")) else {
            return invalid(&format!("line {}: a cue has no timing line", i + 2));
        };
        let mut parts = timing.split("-->").map(js_trim);
        let from = parts.next().unwrap_or("");
        let to = first_token(parts.next().unwrap_or(""));
        let Some(start_ms) = srt_stamp(from) else {
            return invalid(&format!("line {}: \"{}\" is not an SRT timestamp", i + 2, js_slice(from, 40)));
        };
        let Some(end_ms) = srt_stamp(to) else {
            return invalid(&format!("line {}: \"{}\" is not an SRT timestamp", i + 2, js_slice(to, 40)));
        };
        if end_ms <= start_ms {
            return invalid(&format!("line {}: a cue ends before it starts", i + 2));
        }
        let mut j = i + 2;
        let mut text = Vec::new();
        while j < lines.len() && !js_trim(line(j)).is_empty() {
            text.push(line(j));
            j += 1;
        }
        let joined = js_trim(&text.join("\n")).to_owned();
        if joined.is_empty() {
            return invalid(&format!("line {}: a cue has no text", i + 2));
        }
        if js_len(&joined) > MAX_CUE_TEXT {
            return invalid(&format!("line {}: a cue is longer than {MAX_CUE_TEXT} characters", i + 2));
        }
        cues.push(Cue {
            start_ms,
            end_ms,
            text: joined,
        });
        if cues.len() > MAX_CUES {
            return invalid(&format!("more than {MAX_CUES} cues"));
        }
        i = j;
    }
    if cues.is_empty() {
        return invalid("the file has no cues");
    }
    sort(&mut cues);
    Ok(cues)
}

/// `VideoTracks.itemVideo`.
pub fn item_video<C: GenericClient>(c: &mut C, item_slug: &str) -> Result<Option<String>, Refusal> {
    first(c, "SELECT video_slug FROM academy.item_videos WHERE item_slug = $1::text", &[&item_slug])?
        .map(|r| get(&r, "video_slug"))
        .transpose()
}

/// `VideoTracks.itemVideos(itemSlugs)`: item → video for the given items.
pub fn item_videos<C: GenericClient>(c: &mut C, item_slugs: &[String]) -> Result<Vec<(String, String)>, Refusal> {
    if item_slugs.is_empty() {
        return Ok(Vec::new());
    }
    query(
        c,
        "SELECT item_slug, video_slug FROM academy.item_videos WHERE item_slug = ANY($1::text[])",
        &[&item_slugs],
    )?
    .iter()
    .map(|r| Ok((get(r, "item_slug")?, get(r, "video_slug")?)))
    .collect()
}

/// `VideoTracks.setItemVideo`.
pub fn set_item_video(pool: &Store, item_slug: &str, video_slug: Option<&str>, operator: &str, reason: &str, now: i64) -> Result<(), Refusal> {
    sql::client(pool, |c| {
        match video_slug {
            None => sql::exec(c, "DELETE FROM academy.item_videos WHERE item_slug = $1::text", &[&item_slug])?,
            Some(v) => sql::exec(
                c,
                "INSERT INTO academy.item_videos (item_slug, video_slug, reason, set_by, set_at) \
                 VALUES ($1::text, $2::text, $3::text, $4::text::uuid, $5::text::timestamptz) \
                 ON CONFLICT (item_slug) DO UPDATE SET video_slug = EXCLUDED.video_slug, reason = EXCLUDED.reason, \
                   set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at",
                &[&item_slug, &v, &reason, &operator, &at(now)],
            )?,
        };
        Ok(())
    })
}

/// `VideoTracks.tracks`: in the order staff listed them, read back as cues.
pub fn tracks(pool: &Store, video_slug: &str) -> Result<Vec<Track>, Refusal> {
    let rows = sql::client(pool, |c| {
        query(
            c,
            "SELECT language, label, vtt FROM academy.video_tracks WHERE video_slug = $1::text ORDER BY position",
            &[&video_slug],
        )
    })?;
    rows.iter()
        .map(|r| {
            Ok(Track {
                language: get(r, "language")?,
                label: get(r, "label")?,
                cues: parse_vtt(&get::<String>(r, "vtt")?)?,
            })
        })
        .collect()
}

/// One track a save sends.
pub struct TrackIn<'a> {
    pub language: &'a str,
    pub label: &'a str,
    pub vtt: &'a str,
}

/// `VideoTracks.setTracks`: every file checked before anything is written; `[]` removes them all.
pub fn set_tracks(pool: &Store, video_slug: &str, input: &[TrackIn<'_>], operator: &str, reason: &str, now: i64) -> Result<Vec<Track>, Refusal> {
    let mut languages: Vec<&str> = input.iter().map(|t| t.language).collect();
    languages.sort_unstable();
    languages.dedup();
    if languages.len() != input.len() {
        return invalid("two tracks share a language");
    }
    let parsed = input
        .iter()
        .map(|t| {
            Ok(Track {
                language: t.language.to_owned(),
                label: js_trim(t.label).to_owned(),
                cues: parse_vtt(t.vtt)?,
            })
        })
        .collect::<Result<Vec<_>, Refusal>>()?;
    sql::serializable(pool, |tx| {
        sql::exec(tx, "DELETE FROM academy.video_tracks WHERE video_slug = $1::text", &[&video_slug])?;
        for (position, t) in input.iter().enumerate() {
            let pos = i32::try_from(position).unwrap_or(i32::MAX);
            sql::exec(
                tx,
                "INSERT INTO academy.video_tracks (video_slug, language, label, vtt, position, reason, set_by, set_at) \
                 VALUES ($1::text, $2::text, $3::text, $4::text, $5::int4, $6::text, $7::text::uuid, $8::text::timestamptz)",
                &[&video_slug, &t.language, &js_trim(t.label), &t.vtt, &pos, &reason, &operator, &at(now)],
            )?;
        }
        Ok(())
    })?;
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(r: Result<Vec<Cue>, Refusal>) -> String {
        match r {
            Err(Refusal::Academy(e)) => e.message,
            _ => String::new(),
        }
    }

    #[test]
    fn a_vtt_file_reads_back_as_sorted_cues() {
        let cues = parse_vtt("WEBVTT\nKind: captions\n\nNOTE hi\n\n2\n00:00:05.000 --> 00:00:06.000 align:start\nlater\n\n1\n00:01.000 --> 00:02.500\nfirst\nline")
            .unwrap_or_default();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues.first().map(|c| (c.start_ms, c.end_ms, c.text.as_str())), Some((1000, 2500, "first\nline")));
    }

    #[test]
    fn a_bad_vtt_names_its_line() {
        assert_eq!(code(parse_vtt("hello")), "academy.captions_invalid the file does not start with WEBVTT");
        assert_eq!(
            code(parse_vtt("WEBVTT\n\n00:02.000 --> 00:01.000\nx")),
            "academy.captions_invalid line 3: a cue ends before it starts"
        );
        assert_eq!(
            code(parse_vtt("WEBVTT\n\n0:02.000 --> 00:03.000\nx")),
            "academy.captions_invalid line 3: \"0:02.000\" is not a WebVTT timestamp"
        );
    }

    #[test]
    fn an_srt_file_reads_and_an_empty_one_refuses() {
        let cues = parse_srt("1\n00:00:01,000 --> 00:00:04,000\nHello\n\n2\n00:00:05,000 --> 00:00:06,000\nBye").unwrap_or_default();
        assert_eq!(cues.len(), 2);
        assert_eq!(code(parse_srt("")), "academy.captions_invalid the file has no cues");
        assert_eq!(code(parse_srt("x")), "academy.captions_invalid line 1: \"x\" is not a cue number");
    }
}
