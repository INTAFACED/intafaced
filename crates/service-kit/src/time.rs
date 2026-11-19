//! UTC time as JavaScript's `Date` holds it: whole milliseconds since 1970-01-01T00:00:00Z.

/// A moment, in milliseconds since the Unix epoch (UTC), as `Date#getTime()` gives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Instant(pub i64);

const DAY_MS: i64 = 86_400_000;

/// Days from 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date of a day number from 1970-01-01: (year, month 1-12, day 1-31).
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

pub fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

pub fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

impl Instant {
    /// `Date.UTC(year, monthIndex0, 1)` for January: the first moment of a year.
    pub fn start_of_year(year: i64) -> Instant {
        Instant(days_from_civil(year, 1, 1) * DAY_MS)
    }

    /// The UTC calendar year.
    pub fn year(self) -> i64 {
        civil_from_days(self.0.div_euclid(DAY_MS)).0
    }

    /// `Date#toISOString()`: `YYYY-MM-DDTHH:mm:ss.sssZ`, with a signed six-digit year outside 0000-9999.
    pub fn iso(self) -> String {
        let days = self.0.div_euclid(DAY_MS);
        let ms = self.0.rem_euclid(DAY_MS);
        let (y, m, d) = civil_from_days(days);
        let year = if (0..=9999).contains(&y) {
            format!("{y:04}")
        } else if y < 0 {
            format!("-{:06}", -y)
        } else {
            format!("+{y:06}")
        };
        format!(
            "{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
            ms / 3_600_000,
            ms / 60_000 % 60,
            ms / 1000 % 60,
            ms % 1000
        )
    }
}

fn two(b: &[u8], at: usize) -> Option<i64> {
    match (b.get(at), b.get(at + 1)) {
        (Some(x @ b'0'..=b'9'), Some(y @ b'0'..=b'9')) => {
            Some(i64::from(x - b'0') * 10 + i64::from(y - b'0'))
        }
        _ => None,
    }
}

fn digits(b: &[u8]) -> Option<i64> {
    if b.is_empty() || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    b.iter().try_fold(0i64, |n, d| {
        n.checked_mul(10)?.checked_add(i64::from(d - b'0'))
    })
}

/// What zod's `z.string().datetime({ offset })` accepts (zod 4, no precision set): a real calendar date with a four-digit
/// year, `T`, `HH:mm:ss`, an optional fraction of any length, then `Z` or, with `offset`, `±HH:mm`. Returns the moment,
/// as `new Date(text)` reads it (the fraction cut to milliseconds).
pub fn zod_datetime(text: &str, offset: bool) -> Option<Instant> {
    let b = text.as_bytes();
    if b.len() < 20
        || b.get(4) != Some(&b'-')
        || b.get(7) != Some(&b'-')
        || b.get(10) != Some(&b'T')
    {
        return None;
    }
    let year = digits(b.get(0..4)?)?;
    let (month, day) = (two(b, 5)?, two(b, 8)?);
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    if b.get(13) != Some(&b':') || b.get(16) != Some(&b':') {
        return None;
    }
    let (h, mi, s) = (two(b, 11)?, two(b, 14)?, two(b, 17)?);
    if h > 23 || mi > 59 || s > 59 {
        return None;
    }
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        i = start;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return None;
        }
        let frac = b.get(start..i)?;
        for k in 0..3 {
            ms = ms * 10 + frac.get(k).map_or(0, |d| i64::from(d - b'0'));
        }
    }
    let shift = match b.get(i..)? {
        b"Z" => 0,
        [sign @ (b'+' | b'-'), _, _, b':', _, _] if offset => {
            let (oh, om) = (two(b, i + 1)?, two(b, i + 4)?);
            if oh > 23 || om > 59 {
                return None;
            }
            let minutes = oh * 60 + om;
            if *sign == b'+' { minutes } else { -minutes }
        }
        _ => return None,
    };
    let day_ms = days_from_civil(year, month, day) * DAY_MS;
    Some(Instant(
        day_ms + ((h * 60 + mi - shift) * 60 + s) * 1000 + ms,
    ))
}

