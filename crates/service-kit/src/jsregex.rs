//! JavaScript regular expressions, for the patterns the TypeScript services' zod schemas use: a pattern is written as
//! JavaScript prints it (`/^[a-z0-9-]+$/`), and matched the way `RegExp.prototype.test` matches it, over UTF-16 code
//! units, with backtracking (so a lookahead such as `(?=\d*[1-9])` works, which the `regex` crate refuses).
//!
//! Served: `^`, `$`, `.`, literals and escapes (`\d \D \w \W \s \S`, `\.` and other escaped punctuation, `\n \r \t
//! \f \v \0`), the word boundaries `\b` and `\B` (over `\w`'s ASCII word characters, as JavaScript reads them), character classes with ranges and negation, groups (capturing, `(?:...)`, `(?=...)`, `(?!...)`),
//! alternation, and the quantifiers `* + ? {n} {n,} {n,m}` (greedy, or lazy with `?`). No flags. A pattern using
//! anything else is refused when it is read, never matched differently.

/// A compiled pattern, with its source as JavaScript prints it.
#[derive(Debug, Clone, PartialEq)]
pub struct Regex {
    source: String,
    root: Alt,
}

#[derive(Debug, Clone, PartialEq)]
struct Alt(Vec<Vec<Term>>);

#[derive(Debug, Clone, PartialEq)]
struct Term {
    node: Node,
    min: u32,
    max: Option<u32>,
    greedy: bool,
}

#[derive(Debug, Clone, PartialEq)]
enum Node {
    Unit(u16),
    Any,
    Class(Class),
    Group(Alt),
    Look {
        alt: Alt,
        negative: bool,
    },
    Start,
    End,
    /// `\b`, or `\B` when negated.
    Boundary(bool),
}

