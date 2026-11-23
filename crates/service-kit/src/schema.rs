//! zod 4 run over a schema described as data: a tree of parts (`string`, `object`, `union`, ...) each with its checks,
//! read from the JSON a service's recorder writes from its TypeScript schemas. Same verdicts as `schema.parse` in
//! tRPC: the same issues, with the same fields in the same order, the same paths and the same English messages, and the
//! same output (trimmed strings, applied defaults, coerced dates, stripped keys).
//!
//! It follows zod's own source (`zod/v4/core/schemas.js`, `checks.js`, `util.js`, `locales/en.js`, v4.6.7): the
//! object parser is the JIT one tRPC's synchronous parse takes, checks run in order and skip once an issue aborts (a
//! length check only once one aborts explicitly), an array's leading size cap refuses before any element is read, and a
//! union keeps the one option that did not abort. A refine is the service's own code, named in the tree and run
//! through [`Refiner`]; a refine that throws stops the whole parse, as it does in zod.
//!
//! `zod.rs` keeps the hand-written primitives svc-tax's inputs are built from; this module is for a service whose
//! schemas are many and are checked against a recorded tree (svc-academy: `crates/svc-academy/src/door/schemas.json`).

use crate::json::{self, Json};
use crate::jsregex::{self, Regex};
use crate::time;

/// A value as zod sees it: JSON, plus `undefined` (an absent field) and `Date` (a coerced date; `None` is
/// `Invalid Date`).
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
    Date(Option<i64>),
}

impl Value {
    pub fn from_json(j: &Json) -> Value {
        match j {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(*b),
            Json::Number(n) => Value::Number(*n),
            Json::String(s) => Value::String(s.clone()),
            Json::Array(a) => Value::Array(a.iter().map(Value::from_json).collect()),
            Json::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, v)| (k.clone(), Value::from_json(v)))
                    .collect(),
            ),
        }
    }

    /// `JSON.parse(JSON.stringify(value))`: `None` for `undefined`; a date as its ISO text (`null` when invalid); an
    /// object's undefined fields dropped and an array's written as `null`; keys in JavaScript's order.
    pub fn to_json(&self) -> Option<Json> {
        Some(match self {
            Value::Undefined => return None,
            Value::Null | Value::Date(None) => Json::Null,
            Value::Bool(b) => Json::Bool(*b),
            Value::Number(n) => Json::Number(*n),
            Value::String(s) => Json::String(s.clone()),
            Value::Date(Some(ms)) => Json::String(time::Instant(*ms).iso()),
            Value::Array(a) => Json::Array(
                a.iter()
                    .map(|v| v.to_json().unwrap_or(Json::Null))
                    .collect(),
            ),
            Value::Object(o) => Json::Object(json::js_key_order(
                o.iter()
                    .filter_map(|(k, v)| v.to_json().map(|j| (k.clone(), j)))
                    .collect(),
            )),
        })
    }

    /// The field `key` of an object (`undefined` when absent or not an object).
    pub fn get(&self, key: &str) -> &Value {
        match self {
            Value::Object(o) => o
                .iter()
                .rev()
                .find(|(k, _)| k == key)
                .map_or(&Value::Undefined, |(_, v)| v),
            _ => &Value::Undefined,
        }
    }

    /// `key in value`.
    pub fn has(&self, key: &str) -> bool {
        matches!(self, Value::Object(o) if o.iter().any(|(k, _)| k == key))
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            _ => None,
        }
    }

    /// JavaScript truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            Value::Undefined | Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => !(n.is_nan() || *n == 0.0),
            Value::String(s) => !s.is_empty(),
            Value::Array(_) | Value::Object(_) | Value::Date(_) => true,
        }
    }

    /// `String(value)` for what an array join or a template prints.
    pub fn js_string(&self) -> String {
        match self {
            Value::Undefined => "undefined".to_owned(),
            Value::Null => "null".to_owned(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => json::js_number_string(*n),
            Value::String(s) => s.clone(),
            Value::Array(a) => join(a),
            Value::Object(_) => "[object Object]".to_owned(),
            Value::Date(None) => "Invalid Date".to_owned(),
            Value::Date(Some(ms)) => time::Instant(*ms).iso(),
        }
    }

    /// zod's `parsedType`, as an `invalid_type` message names what arrived.
    fn parsed_type(&self) -> String {
        match self {
            Value::Undefined => "undefined".to_owned(),
            Value::Null => "null".to_owned(),
            Value::Bool(_) => "boolean".to_owned(),
            Value::Number(n) if n.is_nan() => "NaN".to_owned(),
            Value::Number(n) if n.is_infinite() => json::js_number_string(*n),
            Value::Number(_) => "number".to_owned(),
            Value::String(_) => "string".to_owned(),
            Value::Array(_) => "array".to_owned(),
            Value::Object(_) => "object".to_owned(),
            Value::Date(_) => "Date".to_owned(),
        }
    }

    /// Equal as a `Set.has` finds it (SameValueZero) against a literal or enum value.
    fn same(&self, j: &Json) -> bool {
        match (self, j) {
            (Value::Null, Json::Null) => true,
            (Value::Bool(a), Json::Bool(b)) => a == b,
            (Value::Number(a), Json::Number(b)) => a == b,
            (Value::String(a), Json::String(b)) => a == b,
            _ => false,
        }
    }
}