/// `Date.parse(`${day}T00:00:00Z`)` for the forms ECMAScript's date-time string format gives a meaning (`YYYY`,
/// `YYYY-MM`, `YYYY-MM-DD`, with a `±YYYYYY` expanded year), or `None` where it is NaN. V8 falls back to a legacy parser
/// for other text; the one place this is read (`tax.setDayMethod`'s day check) only passes a day whose ISO form starts
/// with the text, which no legacy-only form does.
pub fn es_date_at_midnight(day: &str) -> Option<Instant> {
    let b = day.as_bytes();
    let (year, rest) = match b.first()? {
        b'+' | b'-' => {
            let y = digits(b.get(1..7)?)?;
            if b.first() == Some(&b'-') && y == 0 {
                return None; // -000000 is not a year
            }
            (if b.first() == Some(&b'-') { -y } else { y }, b.get(7..)?)
        }
        _ => (digits(b.get(0..4)?)?, b.get(4..)?),
    };
    let (month, day_of_month) = match rest {
        [] => (1, 1),
        [b'-', ..] if rest.len() == 3 => (two(rest, 1)?, 1),
        [b'-', _, _, b'-', _, _] => (two(rest, 1)?, two(rest, 4)?),
        _ => return None,
    };
    // V8 checks each field's range on its own (any month may reach day 31); MakeDay then rolls a day past the month's end
    // into the next month, which the caller's ISO comparison catches.
    if !(1..=12).contains(&month) || !(1..=31).contains(&day_of_month) {
        return None;
    }
    let first = days_from_civil(year, month, 1);
    let ms = (first + day_of_month - 1) * DAY_MS;
    // ECMAScript's time range: ±8.64e15 ms.
    (ms.abs() <= 8_640_000_000_000_000).then_some(Instant(ms))
}

/// `new Date(text)` for the ISO-shaped forms V8 reads (date only as UTC; a date and time as UTC when it has no offset,
/// which is the service's own zone, UTC; `T` or a space, either case of `T` and `Z`, `±HH:mm` or `±HHmm`, minutes with
/// or without seconds, any fraction cut to milliseconds, `24:00` as the next midnight, a day past the month's end rolled
/// over as `MakeDay` does). `None` where V8 gives an invalid date, and for V8's legacy non-ISO forms (`2024/01/05`,
/// `Jan 5 2024`), which this does not read.
pub fn js_date(text: &str) -> Option<Instant> {
    let b = text.as_bytes();
    let (year, mut i) = match b.first()? {
        b'+' | b'-' => {
            let y = digits(b.get(1..7)?)?;
            if b.first() == Some(&b'-') && y == 0 {
                return None;
            }
            (if b.first() == Some(&b'-') { -y } else { y }, 7)
        }
        _ => (digits(b.get(0..4)?)?, 4),
    };
    let mut month = 1;
    let mut day = 1;
    if b.get(i) == Some(&b'-') {
        month = two(b, i + 1)?;
        i += 3;
        if b.get(i) == Some(&b'-') {
            day = two(b, i + 1)?;
            i += 3;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut ms_of_day = 0i64;
    if i < b.len() {
        if !matches!(b.get(i), Some(b'T' | b't' | b' ')) {
            return None;
        }
        let h = two(b, i + 1)?;
        if b.get(i + 3) != Some(&b':') {
            return None;
        }
        let mi = two(b, i + 4)?;
        i += 6;
        let mut s = 0;
        let mut ms = 0;
        if b.get(i) == Some(&b':') {
            s = two(b, i + 1)?;
            i += 3;
            if b.get(i) == Some(&b'.') {
                let start = i + 1;
                i = start;
                while b.get(i).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                }
                if i == start {
                    return None;
                }
                let frac = b.get(start..i)?;
                for k in 0..3 {
                    ms = ms * 10 + frac.get(k).map_or(0, |d| i64::from(d - b'0'));
                }
            }
        }
        let midnight = h == 24 && mi == 0 && s == 0 && ms == 0;
        if (h > 23 && !midnight) || mi > 59 || s > 59 {
            return None;
        }
        let shift = match b.get(i..)? {
            [] | [b'Z' | b'z'] => 0,
            [sign @ (b'+' | b'-'), rest @ ..] => {
                let (oh, om) = match rest {
                    [_, _, b':', _, _] => (two(rest, 0)?, two(rest, 3)?),
                    [_, _, _, _] => (two(rest, 0)?, two(rest, 2)?),
                    _ => return None,
                };
                if oh > 23 || om > 59 {
                    return None;
                }
                let minutes = oh * 60 + om;
                if *sign == b'+' { minutes } else { -minutes }
            }
            _ => return None,
        };
        ms_of_day = ((h * 60 + mi - shift) * 60 + s) * 1000 + ms;
    }
    let first = days_from_civil(year, month, 1);
    let at = (first + day - 1) * DAY_MS + ms_of_day;
    (at.abs() <= 8_640_000_000_000_000).then_some(Instant(at))
}

/// `new Date(text)` for any text, as V8's `DateParser` reads it (`src/date/dateparser-inl.h`): the ECMAScript date-time
/// form first, then, for anything left over, V8's legacy parser (`Jan 5 2026 10:00 GMT+0100`, `2026/01/05`, `1/5`). A
/// time with no zone is read in the process's zone, which for every service is UTC. `None` is an invalid date.
pub fn v8_date_parse(text: &str) -> Option<i64> {
    let mut p = v8::Parser::new(text);
    let fields = p.parse()?;
    v8::make_date(&fields)
}

/// `new Date(n)` for a number: `TimeClip`, so a fraction is cut toward zero and anything past ±8.64e15 ms is invalid.
pub fn time_clip(n: f64) -> Option<i64> {
    if !n.is_finite() || n.abs() > 8.64e15 {
        return None;
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a finite value within ±8.64e15, cut toward zero as TimeClip does"
    )]
    Some(n.trunc() as i64)
}