#[derive(Debug, Clone, PartialEq)]
struct Class {
    negated: bool,
    ranges: Vec<(u16, u16)>,
    sets: Vec<Set>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Set {
    Digit(bool),
    Word(bool),
    Space(bool),
}

/// JavaScript's `\s`: WhiteSpace and LineTerminator.
pub fn is_js_space(u: u16) -> bool {
    matches!(
        u,
        0x09..=0x0d
            | 0x20
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

fn is_line_terminator(u: u16) -> bool {
    matches!(u, 0x0a | 0x0d | 0x2028 | 0x2029)
}

impl Set {
    fn has(self, u: u16) -> bool {
        let (hit, negated) = match self {
            Set::Digit(n) => ((0x30..=0x39).contains(&u), n),
            Set::Word(n) => (
                u8::try_from(u).is_ok_and(|b| b.is_ascii_alphanumeric() || b == b'_'),
                n,
            ),
            Set::Space(n) => (is_js_space(u), n),
        };
        hit != negated
    }
}

impl Class {
    fn has(&self, u: u16) -> bool {
        let hit = self.ranges.iter().any(|(lo, hi)| (*lo..=*hi).contains(&u))
            || self.sets.iter().any(|s| s.has(u));
        hit != self.negated
    }
}

struct Reader<'a> {
    units: &'a [u16],
    at: usize,
}

fn unit(c: char) -> u16 {
    u16::try_from(u32::from(c)).unwrap_or(0)
}

impl Reader<'_> {
    fn peek(&self) -> Option<u16> {
        self.units.get(self.at).copied()
    }

    fn eat(&mut self, c: char) -> bool {
        if self.peek() == Some(unit(c)) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn next(&mut self) -> Result<u16, String> {
        let u = self.peek().ok_or("the pattern ends too soon")?;
        self.at += 1;
        Ok(u)
    }

    fn alt(&mut self) -> Result<Alt, String> {
        let mut branches = vec![self.seq()?];
        while self.eat('|') {
            branches.push(self.seq()?);
        }
        Ok(Alt(branches))
    }

    fn seq(&mut self) -> Result<Vec<Term>, String> {
        let mut terms = Vec::new();
        while let Some(u) = self.peek() {
            if u == unit('|') || u == unit(')') {
                break;
            }
            let node = self.atom()?;
            let (min, max) = self.quantifier()?;
            let greedy = !(self.peek().is_some() && (min, max) != (1, Some(1)) && self.eat('?'));
            if matches!(
                node,
                Node::Start | Node::End | Node::Boundary(_) | Node::Look { .. }
            ) && (min, max) != (1, Some(1))
            {
                return Err("a quantified assertion".to_owned());
            }
            terms.push(Term {
                node,
                min,
                max,
                greedy,
            });
        }
        Ok(terms)
    }

    fn number(&mut self) -> Option<u32> {
        let start = self.at;
        let mut n: u32 = 0;
        while let Some(d) = self.peek().filter(|u| (0x30..=0x39).contains(u)) {
            n = n.saturating_mul(10).saturating_add(u32::from(d - 0x30));
            self.at += 1;
        }
        (self.at > start).then_some(n)
    }

    fn quantifier(&mut self) -> Result<(u32, Option<u32>), String> {
        if self.eat('*') {
            return Ok((0, None));
        }
        if self.eat('+') {
            return Ok((1, None));
        }
        if self.eat('?') {
            return Ok((0, Some(1)));
        }
        if self.peek() == Some(unit('{')) {
            let back = self.at;
            self.at += 1;
            if let Some(min) = self.number() {
                let max = if self.eat(',') {
                    self.number()
                } else {
                    Some(min)
                };
                if self.eat('}') {
                    if max.is_some_and(|m| m < min) {
                        return Err("a quantifier out of order".to_owned());
                    }
                    return Ok((min, max));
                }
            }
            // Not a quantifier: JavaScript (without the `u` flag) reads the brace as a literal.
            self.at = back;
        }
        Ok((1, Some(1)))
    }

    fn escape(&mut self) -> Result<Result<u16, Set>, String> {
        let u = self.next()?;
        let c = char::from_u32(u32::from(u)).unwrap_or('\0');
        Ok(match c {
            'd' => Err(Set::Digit(false)),
            'D' => Err(Set::Digit(true)),
            'w' => Err(Set::Word(false)),
            'W' => Err(Set::Word(true)),
            's' => Err(Set::Space(false)),
            'S' => Err(Set::Space(true)),
            'n' => Ok(0x0a),
            'r' => Ok(0x0d),
            't' => Ok(0x09),
            'f' => Ok(0x0c),
            'v' => Ok(0x0b),
            '0' => Ok(0),
            c if c.is_ascii_punctuation() => Ok(u),
            other => return Err(format!("the escape \\{other}")),
        })
    }

    fn atom(&mut self) -> Result<Node, String> {
        let u = self.next()?;
        let c = char::from_u32(u32::from(u)).unwrap_or('\0');
        Ok(match c {
            '^' => Node::Start,
            '$' => Node::End,
            '.' => Node::Any,
            '(' => {
                let node = if self.eat('?') {
                    if self.eat(':') {
                        Node::Group(self.alt()?)
                    } else if self.eat('=') {
                        Node::Look {
                            alt: self.alt()?,
                            negative: false,
                        }
                    } else if self.eat('!') {
                        Node::Look {
                            alt: self.alt()?,
                            negative: true,
                        }
                    } else {
                        return Err("a group kind this matcher does not read".to_owned());
                    }
                } else {
                    Node::Group(self.alt()?)
                };
                if !self.eat(')') {
                    return Err("an unclosed group".to_owned());
                }
                node
            }
            '[' => Node::Class(self.class()?),
            '\\' if self.eat('b') => Node::Boundary(false),
            '\\' if self.eat('B') => Node::Boundary(true),
            '\\' => match self.escape()? {
                Ok(u) => Node::Unit(u),
                Err(set) => Node::Class(Class {
                    negated: false,
                    ranges: Vec::new(),
                    sets: vec![set],
                }),
            },
            '*' | '+' | '?' => return Err("nothing to repeat".to_owned()),
            _ => Node::Unit(u),
        })
    }

    fn class(&mut self) -> Result<Class, String> {
        let negated = self.eat('^');
        let mut ranges = Vec::new();
        let mut sets = Vec::new();
        let mut first = true;
        loop {
            let u = self.next()?;
            if u == unit(']') && !first {
                break;
            }
            if u == unit(']') {
                // `[]` matches nothing and `[^]` everything; no schema uses either.
                return Err("an empty class".to_owned());
            }
            first = false;
            let lo = if u == unit('\\') {
                match self.escape()? {
                    Ok(v) => v,
                    Err(set) => {
                        sets.push(set);
                        continue;
                    }
                }
            } else {
                u
            };
            // A range, unless the `-` is the last thing in the class.
            if self.peek() == Some(unit('-'))
                && self.units.get(self.at + 1).is_some_and(|n| *n != unit(']'))
            {
                self.at += 1;
                let h = self.next()?;
                let hi = if h == unit('\\') {
                    match self.escape()? {
                        Ok(v) => v,
                        Err(_) => return Err("a range ending in a set".to_owned()),
                    }
                } else {
                    h
                };
                if hi < lo {
                    return Err("a range out of order".to_owned());
                }
                ranges.push((lo, hi));
            } else {
                ranges.push((lo, lo));
            }
        }
        Ok(Class {
            negated,
            ranges,
            sets,
        })
    }
}

/// What is left to match after the current term: the rest of each enclosing sequence, innermost first.
#[derive(Clone, Copy)]
enum Next<'a> {
    Done,
    /// The terms after one in a sequence, then what comes after the sequence.
    Seq(&'a [Term], &'a Next<'a>),
    /// One more round of a repeated group, counted so far, then what comes after it.
    Repeat(&'a Term, u32, usize, &'a Next<'a>),
}

impl Regex {
    /// Reads `/<pattern>/` as JavaScript prints a regular expression with no flags.
    pub fn new(literal: &str) -> Result<Regex, String> {
        let body = literal
            .strip_prefix('/')
            .and_then(|r| r.strip_suffix('/'))
            .ok_or_else(|| format!("{literal}: not a /pattern/ with no flags"))?;
        let units: Vec<u16> = body.encode_utf16().collect();
        let mut r = Reader {
            units: &units,
            at: 0,
        };
        let root = r.alt().map_err(|e| format!("{literal}: {e}"))?;
        if r.at != units.len() {
            return Err(format!("{literal}: an unmatched )"));
        }
        Ok(Regex {
            source: literal.to_owned(),
            root,
        })
    }

    /// The pattern as JavaScript prints it (`RegExp.prototype.toString`).
    pub fn source(&self) -> &str {
        &self.source
    }

    /// `RegExp.prototype.test(text)`.
    pub fn test(&self, text: &str) -> bool {
        let units: Vec<u16> = text.encode_utf16().collect();
        let m = Matcher { text: &units };
        (0..=units.len()).any(|start| m.alt(&self.root, start, &Next::Done))
    }
}

struct Matcher<'t> {
    text: &'t [u16],
}

impl Matcher<'_> {
    fn alt(&self, a: &Alt, pos: usize, next: &Next<'_>) -> bool {
        a.0.iter().any(|seq| self.seq(seq, pos, next))
    }

    fn seq(&self, terms: &[Term], pos: usize, next: &Next<'_>) -> bool {
        match terms.split_first() {
            None => self.resume(pos, next),
            Some((t, rest)) => {
                let after = Next::Seq(rest, next);
                self.term(t, pos, &after)
            }
        }
    }

    fn resume(&self, pos: usize, next: &Next<'_>) -> bool {
        match next {
            Next::Done => true,
            Next::Seq(rest, outer) => self.seq(rest, pos, outer),
            Next::Repeat(t, count, started, outer) => {
                // An empty round would repeat for ever: JavaScript stops one that matched nothing.
                if pos == *started && *count > t.min {
                    return false;
                }
                self.repeat(t, *count, pos, outer)
            }
        }
    }

    /// A unit the atom matches by itself, when it is one unit wide.
    fn single(&self, node: &Node, pos: usize) -> Option<bool> {
        let u = self.text.get(pos).copied();
        match node {
            Node::Unit(c) => Some(u == Some(*c)),
            Node::Any => Some(u.is_some_and(|u| !is_line_terminator(u))),
            Node::Class(c) => Some(u.is_some_and(|u| c.has(u))),
            _ => None,
        }
    }

    fn term(&self, t: &Term, pos: usize, next: &Next<'_>) -> bool {
        match &t.node {
            Node::Start => pos == 0 && self.resume(pos, next),
            Node::End => pos == self.text.len() && self.resume(pos, next),
            Node::Boundary(negated) => {
                let word = |p: Option<usize>| {
                    p.and_then(|p| self.text.get(p))
                        .is_some_and(|u| Set::Word(false).has(*u))
                };
                let at = word(pos.checked_sub(1)) != word(Some(pos));
                at != *negated && self.resume(pos, next)
            }
            Node::Look { alt, negative } => {
                (self.alt(alt, pos, &Next::Done) != *negative) && self.resume(pos, next)
            }
            node if self.single(node, pos).is_some() => {
                // One unit at a time: count how far it reaches, then try each length, longest first when greedy.
                let max = t.max.map_or(usize::MAX, |m| m as usize);
                let mut reach = 0usize;
                while reach < max && self.single(node, pos + reach) == Some(true) {
                    reach += 1;
                }
                let min = t.min as usize;
                if reach < min {
                    return false;
                }
                if t.greedy {
                    (min..=reach).rev().any(|n| self.resume(pos + n, next))
                } else {
                    (min..=reach).any(|n| self.resume(pos + n, next))
                }
            }
            _ => self.repeat(t, 0, pos, next),
        }
    }

    /// A group repeated: `count` rounds so far.
    fn repeat(&self, t: &Term, count: u32, pos: usize, next: &Next<'_>) -> bool {
        let Node::Group(alt) = &t.node else {
            return false;
        };
        let more = t.max.is_none_or(|m| count < m);
        let again = |m: &Self| {
            more && {
                let round = Next::Repeat(t, count + 1, pos, next);
                m.alt(alt, pos, &round)
            }
        };
        let stop = |m: &Self| count >= t.min && m.resume(pos, next);
        if t.greedy {
            return again(self) || stop(self);
        }
        stop(self) || again(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn re(s: &str) -> Regex {
        Regex::new(s).unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn a_word_boundary_reads_as_javascript_reads_it() {
        let b = re(r"/\bleader\s?board\b/");
        assert!(b.test("show the leaderboard now"));
        assert!(b.test("leader board"));
        assert!(!b.test("leaderboards"));
        assert!(!b.test("xleaderboard"));
        // An accented letter is not a word character: the boundary falls on either side of it, as in JavaScript.
        assert!(re(r"/\bl[ií]der\b/").test("el líder"));
        assert!(re(r"/a\Bb/").test("ab"));
        assert!(!re(r"/a\Bb/").test("a b"));
        assert!(Regex::new(r"/\b+/").is_err());
    }

    #[test]
    fn matches_the_schema_patterns_as_javascript_does() {
        let slug = re("/^[a-z0-9]+(?:-[a-z0-9]+)*$/");
        assert!(slug.test("my-course-2"));
        assert!(!slug.test("my--course"));
        assert!(!slug.test("-x"));
        let weight = re(r"/^(?:0\.(?=\d*[1-9])\d{1,4}|1(?:\.0{1,4})?)$/");
        assert!(weight.test("0.25"));
        assert!(weight.test("1.0000"));
        assert!(!weight.test("0.0000"));
        assert!(!weight.test("1.00001"));
        let amount = re(r"/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/");
        assert!(amount.test("999999.99"));
        assert!(!amount.test("01"));
        let ip = re(
            r"/^(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9a-fA-F:]*:[0-9a-fA-F:.]*)(?:\/[0-9]{1,3})?$/",
        );
        assert!(ip.test("10.0.0.0/8"));
        assert!(ip.test("::1"));
        assert!(!ip.test("10.0.0"));
        let mime = re(r"/^[a-z]+\/[a-z0-9.+-]+$/");
        assert!(mime.test("video/mp4"));
        assert!(!mime.test("Video/mp4"));
        let tag = re("/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/");
        assert!(tag.test("zh-Hant-TW"));
        assert!(!tag.test("zh-"));
        assert_eq!(slug.source(), "/^[a-z0-9]+(?:-[a-z0-9]+)*$/");
    }

    #[test]
    fn counts_utf16_units_and_treats_dot_as_javascript() {
        // An astral character is two units: `.{2}` matches it whole.
        assert!(re("/^.{2}$/").test("😀"));
        assert!(!re("/^.$/").test("😀"));
        assert!(!re("/^.$/").test("\n"));
        assert!(re(r"/^\s$/").test("\u{feff}"));
        assert!(!re(r"/^\s$/").test("\u{85}"));
    }

    #[test]
    fn refuses_what_it_does_not_read() {
        assert!(Regex::new("/a/i").is_err());
        assert!(Regex::new(r"/(?<n>a)/").is_err());
        assert!(Regex::new(r"/\p{L}/").is_err());
    }

    #[test]
    fn a_long_input_does_not_recurse_per_unit() {
        let long = "a".repeat(200_000);
        assert!(re("/^[a-z0-9-]+$/").test(&long));
    }
}