/// `Array.prototype.join(",")`: `null` and `undefined` print as nothing.
fn join(a: &[Value]) -> String {
    a.iter()
        .map(|v| match v {
            Value::Undefined | Value::Null => String::new(),
            v => v.js_string(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// `new Date(value)` on a value read from JSON.
fn new_date(v: &Value) -> Option<i64> {
    match v {
        Value::Undefined => None,
        Value::Null => Some(0),
        Value::Bool(b) => Some(i64::from(*b)),
        Value::Number(n) => time::time_clip(*n),
        Value::String(s) => time::v8_date_parse(s),
        Value::Array(a) => time::v8_date_parse(&join(a)),
        Value::Object(_) => time::v8_date_parse("[object Object]"),
        Value::Date(d) => *d,
    }
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    let space = |c: char| u16::try_from(u32::from(c)).is_ok_and(jsregex::is_js_space);
    s.trim_matches(space)
}

/// `"..."` for a string, the value itself otherwise (`util.stringifyPrimitive`).
fn primitive(j: &Json) -> String {
    match j {
        Json::String(s) => format!("\"{s}\""),
        Json::Number(n) => json::js_number_string(*n),
        Json::Bool(b) => b.to_string(),
        Json::Null => "null".to_owned(),
        other => other.compact(),
    }
}

/// Whether an issue lets later checks run: zod's `continue`, which may be absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cont {
    Yes,
    No,
    Unset,
}

/// One zod issue: its fields in the order zod made them (without `input`, `inst` and `continue`), its path, and its
/// English message.
#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    fields: Vec<(&'static str, Json)>,
    path: Vec<Json>,
    message: String,
    cont: Cont,
    /// `ctx.addIssue({ code, message, path })`: the message ahead of the path, in the order the call wrote them.
    message_first: bool,
}

impl Issue {
    fn new(fields: Vec<(&'static str, Json)>, message: String, cont: Cont) -> Issue {
        Issue {
            fields,
            path: Vec::new(),
            message,
            cont,
            message_first: false,
        }
    }

    fn at(mut self, path: Vec<Json>) -> Issue {
        self.path = path;
        self
    }

    /// The issue as zod's `error.issues` holds it.
    pub fn json(&self) -> Json {
        let mut out: Vec<(String, Json)> = self
            .fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect();
        let path = ("path".to_owned(), Json::Array(self.path.clone()));
        let message = ("message".to_owned(), Json::str(self.message.clone()));
        if self.message_first {
            out.extend([message, path]);
        } else {
            out.extend([path, message]);
        }
        Json::Object(out)
    }

    pub fn code(&self) -> &str {
        self.fields
            .iter()
            .find(|(k, _)| *k == "code")
            .and_then(|(_, v)| match v {
                Json::String(s) => Some(s.as_str()),
                _ => None,
            })
            .unwrap_or("")
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    /// The issue's path (`issue.path`).
    pub fn path(&self) -> &[Json] {
        &self.path
    }
}

/// The message tRPC sends for a refused input: zod's `error.message`, the issues as pretty JSON.
pub fn message(issues: &[Issue]) -> String {
    Json::Array(issues.iter().map(Issue::json).collect()).pretty()
}

/// The issues as compact JSON (`JSON.stringify(error.issues)`).
pub fn issues_json(issues: &[Issue]) -> Json {
    Json::Array(issues.iter().map(Issue::json).collect())
}

/// The service's refines, by the name the tree gives them: `Ok(true)` passes, `Ok(false)` raises the refine's issue,
/// `Err(message)` is a refine that threw.
pub trait Refiner {
    fn refine(&self, id: &str, value: &Value) -> Result<bool, String>;
    /// A `superRefine` named `id`: the issues its `ctx.addIssue` calls add (code `custom`, and the parse goes on, as zod
    /// 3's form of `addIssue` sets it). A service without one refuses the name.
    fn super_refine(&self, id: &str, value: &Value) -> Result<Vec<Added>, String> {
        let _ = value;
        Err(format!("no superRefine named {id}"))
    }
}

/// One `ctx.addIssue({ code: 'custom', ... })`: its path and message, and which of the two the call wrote first (an
/// absent path is written after the message).
#[derive(Debug, Clone, PartialEq)]
pub struct Added {
    pub path: Vec<Json>,
    pub message: String,
    pub message_first: bool,
}

impl Added {
    /// `ctx.addIssue({ code, path, message })`, or `{ code, message }` when the path is empty: zod then writes the path
    /// after the message.
    pub fn at(path: Vec<Json>, message: impl Into<String>) -> Added {
        Added {
            message_first: path.is_empty(),
            path,
            message: message.into(),
        }
    }

    /// `ctx.addIssue({ code, message, path })`, or `{ code, message }` with no path.
    pub fn saying(message: impl Into<String>, path: Vec<Json>) -> Added {
        Added {
            path,
            message: message.into(),
            message_first: true,
        }
    }
}

/// A refine threw: the parse stops, and tRPC answers 400 with this message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thrown(pub String);

#[derive(Debug, Clone)]
enum Check {
    MinLength(usize),
    MaxLength(usize),
    /// `.length(n)`: exactly `n` (code points for a string, as the length checks count them).
    LengthEquals(usize),
    Regex(Regex, Option<String>),
    StartsWith(String, Option<String>),
    Format(&'static str, Regex, Option<String>),
    Url(Option<String>),
    Trim,
    Lower,
    Gt(f64, bool, Option<String>),
    Lt(f64, bool, Option<String>),
    Int,
    Refine {
        id: String,
        path: Vec<Json>,
        msg: Option<String>,
        abort: bool,
    },
    /// `superRefine(fn)`: the service's own code adds its issues.
    Super(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Catchall {
    Strip,
    Strict,
    Passthrough,
}

#[derive(Debug, Clone)]
enum Kind {
    String,
    Number,
    Boolean,
    Date {
        coerce: bool,
    },
    Unknown,
    Enum(Vec<Json>),
    Literal(Vec<Json>),
    Object(Vec<(String, usize)>, Catchall),
    Array(usize),
    Optional(usize),
    Nullable(usize),
    Default(usize, Json),
    Union(Vec<usize>),
    Dunion(String, Vec<usize>),
    Record(usize, usize),
    Lazy(usize),
    /// `.pipe()`: the first part's output into the second; any issue but an unrecognized key stops the pipe.
    Pipe(usize, usize),
}

#[derive(Debug, Clone)]
struct Node {
    kind: Kind,
    checks: Vec<Check>,
    /// The part's own `error` where it gives one message for any input but `undefined` (recorded as `definedMsg`):
    /// that message on the type issue the part raises; an absent input keeps zod's own.
    defined_msg: Option<String>,
}

/// zod's `optin` and `optout`: whether an absent key is allowed in, and whether `undefined` may come out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Optin {
    None,
    Optional,
    Defaulted,
}

/// The tree: every part once, by number; each input names its root part.
#[derive(Debug, Clone)]
pub struct Schema {
    nodes: Vec<Node>,
}

/// The input's verdict: its output, or zod's issues.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Ok(Value),
    Issues(Vec<Issue>),
}

struct Payload {
    value: Value,
    issues: Vec<Issue>,
}

impl Payload {
    fn of(value: Value) -> Payload {
        Payload {
            value,
            issues: Vec::new(),
        }
    }
}

/// `util.aborted`: an issue from `from` on that does not let later checks run.
fn aborted(issues: &[Issue], from: usize) -> bool {
    issues.iter().skip(from).any(|i| i.cont != Cont::Yes)
}

/// `util.explicitlyAborted`: an issue that stops even the length checks.
fn explicitly_aborted(issues: &[Issue]) -> bool {
    issues.iter().any(|i| i.cont == Cont::No)
}

fn prefix(issues: Vec<Issue>, seg: &Json) -> impl Iterator<Item = Issue> + '_ {
    issues.into_iter().map(move |mut i| {
        i.path.insert(0, seg.clone());
        i
    })
}

fn cont(abort: bool) -> Cont {
    if abort { Cont::No } else { Cont::Yes }
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const MIN_SAFE_INTEGER: f64 = -9_007_199_254_740_991.0;

fn field_str<'a>(o: &'a Json, k: &str) -> Option<&'a str> {
    match o.get(k) {
        Some(Json::String(s)) => Some(s),
        _ => None,
    }
}

fn field_usize(o: &Json, k: &str) -> Result<usize, String> {
    match o.get(k) {
        Some(Json::Number(n)) if *n >= 0.0 && n.fract() == 0.0 => format!("{n}")
            .parse::<usize>()
            .map_err(|e| format!("{k}: {e}")),
        _ => Err(format!("a part without its {k}")),
    }
}

fn field_f64(o: &Json, k: &str) -> Result<f64, String> {
    match o.get(k) {
        Some(Json::Number(n)) => Ok(*n),
        _ => Err(format!("a check without its {k}")),
    }
}

fn read_check(c: &Json) -> Result<Check, String> {
    let msg = field_str(c, "msg").map(str::to_owned);
    let abort = matches!(c.get("abort"), Some(Json::Bool(true)));
    let k = field_str(c, "k").ok_or("a check without its kind")?;
    Ok(match k {
        "min_length" => Check::MinLength(field_usize(c, "n")?),
        "max_length" => Check::MaxLength(field_usize(c, "n")?),
        "length_equals" => Check::LengthEquals(field_usize(c, "n")?),
        "regex" => Check::Regex(
            Regex::new(field_str(c, "src").ok_or("a regex without its source")?)?,
            msg,
        ),
        "starts_with" => Check::StartsWith(
            field_str(c, "prefix")
                .ok_or("starts_with without its prefix")?
                .to_owned(),
            msg,
        ),
        "format" => {
            let format = match field_str(c, "format") {
                Some("guid") => "guid",
                Some("datetime") => "datetime",
                Some("uuid") => "uuid",
                Some("date") => "date",
                other => return Err(format!("an unknown format {other:?}")),
            };
            Check::Format(
                format,
                Regex::new(field_str(c, "src").ok_or("a format without its pattern")?)?,
                msg,
            )
        }
        "url" => Check::Url(msg),
        "trim" => Check::Trim,
        "lower" => Check::Lower,
        "gt" | "lt" => {
            let v = field_f64(c, "v")?;
            let incl = matches!(c.get("incl"), Some(Json::Bool(true)));
            if k == "gt" {
                Check::Gt(v, incl, msg)
            } else {
                Check::Lt(v, incl, msg)
            }
        }
        "int" => Check::Int,
        "super" => Check::Super(
            field_str(c, "id")
                .ok_or("a superRefine without its name")?
                .to_owned(),
        ),
        "refine" => Check::Refine {
            id: field_str(c, "id")
                .ok_or("a refine without its name")?
                .to_owned(),
            path: match c.get("path") {
                Some(Json::Array(p)) => p.clone(),
                _ => Vec::new(),
            },
            msg,
            abort,
        },
        other => return Err(format!("an unknown check {other:?}")),
    })
}

fn values(n: &Json) -> Result<Vec<Json>, String> {
    match n.get("values") {
        Some(Json::Array(v)) => Ok(v.clone()),
        _ => Err("an enum without its values".to_owned()),
    }
}

fn ids(n: &Json, k: &str) -> Result<Vec<usize>, String> {
    match n.get(k) {
        Some(Json::Array(v)) => v
            .iter()
            .map(|x| match x {
                Json::Number(_) => field_usize(&Json::obj([("i", x.clone())]), "i"),
                _ => Err(format!("{k}: not a part number")),
            })
            .collect(),
        _ => Err(format!("a part without its {k}")),
    }
}

fn read_node(n: &Json) -> Result<Node, String> {
    let t = field_str(n, "t").ok_or("a part without its type")?;
    let kind = match t {
        "string" => Kind::String,
        "number" => Kind::Number,
        "boolean" => Kind::Boolean,
        "date" => Kind::Date {
            coerce: matches!(n.get("coerce"), Some(Json::Bool(true))),
        },
        "unknown" => Kind::Unknown,
        "enum" => Kind::Enum(values(n)?),
        "literal" => Kind::Literal(values(n)?),
        "object" => {
            let shape = match n.get("shape") {
                Some(Json::Array(s)) => s
                    .iter()
                    .map(|pair| match pair {
                        Json::Array(kv) => match kv.as_slice() {
                            [Json::String(k), id] => Ok((
                                k.clone(),
                                field_usize(&Json::obj([("i", id.clone())]), "i")?,
                            )),
                            _ => Err("a shape entry is [key, part]".to_owned()),
                        },
                        _ => Err("a shape entry is [key, part]".to_owned()),
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                _ => return Err("an object without its shape".to_owned()),
            };
            let catchall = match field_str(n, "catchall") {
                None => Catchall::Strip,
                Some("strict") => Catchall::Strict,
                Some("passthrough") => Catchall::Passthrough,
                Some(other) => return Err(format!("an unknown catchall {other}")),
            };
            Kind::Object(shape, catchall)
        }
        "array" => Kind::Array(field_usize(n, "el")?),
        "optional" => Kind::Optional(field_usize(n, "in")?),
        "nullable" => Kind::Nullable(field_usize(n, "in")?),
        "default" => Kind::Default(
            field_usize(n, "in")?,
            n.get("value").cloned().unwrap_or(Json::Null),
        ),
        // `.readonly()` parses as its inner part does (it only freezes the output), as a lazy part does.
        "lazy" | "readonly" => Kind::Lazy(field_usize(n, "in")?),
        "union" => Kind::Union(ids(n, "options")?),
        "dunion" => Kind::Dunion(
            field_str(n, "disc")
                .ok_or("a discriminated union without its key")?
                .to_owned(),
            ids(n, "options")?,
        ),
        "record" => Kind::Record(field_usize(n, "key")?, field_usize(n, "value")?),
        "pipe" => Kind::Pipe(field_usize(n, "in")?, field_usize(n, "out")?),
        other => return Err(format!("an unknown part {other}")),
    };
    let checks: Vec<Check> = match n.get("checks") {
        Some(Json::Array(c)) => c.iter().map(read_check).collect::<Result<_, _>>()?,
        _ => Vec::new(),
    };
    // A stopped pipe marks its payload aborted, which skips its own checks; no recorded pipe carries any.
    if matches!(kind, Kind::Pipe(..)) && !checks.is_empty() {
        return Err("a pipe with its own checks".to_owned());
    }
    let defined_msg = field_str(n, "definedMsg").map(str::to_owned);
    if defined_msg.is_some() && !(matches!(kind, Kind::String) && checks.is_empty()) {
        return Err("an own error is recorded only on a string without checks".to_owned());
    }
    Ok(Node {
        kind,
        checks,
        defined_msg,
    })
}

/// The length a length check reads (`input.length`), and whether it has one at all (`_whenHasLength`).
enum Length {
    None,
    Str(usize, usize),
    Count(f64),
}

fn length_of(v: &Value) -> Length {
    match v {
        Value::String(s) => Length::Str(s.encode_utf16().count(), s.chars().count()),
        Value::Array(a) => Length::Count(f64::from(u32::try_from(a.len()).unwrap_or(u32::MAX))),
        Value::Object(_) => match v.get("length") {
            Value::Undefined => Length::None,
            Value::Number(n) => Length::Count(*n),
            Value::Null => Length::Count(0.0),
            Value::Bool(b) => Length::Count(if *b { 1.0 } else { 0.0 }),
            Value::String(s) => Length::Count(js_trim(s).parse::<f64>().unwrap_or(f64::NAN)),
            _ => Length::Count(f64::NAN),
        },
        _ => Length::None,
    }
}

fn origin(v: &Value) -> &'static str {
    match v {
        Value::Array(_) => "array",
        Value::String(_) => "string",
        _ => "unknown",
    }
}

fn units(origin: &str) -> Option<&'static str> {
    match origin {
        "string" => Some("characters"),
        "array" => Some("items"),
        _ => None,
    }
}

fn num(n: usize) -> Json {
    Json::int(i64::try_from(n).unwrap_or(i64::MAX))
}

fn usize_f64(n: usize) -> f64 {
    f64::from(u32::try_from(n).unwrap_or(u32::MAX))
}

impl Schema {
    /// The tree from the recorder's `{nodes, ...}`.
    pub fn from_json(doc: &Json) -> Result<Schema, String> {
        let Some(Json::Array(nodes)) = doc.get("nodes") else {
            return Err("a schema file without its parts".to_owned());
        };
        let nodes = nodes
            .iter()
            .enumerate()
            .map(|(i, n)| read_node(n).map_err(|e| format!("part {i}: {e}")))
            .collect::<Result<Vec<_>, _>>()?;
        let schema = Schema { nodes };
        for (i, n) in schema.nodes.iter().enumerate() {
            let refs: Vec<usize> = match &n.kind {
                Kind::Object(shape, _) => shape.iter().map(|(_, id)| *id).collect(),
                Kind::Array(a)
                | Kind::Optional(a)
                | Kind::Nullable(a)
                | Kind::Default(a, _)
                | Kind::Lazy(a) => vec![*a],
                Kind::Union(o) | Kind::Dunion(_, o) => o.clone(),
                Kind::Record(k, v) | Kind::Pipe(k, v) => vec![*k, *v],
                _ => Vec::new(),
            };
            if let Some(bad) = refs.iter().find(|r| **r >= schema.nodes.len()) {
                return Err(format!("part {i} names part {bad}, which is not there"));
            }
        }
        Ok(schema)
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    fn node(&self, id: usize) -> Result<&Node, Thrown> {
        self.nodes
            .get(id)
            .ok_or_else(|| Thrown(format!("schema part {id} is not there")))
    }

    /// `schema.parse(input)` for the part `root`: the output, zod's issues, or the message of a refine that threw.
    pub fn parse(
        &self,
        root: usize,
        input: Value,
        refiner: &dyn Refiner,
    ) -> Result<Outcome, Thrown> {
        let p = self.run(root, Payload::of(input), refiner, 0)?;
        Ok(if p.issues.is_empty() {
            Outcome::Ok(p.value)
        } else {
            Outcome::Issues(p.issues)
        })
    }

    fn optin(&self, id: usize, depth: u32) -> (Optin, bool) {
        let Some(n) = self.nodes.get(id) else {
            return (Optin::None, false);
        };
        if depth > 64 {
            return (Optin::None, false);
        }
        match &n.kind {
            Kind::Optional(inner) => {
                let (i, _) = self.optin(*inner, depth + 1);
                (
                    if i == Optin::Defaulted {
                        Optin::Defaulted
                    } else {
                        Optin::Optional
                    },
                    true,
                )
            }
            Kind::Default(..) => (Optin::Defaulted, false),
            Kind::Nullable(inner) | Kind::Lazy(inner) => self.optin(*inner, depth + 1),
            // `optin` is the first part's, `optout` the second's.
            Kind::Pipe(from, to) => (self.optin(*from, depth + 1).0, self.optin(*to, depth + 1).1),
            Kind::Union(options) | Kind::Dunion(_, options) => {
                let each: Vec<_> = options.iter().map(|o| self.optin(*o, depth + 1)).collect();
                let optin = if each.iter().any(|(i, _)| *i == Optin::Defaulted) {
                    Optin::Defaulted
                } else if each.iter().any(|(i, _)| *i != Optin::None) {
                    Optin::Optional
                } else {
                    Optin::None
                };
                (optin, each.iter().any(|(_, o)| *o))
            }
            _ => (Optin::None, false),
        }
    }

    /// The values a part admits, as a discriminator reads them (`_zod.values`); `None` when it admits any.
    fn admitted(&self, id: usize, depth: u32) -> Option<Vec<Option<Json>>> {
        let n = self.nodes.get(id)?;
        if depth > 64 {
            return None;
        }
        match &n.kind {
            Kind::Enum(v) | Kind::Literal(v) => Some(v.iter().cloned().map(Some).collect()),
            Kind::Optional(inner) => {
                let mut v = self.admitted(*inner, depth + 1)?;
                v.push(None);
                Some(v)
            }
            Kind::Nullable(inner) => {
                let mut v = self.admitted(*inner, depth + 1)?;
                v.push(Some(Json::Null));
                Some(v)
            }
            Kind::Default(inner, _) | Kind::Lazy(inner) | Kind::Pipe(inner, _) => {
                self.admitted(*inner, depth + 1)
            }
            _ => None,
        }
    }

    /// The object a discriminated union's option is, through any lazy.
    fn shape_of(&self, id: usize, depth: u32) -> Option<&[(String, usize)]> {
        match &self.nodes.get(id)?.kind {
            Kind::Object(shape, _) => Some(shape),
            Kind::Lazy(inner) if depth < 64 => self.shape_of(*inner, depth + 1),
            _ => None,
        }
    }

    fn run(
        &self,
        id: usize,
        p: Payload,
        refiner: &dyn Refiner,
        depth: u32,
    ) -> Result<Payload, Thrown> {
        if depth > 256 {
            return Err(Thrown("Maximum call stack size exceeded".to_owned()));
        }
        let node = self.node(id)?;
        let p = self.parse_kind(node, p, refiner, depth)?;
        self.run_checks(&node.checks, p, refiner)
    }

    fn run_checks(
        &self,
        checks: &[Check],
        mut p: Payload,
        refiner: &dyn Refiner,
    ) -> Result<Payload, Thrown> {
        let mut is_aborted = aborted(&p.issues, 0);
        for ch in checks {
            if matches!(
                ch,
                Check::MinLength(_) | Check::MaxLength(_) | Check::LengthEquals(_)
            ) {
                if explicitly_aborted(&p.issues) || matches!(length_of(&p.value), Length::None) {
                    continue;
                }
            } else if is_aborted {
                continue;
            }
            let before = p.issues.len();
            self.check(ch, &mut p, refiner)?;
            if p.issues.len() != before && !is_aborted {
                is_aborted = aborted(&p.issues, before);
            }
        }
        Ok(p)
    }

    fn check(&self, ch: &Check, p: &mut Payload, refiner: &dyn Refiner) -> Result<(), Thrown> {
        match ch {
            Check::MinLength(min) => {
                let length = match length_of(&p.value) {
                    Length::None => return Ok(()),
                    Length::Str(u, cp) => usize_f64(if u >= *min && u < min * 2 { cp } else { u }),
                    Length::Count(n) => n,
                };
                if length >= usize_f64(*min) {
                    return Ok(());
                }
                let o = origin(&p.value);
                let message = match units(o) {
                    Some(u) => format!("Too small: expected {o} to have >={min} {u}"),
                    None => format!("Too small: expected {o} to be >={min}"),
                };
                p.issues.push(Issue::new(
                    vec![
                        ("origin", Json::str(o)),
                        ("code", Json::str("too_small")),
                        ("minimum", num(*min)),
                        ("inclusive", Json::Bool(true)),
                    ],
                    message,
                    Cont::Yes,
                ));
            }
            Check::MaxLength(max) => {
                let length = match length_of(&p.value) {
                    Length::None => return Ok(()),
                    Length::Str(u, cp) => usize_f64(if u > *max { cp } else { u }),
                    Length::Count(n) => n,
                };
                if length <= usize_f64(*max) {
                    return Ok(());
                }
                let o = origin(&p.value);
                let message = match units(o) {
                    Some(u) => format!("Too big: expected {o} to have <={max} {u}"),
                    None => format!("Too big: expected {o} to be <={max}"),
                };
                p.issues.push(Issue::new(
                    vec![
                        ("origin", Json::str(o)),
                        ("code", Json::str("too_big")),
                        ("maximum", num(*max)),
                        ("inclusive", Json::Bool(true)),
                    ],
                    message,
                    Cont::Yes,
                ));
            }
            Check::LengthEquals(n) => {
                let length = match length_of(&p.value) {
                    Length::None => return Ok(()),
                    Length::Str(u, cp) => usize_f64(if u >= *n && u <= n * 2 { cp } else { u }),
                    Length::Count(c) => c,
                };
                if length == usize_f64(*n) {
                    return Ok(());
                }
                let o = origin(&p.value);
                let big = length > usize_f64(*n);
                let (code, bound, word) = if big {
                    ("too_big", "maximum", "Too big")
                } else {
                    ("too_small", "minimum", "Too small")
                };
                let message = match units(o) {
                    Some(u) => format!("{word}: expected {o} to have exactly {n} {u}"),
                    None => format!("{word}: expected {o} to be exactly {n}"),
                };
                p.issues.push(Issue::new(
                    vec![
                        ("origin", Json::str(o)),
                        ("code", Json::str(code)),
                        (bound, num(*n)),
                        ("inclusive", Json::Bool(true)),
                        ("exact", Json::Bool(true)),
                    ],
                    message,
                    Cont::Yes,
                ));
            }
            Check::Regex(re, msg) => {
                let Some(s) = p.value.as_str() else {
                    return Ok(());
                };
                if re.test(s) {
                    return Ok(());
                }
                let message = msg.clone().unwrap_or_else(|| {
                    format!("Invalid string: must match pattern {}", re.source())
                });
                p.issues.push(Issue::new(
                    vec![
                        ("origin", Json::str("string")),
                        ("code", Json::str("invalid_format")),
                        ("format", Json::str("regex")),
                        ("pattern", Json::str(re.source())),
                    ],
                    message,
                    Cont::Yes,
                ));
            }
            Check::Format(format, re, msg) => {
                let Some(s) = p.value.as_str() else {
                    return Ok(());
                };
                if re.test(s) {
                    return Ok(());
                }
                let name = match *format {
                    "guid" => "GUID",
                    "uuid" => "UUID",
                    "date" => "ISO date",
                    _ => "ISO datetime",
                };
                p.issues.push(Issue::new(
                    vec![
                        ("origin", Json::str("string")),
                        ("code", Json::str("invalid_format")),
                        ("format", Json::str(*format)),
                        ("pattern", Json::str(re.source())),
                    ],
                    msg.clone().unwrap_or_else(|| format!("Invalid {name}")),
                    Cont::Yes,
                ));
            }
            Check::StartsWith(prefix, msg) => {
                let Some(s) = p.value.as_str() else {
                    return Ok(());
                };
                if s.starts_with(prefix.as_str()) {
                    return Ok(());
                }
                p.issues.push(Issue::new(
                    vec![
                        ("origin", Json::str("string")),
                        ("code", Json::str("invalid_format")),
                        ("format", Json::str("starts_with")),
                        ("prefix", Json::str(prefix.clone())),
                    ],
                    msg.clone()
                        .unwrap_or_else(|| format!("Invalid string: must start with \"{prefix}\"")),
                    Cont::Yes,
                ));
            }
            Check::Url(msg) => {
                let Some(s) = p.value.as_str() else {
                    return Ok(());
                };
                let trimmed = js_trim(s);
                if url::Url::parse(trimmed).is_ok() {
                    p.value = Value::String(trimmed.replace(['\t', '\n', '\r'], ""));
                    return Ok(());
                }
                p.issues.push(Issue::new(
                    vec![
                        ("code", Json::str("invalid_format")),
                        ("format", Json::str("url")),
                    ],
                    msg.clone().unwrap_or_else(|| "Invalid URL".to_owned()),
                    Cont::Yes,
                ));
            }
            Check::Trim => {
                if let Value::String(s) = &p.value {
                    p.value = Value::String(js_trim(s).to_owned());
                }
            }
            Check::Lower => {
                if let Value::String(s) = &p.value {
                    p.value = Value::String(s.to_lowercase());
                }
            }
            Check::Gt(v, incl, msg) | Check::Lt(v, incl, msg) => {
                let Some(n) = p.value.as_number() else {
                    return Ok(());
                };
                let big = matches!(ch, Check::Lt(..));
                let ok = match (big, *incl) {
                    (false, true) => n >= *v,
                    (false, false) => n > *v,
                    (true, true) => n <= *v,
                    (true, false) => n < *v,
                };
                if ok {
                    return Ok(());
                }
                let adj = match (big, *incl) {
                    (false, true) => ">=",
                    (false, false) => ">",
                    (true, true) => "<=",
                    (true, false) => "<",
                };
                let shown = json::js_number_string(*v);
                let (code, bound, word) = if big {
                    ("too_big", "maximum", "Too big")
                } else {
                    ("too_small", "minimum", "Too small")
                };
                p.issues.push(Issue::new(
                    vec![
                        ("origin", Json::str("number")),
                        ("code", Json::str(code)),
                        (bound, Json::Number(*v)),
                        ("inclusive", Json::Bool(*incl)),
                    ],
                    msg.clone()
                        .unwrap_or_else(|| format!("{word}: expected number to be {adj}{shown}")),
                    Cont::Yes,
                ));
            }
            Check::Int => {
                let Some(n) = p.value.as_number() else {
                    return Ok(());
                };
                if !(n.is_finite() && n.fract() == 0.0) {
                    p.issues.push(Issue::new(
                        vec![
                            ("expected", Json::str("int")),
                            ("format", Json::str("safeint")),
                            ("code", Json::str("invalid_type")),
                        ],
                        format!(
                            "Invalid input: expected int, received {}",
                            p.value.parsed_type()
                        ),
                        Cont::No,
                    ));
                    return Ok(());
                }
                if n.abs() > MAX_SAFE_INTEGER {
                    let note = Json::str("Integers must be within the safe integer range.");
                    let (code, bound, v, message) = if n > 0.0 {
                        (
                            "too_big",
                            "maximum",
                            MAX_SAFE_INTEGER,
                            "Too big: expected int to be <=9007199254740991",
                        )
                    } else {
                        (
                            "too_small",
                            "minimum",
                            MIN_SAFE_INTEGER,
                            "Too small: expected int to be >=-9007199254740991",
                        )
                    };
                    p.issues.push(Issue::new(
                        vec![
                            ("code", Json::str(code)),
                            (bound, Json::Number(v)),
                            ("note", note),
                            ("origin", Json::str("int")),
                            ("inclusive", Json::Bool(true)),
                        ],
                        message.to_owned(),
                        Cont::Yes,
                    ));
                }
            }
            Check::Refine {
                id,
                path,
                msg,
                abort,
            } => {
                if refiner.refine(id, &p.value).map_err(Thrown)? {
                    return Ok(());
                }
                p.issues.push(
                    Issue::new(
                        vec![("code", Json::str("custom"))],
                        msg.clone().unwrap_or_else(|| "Invalid input".to_owned()),
                        cont(*abort),
                    )
                    .at(path.clone()),
                );
            }
            Check::Super(id) => {
                for added in refiner.super_refine(id, &p.value).map_err(Thrown)? {
                    let mut issue = Issue::new(
                        vec![("code", Json::str("custom"))],
                        added.message,
                        Cont::Yes,
                    )
                    .at(added.path);
                    issue.message_first = added.message_first;
                    p.issues.push(issue);
                }
            }
        }
        Ok(())
    }

    fn invalid_type(expected: &str, got: &Value) -> Issue {
        Issue::new(
            vec![
                ("expected", Json::str(expected)),
                ("code", Json::str("invalid_type")),
            ],
            format!(
                "Invalid input: expected {expected}, received {}",
                got.parsed_type()
            ),
            Cont::Unset,
        )
    }

    fn parse_kind(
        &self,
        node: &Node,
        mut p: Payload,
        refiner: &dyn Refiner,
        depth: u32,
    ) -> Result<Payload, Thrown> {
        let d = depth + 1;
        match &node.kind {
            Kind::String => {
                if !matches!(p.value, Value::String(_)) {
                    let mut issue = Self::invalid_type("string", &p.value);
                    if let Some(msg) = node
                        .defined_msg
                        .as_ref()
                        .filter(|_| p.value != Value::Undefined)
                    {
                        issue.message.clone_from(msg);
                    }
                    p.issues.push(issue);
                }
            }
            Kind::Number => match p.value {
                Value::Number(n) if n.is_finite() => {}
                Value::Number(n) => {
                    let shown = json::js_number_string(n);
                    p.issues.push(Issue::new(
                        vec![
                            ("expected", Json::str("number")),
                            ("code", Json::str("invalid_type")),
                            ("received", Json::str(shown.clone())),
                        ],
                        format!("Invalid input: expected number, received {shown}"),
                        Cont::Unset,
                    ));
                }
                _ => p.issues.push(Self::invalid_type("number", &p.value)),
            },
            Kind::Boolean => {
                if !matches!(p.value, Value::Bool(_)) {
                    p.issues.push(Self::invalid_type("boolean", &p.value));
                }
            }
            Kind::Date { coerce } => {
                if *coerce {
                    p.value = Value::Date(new_date(&p.value));
                }
                match p.value {
                    Value::Date(Some(_)) => {}
                    Value::Date(None) => p.issues.push(Issue::new(
                        vec![
                            ("expected", Json::str("date")),
                            ("code", Json::str("invalid_type")),
                            ("received", Json::str("Invalid Date")),
                        ],
                        "Invalid input: expected date, received Date".to_owned(),
                        Cont::Unset,
                    )),
                    _ => p.issues.push(Self::invalid_type("date", &p.value)),
                }
            }
            Kind::Unknown => {}
            Kind::Enum(values) | Kind::Literal(values) => {
                if !values.iter().any(|v| p.value.same(v)) {
                    let message = match values.as_slice() {
                        [one] => format!("Invalid input: expected {}", primitive(one)),
                        _ => format!(
                            "Invalid option: expected one of {}",
                            values.iter().map(primitive).collect::<Vec<_>>().join("|")
                        ),
                    };
                    p.issues.push(Issue::new(
                        vec![
                            ("code", Json::str("invalid_value")),
                            ("values", Json::Array(values.clone())),
                        ],
                        message,
                        Cont::Unset,
                    ));
                }
            }
            Kind::Object(shape, catchall) => return self.object(shape, *catchall, p, refiner, d),
            Kind::Array(el) => {
                let Value::Array(items) = &p.value else {
                    p.issues.push(Self::invalid_type("array", &p.value));
                    return Ok(p);
                };
                // capSize: the leading size checks with an upper bound refuse an oversized array unread.
                let n = items.len();
                let caps: Vec<usize> = node
                    .checks
                    .iter()
                    .map_while(|c| match c {
                        Check::MinLength(_) => Some(None),
                        Check::MaxLength(m) => Some(Some(*m)),
                        _ => None,
                    })
                    .flatten()
                    .collect();
                if let Some(cap) = caps.iter().min()
                    && n > *cap
                    && let Some(max) = caps.iter().find(|m| n > **m)
                {
                    p.issues.push(Issue::new(
                        vec![
                            ("origin", Json::str("array")),
                            ("code", Json::str("too_big")),
                            ("maximum", num(*max)),
                            ("inclusive", Json::Bool(true)),
                        ],
                        format!("Too big: expected array to have <={max} items"),
                        Cont::No,
                    ));
                    return Ok(p);
                }
                let items = items.clone();
                let mut out = Vec::with_capacity(items.len());
                for (i, item) in items.into_iter().enumerate() {
                    let r = self.run(*el, Payload::of(item), refiner, d)?;
                    p.issues.extend(prefix(r.issues, &num(i)));
                    out.push(r.value);
                }
                p.value = Value::Array(out);
            }
            Kind::Optional(inner) => {
                if p.value == Value::Undefined {
                    if self.optin(*inner, 0).0 != Optin::Defaulted {
                        return Ok(p);
                    }
                    let r = self.run(*inner, Payload::of(Value::Undefined), refiner, d)?;
                    p.value = if r.issues.is_empty() {
                        r.value
                    } else {
                        Value::Undefined
                    };
                    return Ok(p);
                }
                return self.run(*inner, p, refiner, d);
            }
            Kind::Nullable(inner) => {
                if p.value == Value::Null {
                    return Ok(p);
                }
                return self.run(*inner, p, refiner, d);
            }
            Kind::Default(inner, value) => {
                if p.value == Value::Undefined {
                    p.value = Value::from_json(value);
                    return Ok(p);
                }
                let mut r = self.run(*inner, p, refiner, d)?;
                if r.value == Value::Undefined {
                    r.value = Value::from_json(value);
                }
                return Ok(r);
            }
            Kind::Lazy(inner) => return self.run(*inner, p, refiner, d),
            // `handlePipeResult`: the second part runs only on what passed the first.
            Kind::Pipe(from, to) => {
                let left = self.run(*from, p, refiner, d)?;
                if left.issues.iter().any(|i| i.code() != "unrecognized_keys") {
                    return Ok(left);
                }
                return self.run(*to, left, refiner, d);
            }
            Kind::Union(options) => {
                if let [only] = options.as_slice() {
                    return self.run(*only, p, refiner, d);
                }
                let mut results = Vec::with_capacity(options.len());
                for o in options {
                    let r = self.run(*o, Payload::of(p.value.clone()), refiner, d)?;
                    if r.issues.is_empty() {
                        return Ok(r);
                    }
                    results.push(r);
                }
                let mut live = results.iter().filter(|r| !aborted(&r.issues, 0));
                if let (Some(_), None) = (live.next(), live.next())
                    && let Some(i) = results.iter().position(|r| !aborted(&r.issues, 0))
                {
                    return Ok(results.swap_remove(i));
                }
                let errors = Json::Array(results.iter().map(|r| issues_json(&r.issues)).collect());
                p.issues.push(Issue::new(
                    vec![("code", Json::str("invalid_union")), ("errors", errors)],
                    "Invalid input".to_owned(),
                    Cont::Unset,
                ));
            }
            Kind::Dunion(disc, options) => {
                if !matches!(p.value, Value::Object(_)) {
                    p.issues.push(Issue::new(
                        vec![
                            ("code", Json::str("invalid_type")),
                            ("expected", Json::str("object")),
                        ],
                        format!(
                            "Invalid input: expected object, received {}",
                            p.value.parsed_type()
                        ),
                        Cont::Unset,
                    ));
                    return Ok(p);
                }
                // The discriminator map: each value once, in the options' order; a value two options claim is
                // ambiguous (only `undefined` may be).
                let mut map: Vec<(Option<Json>, Option<usize>)> = Vec::new();
                for o in options {
                    let claimed = self
                        .shape_of(*o, 0)
                        .and_then(|s| s.iter().find(|(k, _)| k == disc))
                        .and_then(|(_, id)| self.admitted(*id, 0))
                        .ok_or_else(|| Thrown("Invalid discriminated union option".to_owned()))?;
                    for v in claimed {
                        match map.iter_mut().find(|(k, _)| *k == v) {
                            Some(entry) => entry.1 = None,
                            None => map.push((v, Some(*o))),
                        }
                    }
                }
                let key = p.value.get(disc).clone();
                let chosen = map.iter().find_map(|(k, o)| {
                    let hit = match k {
                        None => key == Value::Undefined,
                        Some(j) => key.same(j),
                    };
                    hit.then_some(*o)
                });
                if let Some(Some(o)) = chosen {
                    return self.run(o, p, refiner, d);
                }
                let names: Vec<Json> = map
                    .iter()
                    .filter(|(_, o)| o.is_some())
                    .map(|(k, _)| k.clone().unwrap_or(Json::Null))
                    .collect();
                let message = if names.is_empty() {
                    "Invalid input".to_owned()
                } else {
                    format!(
                        "Invalid discriminator value. Expected {}",
                        names
                            .iter()
                            .map(|n| format!("'{}'", Value::from_json(n).js_string()))
                            .collect::<Vec<_>>()
                            .join(" | ")
                    )
                };
                p.issues.push(
                    Issue::new(
                        vec![
                            ("code", Json::str("invalid_union")),
                            ("errors", Json::Array(Vec::new())),
                            ("note", Json::str("No matching discriminator")),
                            ("discriminator", Json::str(disc.clone())),
                            ("options", Json::Array(names)),
                        ],
                        message,
                        Cont::Unset,
                    )
                    .at(vec![Json::str(disc.clone())]),
                );
            }
            Kind::Record(key, value) => return self.record(*key, *value, p, refiner, d),
        }
        Ok(p)
    }

    fn object(
        &self,
        shape: &[(String, usize)],
        catchall: Catchall,
        mut p: Payload,
        refiner: &dyn Refiner,
        d: u32,
    ) -> Result<Payload, Thrown> {
        if !matches!(p.value, Value::Object(_)) {
            p.issues.push(Self::invalid_type("object", &p.value));
            return Ok(p);
        }
        let input = std::mem::replace(&mut p.value, Value::Undefined);
        let mut out: Vec<(String, Value)> = Vec::new();
        for (k, id) in shape {
            if k == "__proto__" {
                continue;
            }
            let (optin, optout) = self.optin(*id, 0);
            let present = input.has(k);
            let r = self.run(*id, Payload::of(input.get(k).clone()), refiner, d)?;
            let seg = Json::str(k.clone());
            let had_issues = !r.issues.is_empty();
            match (optin, optout) {
                (Optin::Optional | Optin::Defaulted, true) => {
                    if !had_issues || present {
                        p.issues.extend(prefix(r.issues, &seg));
                        let assign = if optin == Optin::Optional {
                            present
                        } else {
                            r.value != Value::Undefined || present
                        };
                        if assign {
                            out.push((k.clone(), r.value));
                        }
                    }
                }
                (Optin::None, _) => {
                    p.issues.extend(prefix(r.issues, &seg));
                    if !present && !had_issues {
                        p.issues.push(
                            Issue::new(
                                vec![
                                    ("code", Json::str("invalid_type")),
                                    ("expected", Json::str("nonoptional")),
                                ],
                                "Invalid input: expected nonoptional, received undefined"
                                    .to_owned(),
                                Cont::Unset,
                            )
                            .at(vec![seg.clone()]),
                        );
                    }
                    if present {
                        out.push((k.clone(), r.value));
                    }
                }
                (_, false) => {
                    p.issues.extend(prefix(r.issues, &seg));
                    if optin == Optin::Defaulted || r.value != Value::Undefined || present {
                        out.push((k.clone(), r.value));
                    }
                }
            }
        }
        if catchall != Catchall::Strip
            && let Value::Object(fields) = &input
        {
            let mut unrecognized = Vec::new();
            for (k, v) in fields {
                if shape.iter().any(|(s, _)| s == k) {
                    continue;
                }
                if catchall == Catchall::Strict {
                    unrecognized.push(Json::str(k.clone()));
                    continue;
                }
                if k == "__proto__" {
                    continue;
                }
                out.push((k.clone(), v.clone()));
            }
            if !unrecognized.is_empty() {
                let plural = if unrecognized.len() > 1 { "s" } else { "" };
                let names: Vec<String> = unrecognized.iter().map(primitive).collect();
                p.issues.push(Issue::new(
                    vec![
                        ("code", Json::str("unrecognized_keys")),
                        ("keys", Json::Array(unrecognized)),
                    ],
                    format!("Unrecognized key{plural}: {}", names.join(", ")),
                    Cont::Yes,
                ));
            }
        }
        p.value = Value::Object(out);
        Ok(p)
    }

    fn record(
        &self,
        key: usize,
        value: usize,
        mut p: Payload,
        refiner: &dyn Refiner,
        d: u32,
    ) -> Result<Payload, Thrown> {
        let Value::Object(fields) = &p.value else {
            p.issues.push(Self::invalid_type("record", &p.value));
            return Ok(p);
        };
        let fields = fields.clone();
        let mut out: Vec<(String, Value)> = Vec::new();
        let invalid_key = |k: &str, issues: &[Issue]| {
            Issue::new(
                vec![
                    ("code", Json::str("invalid_key")),
                    ("origin", Json::str("record")),
                    ("issues", issues_json(issues)),
                ],
                "Invalid key in record".to_owned(),
                Cont::Unset,
            )
            .at(vec![Json::str(k)])
        };
        if let Some(values) = self.admitted(key, 0) {
            let declared: Vec<String> = values
                .iter()
                .filter_map(|v| match v {
                    Some(Json::String(s)) => Some(s.clone()),
                    Some(Json::Number(n)) => Some(json::js_number_string(*n)),
                    _ => None,
                })
                .collect();
            for k in &declared {
                if k == "__proto__" {
                    continue;
                }
                let kr = self.run(key, Payload::of(Value::String(k.clone())), refiner, d)?;
                if !kr.issues.is_empty() {
                    p.issues.push(invalid_key(k, &kr.issues));
                    continue;
                }
                let out_key = kr.value.js_string();
                let r = self.run(value, Payload::of(p.value.get(k).clone()), refiner, d)?;
                p.issues.extend(prefix(r.issues, &Json::str(k.clone())));
                out.push((out_key, r.value));
            }
            let unrecognized: Vec<Json> = fields
                .iter()
                .filter(|(k, _)| !declared.contains(k))
                .map(|(k, _)| Json::str(k.clone()))
                .collect();
            if !unrecognized.is_empty() {
                let plural = if unrecognized.len() > 1 { "s" } else { "" };
                let names: Vec<String> = unrecognized.iter().map(primitive).collect();
                p.issues.push(Issue::new(
                    vec![
                        ("code", Json::str("unrecognized_keys")),
                        ("keys", Json::Array(unrecognized)),
                    ],
                    format!("Unrecognized key{plural}: {}", names.join(", ")),
                    Cont::Yes,
                ));
            }
        } else {
            for (k, v) in fields {
                if k == "__proto__" {
                    continue;
                }
                let mut kr = self.run(key, Payload::of(Value::String(k.clone())), refiner, d)?;
                if !kr.issues.is_empty()
                    && Regex::new(r"/^-?\d+(?:\.\d+)?$/").is_ok_and(|re| re.test(&k))
                    && let Ok(n) = k.parse::<f64>()
                {
                    let retry = self.run(key, Payload::of(Value::Number(n)), refiner, d)?;
                    if retry.issues.is_empty() {
                        kr = retry;
                    }
                }
                if !kr.issues.is_empty() {
                    p.issues.push(invalid_key(&k, &kr.issues));
                    continue;
                }
                let out_key = kr.value.js_string();
                if out_key == "__proto__" {
                    continue;
                }
                let r = self.run(value, Payload::of(v), refiner, d)?;
                p.issues.extend(prefix(r.issues, &Json::str(k.clone())));
                out.push((out_key, r.value));
            }
        }
        p.value = Value::Object(out);
        Ok(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoRefines;
    impl Refiner for NoRefines {
        fn refine(&self, _: &str, _: &Value) -> Result<bool, String> {
            Ok(true)
        }
    }

    fn schema(nodes: &str) -> Schema {
        let doc = json::parse(&format!("{{\"nodes\":{nodes}}}"))
            .unwrap_or_else(|e| panic!("{}", e.message));
        Schema::from_json(&doc).unwrap_or_else(|e| panic!("{e}"))
    }

    fn verdict(s: &Schema, input: &str) -> String {
        let v = Value::from_json(&json::parse(input).unwrap_or_else(|e| panic!("{}", e.message)));
        match s
            .parse(0, v, &NoRefines)
            .unwrap_or_else(|e| panic!("{}", e.0))
        {
            Outcome::Ok(v) => v.to_json().map_or("undefined".to_owned(), |j| j.compact()),
            Outcome::Issues(i) => issues_json(&i).compact(),
        }
    }

    #[test]
    fn reports_as_zod_does() {
        // Each expected line is zod 4.6.7's own answer (node, `safeParse`).
        let s = schema(
            r#"[{"t":"object","shape":[["a","1"]]},{"t":"string","checks":[{"k":"min_length","n":2}]}]"#
                .replace("\"1\"", "1")
                .as_str(),
        );
        assert_eq!(
            verdict(&s, r#"{"a":[]}"#),
            r#"[{"expected":"string","code":"invalid_type","path":["a"],"message":"Invalid input: expected string, received array"},{"origin":"array","code":"too_small","minimum":2,"inclusive":true,"path":["a"],"message":"Too small: expected array to have >=2 items"}]"#
        );
        let s = schema(r#"[{"t":"object","shape":[["a",1]],"catchall":"strict"},{"t":"string"}]"#);
        assert_eq!(
            verdict(&s, r#"{"a":1,"2":1,"b":2}"#),
            r#"[{"expected":"string","code":"invalid_type","path":["a"],"message":"Invalid input: expected string, received number"},{"code":"unrecognized_keys","keys":["2","b"],"path":[],"message":"Unrecognized keys: \"2\", \"b\""}]"#
        );
        let s = schema(
            r#"[{"t":"array","el":1,"checks":[{"k":"min_length","n":1},{"k":"max_length","n":2}]},{"t":"string"}]"#,
        );
        assert_eq!(
            verdict(&s, "[1,2,3]"),
            r#"[{"origin":"array","code":"too_big","maximum":2,"inclusive":true,"path":[],"message":"Too big: expected array to have <=2 items"}]"#
        );
        let s = schema(r#"[{"t":"number"}]"#);
        assert_eq!(
            verdict(&s, "1e400"),
            r#"[{"expected":"number","code":"invalid_type","received":"Infinity","path":[],"message":"Invalid input: expected number, received Infinity"}]"#
        );
        let s = schema(r#"[{"t":"date","coerce":true}]"#);
        assert_eq!(
            verdict(&s, "\"2020-01-01\""),
            "\"2020-01-01T00:00:00.000Z\""
        );
        assert_eq!(
            verdict(&s, "{}"),
            r#"[{"expected":"date","code":"invalid_type","received":"Invalid Date","path":[],"message":"Invalid input: expected date, received Date"}]"#
        );
    }

    /// `z.string({ error: (i) => (i.input === undefined ? undefined : 'M') })`, as zod 4 answers it.
    #[test]
    fn a_string_with_its_own_error_names_it_for_any_input_but_an_absent_one() {
        let s = schema(
            r#"[{"t":"object","shape":[["a",1],["b",2]]},{"t":"nullable","in":2},{"t":"string","definedMsg":"M"}]"#,
        );
        assert_eq!(
            verdict(&s, r#"{"a":7}"#),
            r#"[{"expected":"string","code":"invalid_type","path":["a"],"message":"M"},{"expected":"string","code":"invalid_type","path":["b"],"message":"Invalid input: expected string, received undefined"}]"#
        );
        assert!(
            Schema::from_json(
                &json::parse(r#"{"nodes":[{"t":"number","definedMsg":"M"}]}"#)
                    .unwrap_or(Json::Null)
            )
            .is_err()
        );
    }
}