mod v8 {
    use super::{DAY_MS, days_from_civil};

    const NONE: i64 = i64::MIN;

    #[derive(Debug, Clone, Copy, PartialEq)]
    enum Kw {
        Month(i64),
        AmPm(i64),
        Zone(i64),
        TimeSeparator,
        Invalid,
    }

    #[derive(Debug, Clone, Copy, PartialEq)]
    enum Token {
        Number { value: i64, length: usize },
        Symbol(char),
        Word { kw: Kw, length: usize },
        Space,
        Unknown,
        End,
        Invalid,
    }

    impl Token {
        fn fixed(self, n: usize) -> Option<i64> {
            match self {
                Token::Number { value, length } if length == n => Some(value),
                _ => None,
            }
        }
        fn is_z(self) -> bool {
            matches!(
                self,
                Token::Word {
                    kw: Kw::Zone(0),
                    length: 1
                }
            )
        }
        fn sign(self) -> Option<i64> {
            match self {
                Token::Symbol('+') => Some(1),
                Token::Symbol('-') => Some(-1),
                _ => None,
            }
        }
    }

    fn is_space(c: char) -> bool {
        c.is_whitespace() || c == '\u{feff}'
    }

    /// `KeywordTable`: the first three letters, lower-cased; a longer word matches only a month.
    fn keyword(word: &[char], length: usize) -> Kw {
        const TABLE: [(&str, Kw); 25] = [
            ("jan", Kw::Month(1)),
            ("feb", Kw::Month(2)),
            ("mar", Kw::Month(3)),
            ("apr", Kw::Month(4)),
            ("may", Kw::Month(5)),
            ("jun", Kw::Month(6)),
            ("jul", Kw::Month(7)),
            ("aug", Kw::Month(8)),
            ("sep", Kw::Month(9)),
            ("oct", Kw::Month(10)),
            ("nov", Kw::Month(11)),
            ("dec", Kw::Month(12)),
            ("am", Kw::AmPm(0)),
            ("pm", Kw::AmPm(12)),
            ("ut", Kw::Zone(0)),
            ("utc", Kw::Zone(0)),
            ("z", Kw::Zone(0)),
            ("gmt", Kw::Zone(0)),
            ("cdt", Kw::Zone(-5)),
            ("cst", Kw::Zone(-6)),
            ("edt", Kw::Zone(-4)),
            ("est", Kw::Zone(-5)),
            ("mdt", Kw::Zone(-6)),
            ("mst", Kw::Zone(-7)),
            ("pdt", Kw::Zone(-7)),
        ];
        const PST: (&str, Kw) = ("pst", Kw::Zone(-8));
        const T: (&str, Kw) = ("t", Kw::TimeSeparator);
        let prefix: Vec<u32> = (0..3)
            .map(|i| word.get(i).map_or(0, |c| u32::from(*c)))
            .collect();
        for (name, kw) in TABLE.iter().chain([PST, T].iter()) {
            let want: Vec<u32> = (0..3)
                .map(|i| name.as_bytes().get(i).map_or(0, |b| u32::from(*b)))
                .collect();
            if want == prefix && (length <= 3 || matches!(kw, Kw::Month(_))) {
                return *kw;
            }
        }
        Kw::Invalid
    }

    struct Tokens {
        chars: Vec<char>,
        at: usize,
        next: Token,
    }

    impl Tokens {
        fn scan(&mut self) -> Token {
            let Some(&c) = self.chars.get(self.at) else {
                return Token::End;
            };
            if c.is_ascii_digit() {
                let start = self.at;
                let mut value: i64 = 0;
                while let Some(d) = self.chars.get(self.at).and_then(|c| c.to_digit(10)) {
                    // `ReadUnsignedNumeral` keeps the first nine digits.
                    if self.at - start < 9 {
                        value = value * 10 + i64::from(d);
                    }
                    self.at += 1;
                }
                return Token::Number {
                    value,
                    length: self.at - start,
                };
            }
            if matches!(c, ':' | '-' | '+' | '.' | ')') {
                self.at += 1;
                return Token::Symbol(c);
            }
            if u32::from(c) >= u32::from('A') && !is_space(c) {
                let mut word = Vec::new();
                let mut length = 0;
                while let Some(&w) = self.chars.get(self.at) {
                    if u32::from(w) < u32::from('A') || is_space(w) {
                        break;
                    }
                    if word.len() < 3 {
                        // `AsciiAlphaToLower`: the 0x20 bit, on every character.
                        word.push(char::from_u32(u32::from(w) | 0x20).unwrap_or(w));
                    }
                    length += w.len_utf16();
                    self.at += 1;
                }
                return Token::Word {
                    kw: keyword(&word, length),
                    length,
                };
            }
            if is_space(c) {
                while self.chars.get(self.at).is_some_and(|c| is_space(*c)) {
                    self.at += 1;
                }
                return Token::Space;
            }
            if c == '(' {
                let mut depth = 0usize;
                while let Some(&p) = self.chars.get(self.at) {
                    self.at += 1;
                    if p == '(' {
                        depth += 1;
                    } else if p == ')' {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                }
                return Token::Unknown;
            }
            self.at += 1;
            Token::Unknown
        }

        fn next(&mut self) -> Token {
            let t = self.next;
            self.next = self.scan();
            t
        }

        fn peek(&self) -> Token {
            self.next
        }

        fn skip(&mut self, c: char) -> bool {
            if self.next == Token::Symbol(c) {
                self.next();
                true
            } else {
                false
            }
        }
    }

    #[derive(Default)]
    struct Day {
        comp: Vec<i64>,
        named_month: Option<i64>,
        iso: bool,
    }

    impl Day {
        fn add(&mut self, n: i64) -> bool {
            if self.comp.len() < 3 {
                self.comp.push(n);
                true
            } else {
                false
            }
        }
    }

    struct Time {
        comp: Vec<i64>,
        hour_offset: i64,
    }

    impl Time {
        fn add(&mut self, n: i64) -> bool {
            if self.comp.len() < 4 {
                self.comp.push(n);
                true
            } else {
                false
            }
        }
        fn add_final(&mut self, n: i64) -> bool {
            if !self.add(n) {
                return false;
            }
            while self.comp.len() < 4 {
                self.comp.push(0);
            }
            true
        }
        fn expecting(&self, n: i64) -> bool {
            match self.comp.len() {
                1 | 2 => (0..=59).contains(&n),
                3 => (0..=999).contains(&n),
                _ => false,
            }
        }
    }

    struct Zone {
        sign: i64,
        hour: i64,
        minute: i64,
    }

    impl Zone {
        fn set(&mut self, hours: i64) {
            self.sign = if hours < 0 { -1 } else { 1 };
            self.hour = hours * self.sign;
            self.minute = 0;
        }
        fn expecting(&self, n: i64) -> bool {
            self.hour != NONE && self.minute == NONE && (0..=59).contains(&n)
        }
        fn is_utc(&self) -> bool {
            self.hour == 0 && self.minute == 0
        }
    }

    pub(super) struct Fields {
        year: i64,
        month0: i64,
        day: i64,
        ms_of_day: i64,
        offset_seconds: Option<i64>,
    }

    pub(super) struct Parser {
        t: Tokens,
        day: Day,
        time: Time,
        zone: Zone,
    }

    /// `ReadMilliseconds`: the first three significant digits.
    fn millis(value: i64, length: usize) -> i64 {
        match length {
            1 => value * 100,
            2 => value * 10,
            3 => value,
            _ => {
                let mut n = value;
                for _ in 3..length.min(9) {
                    n /= 10;
                }
                n
            }
        }
    }

    impl Parser {
        pub(super) fn new(text: &str) -> Parser {
            let mut t = Tokens {
                chars: text.chars().collect(),
                at: 0,
                next: Token::End,
            };
            t.next = t.scan();
            Parser {
                t,
                day: Day::default(),
                time: Time {
                    comp: Vec::new(),
                    hour_offset: NONE,
                },
                zone: Zone {
                    sign: NONE,
                    hour: NONE,
                    minute: NONE,
                },
            }
        }

        /// `ParseES5DateTime`: the token the legacy parser starts from.
        fn es5(&mut self) -> Token {
            let t = &mut self.t;
            if let Some(sign) = t.peek().sign() {
                let sign_token = t.next();
                let Some(year) = t.peek().fixed(6) else {
                    return sign_token;
                };
                if sign < 0 && year == 0 {
                    return sign_token;
                }
                t.next();
                self.day.add(sign * year);
            } else if let Some(year) = t.peek().fixed(4) {
                t.next();
                self.day.add(year);
            } else {
                return t.next();
            }
            if t.skip('-') {
                match t.peek().fixed(2) {
                    Some(m) if (1..=12).contains(&m) => {
                        t.next();
                        self.day.add(m);
                    }
                    _ => return t.next(),
                }
                if t.skip('-') {
                    match t.peek().fixed(2) {
                        Some(d) if (1..=31).contains(&d) => {
                            t.next();
                            self.day.add(d);
                        }
                        _ => return t.next(),
                    }
                }
            }
            if !matches!(
                t.peek(),
                Token::Word {
                    kw: Kw::TimeSeparator,
                    ..
                }
            ) {
                if t.peek() != Token::End {
                    return t.next();
                }
            } else {
                t.next();
                let Some(h) = t.peek().fixed(2).filter(|h| (0..=24).contains(h)) else {
                    return Token::Invalid;
                };
                let hour_is_24 = h == 24;
                t.next();
                self.time.add(h);
                if !t.skip(':') {
                    return Token::Invalid;
                }
                let Some(m) = t
                    .peek()
                    .fixed(2)
                    .filter(|m| (0..=59).contains(m) && !(hour_is_24 && *m > 0))
                else {
                    return Token::Invalid;
                };
                t.next();
                self.time.add(m);
                if t.skip(':') {
                    let Some(s) = t
                        .peek()
                        .fixed(2)
                        .filter(|s| (0..=59).contains(s) && !(hour_is_24 && *s > 0))
                    else {
                        return Token::Invalid;
                    };
                    t.next();
                    self.time.add(s);
                    if t.skip('.') {
                        let Token::Number { value, length } = t.peek() else {
                            return Token::Invalid;
                        };
                        if hour_is_24 && value > 0 {
                            return Token::Invalid;
                        }
                        t.next();
                        self.time.add(millis(value, length));
                    }
                }
                if t.peek().is_z() {
                    t.next();
                    self.zone.set(0);
                } else if let Some(sign) = t.peek().sign() {
                    t.next();
                    self.zone.sign = sign;
                    if let Some(hm) = t.peek().fixed(4) {
                        t.next();
                        let (h, m) = (hm / 100, hm % 100);
                        if !(0..=23).contains(&h) || !(0..=59).contains(&m) {
                            return Token::Invalid;
                        }
                        self.zone.hour = h;
                        self.zone.minute = m;
                    } else {
                        let Some(h) = t.peek().fixed(2).filter(|h| (0..=23).contains(h)) else {
                            return Token::Invalid;
                        };
                        t.next();
                        self.zone.hour = h;
                        if !t.skip(':') {
                            return Token::Invalid;
                        }
                        let Some(m) = t.peek().fixed(2).filter(|m| (0..=59).contains(m)) else {
                            return Token::Invalid;
                        };
                        t.next();
                        self.zone.minute = m;
                    }
                }
                if t.peek() != Token::End {
                    return Token::Invalid;
                }
            }
            // A date-only form with no zone is UTC; a date-time form with no zone is local time.
            if self.zone.hour == NONE && self.time.comp.is_empty() {
                self.zone.set(0);
            }
            self.day.iso = true;
            Token::End
        }

        pub(super) fn parse(&mut self) -> Option<Fields> {
            let mut token = self.es5();
            if token == Token::Invalid {
                return None;
            }
            let mut has_read_number = !self.day.comp.is_empty();
            while token != Token::End {
                match token {
                    Token::Number { value: n, length } => {
                        has_read_number = true;
                        if self.t.skip(':') {
                            if self.t.skip(':') {
                                if !self.time.comp.is_empty() {
                                    return None;
                                }
                                self.time.add(n);
                                self.time.add(0);
                            } else {
                                if !self.time.add(n) {
                                    return None;
                                }
                                if self.t.peek() == Token::Symbol('.') {
                                    self.t.next();
                                }
                            }
                        } else if self.t.peek() == Token::Symbol('.') && self.time.expecting(n) {
                            self.t.next();
                            self.time.add(n);
                            let Token::Number { value, length } = self.t.peek() else {
                                return None;
                            };
                            self.t.next();
                            self.time.add_final(millis(value, length));
                        } else if self.zone.expecting(n) {
                            self.zone.minute = n;
                        } else if self.time.expecting(n) {
                            self.time.add_final(n);
                            let peek = self.t.peek();
                            if !(peek == Token::End
                                || peek == Token::Space
                                || peek.is_z()
                                || peek.sign().is_some())
                            {
                                return None;
                            }
                        } else {
                            if !self.day.add(n) {
                                return None;
                            }
                            self.t.skip('-');
                        }
                        let _ = length;
                    }
                    Token::Word { kw, .. } => match kw {
                        Kw::AmPm(offset) if !self.time.comp.is_empty() => {
                            self.time.hour_offset = offset;
                        }
                        Kw::Month(m) => {
                            self.day.named_month = Some(m);
                            self.t.skip('-');
                        }
                        Kw::Zone(h) if has_read_number => self.zone.set(h),
                        _ => {
                            if has_read_number {
                                return None;
                            }
                            if matches!(self.t.peek(), Token::Number { .. }) {
                                return None;
                            }
                        }
                    },
                    Token::Symbol(c @ ('+' | '-'))
                        if self.zone.is_utc() || !self.time.comp.is_empty() =>
                    {
                        self.zone.sign = if c == '+' { 1 } else { -1 };
                        let (mut n, mut length) = (0, 0);
                        if let Token::Number { value, length: l } = self.t.peek() {
                            self.t.next();
                            n = value;
                            length = l;
                        }
                        has_read_number = true;
                        if self.t.peek() == Token::Symbol(':') {
                            self.zone.hour = n;
                            self.zone.minute = NONE;
                        } else if length == 1 || length == 2 {
                            self.zone.hour = n;
                            self.zone.minute = 0;
                        } else if length == 3 || length == 4 {
                            self.zone.hour = n / 100;
                            self.zone.minute = n % 100;
                        } else {
                            return None;
                        }
                    }
                    Token::Symbol('+' | '-' | ')') if has_read_number => return None,
                    _ => {}
                }
                token = self.t.next();
            }
            self.write()
        }

        fn write(&mut self) -> Option<Fields> {
            // DayComposer::Write
            let d = &mut self.day;
            if d.comp.is_empty() {
                return None;
            }
            while d.comp.len() < 3 {
                d.comp.push(1);
            }
            let c = |i: usize| d.comp.get(i).copied().unwrap_or(1);
            let is_day = |x: i64| (1..=31).contains(&x);
            let (mut year, month, day) = match d.named_month {
                None if d.iso || !is_day(c(0)) => (c(0), c(1), c(2)),
                None => (c(2), c(0), c(1)),
                Some(m) if !is_day(c(0)) => (c(0), m, c(1)),
                Some(m) => (c(1), m, c(0)),
            };
            if !d.iso {
                if (0..=49).contains(&year) {
                    year += 2000;
                } else if (50..=99).contains(&year) {
                    year += 1900;
                }
            }
            if !(1..=12).contains(&month) || !is_day(day) {
                return None;
            }
            // TimeComposer::Write
            let t = &mut self.time;
            while t.comp.len() < 4 {
                t.comp.push(0);
            }
            let tc = |i: usize| t.comp.get(i).copied().unwrap_or(0);
            let (mut hour, minute, second, ms) = (tc(0), tc(1), tc(2), tc(3));
            if t.hour_offset != NONE {
                if !(0..=12).contains(&hour) {
                    return None;
                }
                hour = hour % 12 + t.hour_offset;
            }
            let fits = (0..=23).contains(&hour)
                && (0..=59).contains(&minute)
                && (0..=59).contains(&second)
                && (0..=999).contains(&ms);
            if !fits && (hour != 24 || minute != 0 || second != 0 || ms != 0) {
                return None;
            }
            // TimeZoneComposer::Write
            let z = &self.zone;
            let offset_seconds = (z.sign != NONE).then(|| {
                let h = if z.hour == NONE { 0 } else { z.hour };
                let m = if z.minute == NONE { 0 } else { z.minute };
                z.sign * (h * 3600 + m * 60)
            });
            Some(Fields {
                year,
                month0: month - 1,
                day,
                ms_of_day: ((hour * 60 + minute) * 60 + second) * 1000 + ms,
                offset_seconds,
            })
        }
    }

    /// `MakeDate(MakeDay(year, month, day), MakeTime(...))`, less the offset (none: the process zone, UTC), clipped.
    pub(super) fn make_date(f: &Fields) -> Option<i64> {
        let days = days_from_civil(f.year, f.month0 + 1, 1) + f.day - 1;
        let local = days * DAY_MS + f.ms_of_day;
        let at = local - f.offset_seconds.unwrap_or(0) * 1000;
        (at.abs() <= 8_640_000_000_000_000).then_some(at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_iso_as_javascript_does() {
        assert_eq!(Instant(0).iso(), "1970-01-01T00:00:00.000Z");
        assert_eq!(Instant(1_795_046_400_000).iso(), "2026-11-19T00:00:00.000Z");
        assert_eq!(
            Instant(-62_198_755_200_000).iso(),
            "-000001-01-01T00:00:00.000Z"
        );
        assert_eq!(
            Instant::start_of_year(2016).iso(),
            "2016-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn reads_dates_as_v8_does() {
        let iso = |t: &str| js_date(t).map(Instant::iso);
        assert_eq!(
            iso("2024-02-30").as_deref(),
            Some("2024-03-01T00:00:00.000Z")
        );
        assert_eq!(
            iso("2024-01-01T24:00:00Z").as_deref(),
            Some("2024-01-02T00:00:00.000Z")
        );
        assert_eq!(iso("2024-01-01T24:00:01Z"), None);
        assert_eq!(
            iso("2024-01-01T00:00Z").as_deref(),
            Some("2024-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso("2024-01-01T00:00:00.123456Z").as_deref(),
            Some("2024-01-01T00:00:00.123Z")
        );
        assert_eq!(
            iso("2024-01-01t00:00:00z").as_deref(),
            Some("2024-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso("2024-01-01 00:00:00Z").as_deref(),
            Some("2024-01-01T00:00:00.000Z")
        );
        assert_eq!(iso("2024").as_deref(), Some("2024-01-01T00:00:00.000Z"));
        assert_eq!(
            iso("+002024-01-01").as_deref(),
            Some("2024-01-01T00:00:00.000Z")
        );
        assert_eq!(
            iso("2024-01-01T00:00:00+0800").as_deref(),
            Some("2023-12-31T16:00:00.000Z")
        );
        for bad in [
            "2024-01-01T00:00:00+08",
            "2024-01-32",
            "2024-00-10",
            "",
            "not-a-date",
            "2024-01-01T25:00:00Z",
            "2024-01-01T00:00:60Z",
            "2024-01-01T00:00:00.Z",
        ] {
            assert_eq!(js_date(bad), None, "{bad}");
        }
    }

    #[test]
    fn reads_zod_datetimes() {
        assert_eq!(
            zod_datetime("2026-01-01T00:00:00Z", true),
            Some(Instant(1_767_225_600_000))
        );
        assert_eq!(
            zod_datetime("2026-01-01T08:00:00.1239+08:00", true),
            Some(Instant(1_767_225_600_123))
        );
        assert_eq!(zod_datetime("2026-01-01T00:00:00+08:00", false), None);
        assert_eq!(zod_datetime("2026-02-29T00:00:00Z", true), None);
        assert_eq!(zod_datetime("2026-01-01T00:00Z", true), None);
        assert_eq!(zod_datetime("2026-01-01t00:00:00Z", true), None);
    }

    #[test]
    fn parses_dates_as_v8s_legacy_parser_does() {
        let iso = |t: &str| v8_date_parse(t).map(|ms| Instant(ms).iso());
        let cases = [
            ("2026-01-01T00:00:00.000Z", Some("2026-01-01T00:00:00.000Z")),
            ("2026-01-01", Some("2026-01-01T00:00:00.000Z")),
            ("2026-01-01T10:00", Some("2026-01-01T10:00:00.000Z")),
            ("2026-01-01 10:00:00", Some("2026-01-01T10:00:00.000Z")),
            ("2026-13-01", None),
            (
                "Jan 5 2026 10:00 GMT+0100",
                Some("2026-01-05T09:00:00.000Z"),
            ),
            ("5 January 2026", Some("2026-01-05T00:00:00.000Z")),
            (
                "Mon, 05 Jan 2026 10:00:00 GMT",
                Some("2026-01-05T10:00:00.000Z"),
            ),
            ("2026/01/05", Some("2026-01-05T00:00:00.000Z")),
            ("1/5/2026", Some("2026-01-05T00:00:00.000Z")),
            ("1/5", Some("2001-01-05T00:00:00.000Z")),
            ("tomorrow", None),
            ("", None),
            ("+002026-01-01T00:00:00Z", Some("2026-01-01T00:00:00.000Z")),
            (
                "2026-01-01T00:00:00.123456Z",
                Some("2026-01-01T00:00:00.123Z"),
            ),
            ("20260101", None),
            ("2026", Some("2026-01-01T00:00:00.000Z")),
            ("2026-02-30", Some("2026-03-02T00:00:00.000Z")),
            ("12:30 pm 1/2/2026", Some("2026-01-02T12:30:00.000Z")),
        ];
        for (text, want) in cases {
            assert_eq!(iso(text).as_deref(), want, "{text}");
        }
    }
}
