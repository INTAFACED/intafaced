//! Prometheus metrics (`@intafaced/telemetry` `metrics.ts`): the request counter and latency histogram every service
//! emits under the same names, labels and buckets, rendered as text exposition 0.0.4 byte for byte as `Metrics.render`
//! writes it, and the plain gauges a service appends on each scrape (`registerMetrics`' `gauges`).
//!
//! A door turns it on through [`crate::server::Door::metrics`]: the server then serves `GET /metrics` and observes every
//! reply it sends, 404s and `/metrics` itself included, under `module="_local"` and `outcome="none"` (Fastify's
//! `onResponse` hook in a service's `metrics.ts`). Per process on purpose: Prometheus scrapes each replica.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::json::js_number_string;

/// `PROMETHEUS_CONTENT_TYPE`.
pub const PROMETHEUS_CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";
/// `REQUESTS_TOTAL`.
pub const REQUESTS_TOTAL: &str = "intafaced_http_requests_total";
/// `REQUEST_DURATION_SECONDS`.
pub const REQUEST_DURATION_SECONDS: &str = "intafaced_http_request_duration_seconds";
/// `DURATION_BUCKETS`, in seconds.
pub const DURATION_BUCKETS: [f64; 11] = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];
/// `METRICS_PATH`: where a service serves the exposition. The scrape config must agree.
pub const METRICS_PATH: &str = "/metrics";
/// `MODULE_LOCAL`: a request the service answered itself.
pub const MODULE_LOCAL: &str = "_local";
/// `MODULE_UNROUTED`: a path that matched no upstream.
pub const MODULE_UNROUTED: &str = "_unrouted";
/// `MODULE_OVERFLOW`: every label of the one series past the cap.
pub const MODULE_OVERFLOW: &str = "_overflow";
/// `new Metrics()`'s cap on distinct label sets.
pub const DEFAULT_MAX_SERIES: usize = 2_000;
/// `EMITTED_LABEL_NAMES`: the labels the exposition owns, which a scrape config must never set.
pub const EMITTED_LABEL_NAMES: [&str; 5] = ["service", "module", "method", "status", "outcome"];
/// `METRIC_FAMILIES`: every family name the registry can emit.
pub const METRIC_FAMILIES: [&str; 4] = [
    REQUESTS_TOTAL,
    "intafaced_http_request_duration_seconds_bucket",
    "intafaced_http_request_duration_seconds_sum",
    "intafaced_http_request_duration_seconds_count",
];

const KNOWN_METHODS: [&str; 7] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/// `HttpRequestLabels`: every field from a finite set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Labels {
    pub service: String,
    pub module: String,
    pub method: String,
    pub status: String,
    pub outcome: String,
}

impl Labels {
    fn key(&self) -> String {
        [
            self.service.as_str(),
            &self.module,
            &self.method,
            &self.status,
            &self.outcome,
        ]
        .join("\u{0}")
    }

    fn overflow() -> Labels {
        Labels {
            service: MODULE_OVERFLOW.to_owned(),
            module: MODULE_OVERFLOW.to_owned(),
            method: MODULE_OVERFLOW.to_owned(),
            status: MODULE_OVERFLOW.to_owned(),
            outcome: MODULE_OVERFLOW.to_owned(),
        }
    }
}

/// `statusClass`: `2xx` .. `5xx`; anything outside 100..600 is `5xx`, 1xx counts as `2xx`.
pub fn status_class(status: u16) -> &'static str {
    match status {
        0..100 | 500.. => "5xx",
        400.. => "4xx",
        300.. => "3xx",
        _ => "2xx",
    }
}

/// `methodLabel`: the method upper-cased when it is a known one, else `_other`.
pub fn method_label(method: &str) -> String {
    let upper = method.to_uppercase();
    if KNOWN_METHODS.contains(&upper.as_str()) {
        upper
    } else {
        "_other".to_owned()
    }
}

/// A label value escapes the backslash, the line feed and the double quote, nothing else.
fn escape_label_value(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('"', "\\\"")
}

fn render_labels(l: &Labels, le: Option<&str>) -> String {
    let mut pairs = vec![
        format!("service=\"{}\"", escape_label_value(&l.service)),
        format!("module=\"{}\"", escape_label_value(&l.module)),
        format!("method=\"{}\"", escape_label_value(&l.method)),
        format!("status=\"{}\"", escape_label_value(&l.status)),
        format!("outcome=\"{}\"", escape_label_value(&l.outcome)),
    ];
    if let Some(le) = le {
        pairs.push(format!("le=\"{}\"", escape_label_value(le)));
    }
    format!("{{{}}}", pairs.join(","))
}

/// `sample`: `String(n)`.
fn sample(value: f64) -> String {
    js_number_string(value)
}

fn count(n: u64) -> String {
    n.to_string()
}

struct Series {
    labels: Labels,
    count: u64,
    /// A JavaScript number in the TypeScript: summed as an `f64` so the rendered sum is the same bytes.
    sum: f64,
    buckets: [u64; DURATION_BUCKETS.len()],
}

#[derive(Default)]
struct Book {
    /// Insertion order, as a JavaScript `Map` renders.
    order: Vec<Series>,
    /// `labelKey`: the five values joined with NUL, so two label sets whose joined values meet are one series, as in
    /// the TypeScript.
    index: HashMap<String, usize>,
}

/// `Metrics`: one process's registry.
pub struct Metrics {
    max_series: usize,
    book: Mutex<Book>,
}

impl Default for Metrics {
    fn default() -> Metrics {
        Metrics::new(DEFAULT_MAX_SERIES)
    }
}

impl Metrics {
    /// `new Metrics(maxSeries)`.
    pub fn new(max_series: usize) -> Metrics {
        Metrics {
            max_series,
            book: Mutex::new(Book::default()),
        }
    }

    /// `observe`: one finished request. A new label set past the cap folds into the one overflow series; a negative
    /// or non-finite duration counts as zero.
    #[expect(
        clippy::float_arithmetic,
        reason = "a latency sum, summed as the TypeScript's JavaScript number is; not money"
    )]
    pub fn observe(&self, labels: &Labels, seconds: f64) {
        let mut book = self
            .book
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut stored = labels.clone();
        let mut key = stored.key();
        if !book.index.contains_key(&key) && book.index.len() >= self.max_series {
            stored = Labels::overflow();
            key = stored.key();
        }
        let at = match book.index.get(&key) {
            Some(&at) => at,
            None => {
                let at = book.order.len();
                book.order.push(Series {
                    labels: stored,
                    count: 0,
                    sum: 0.0,
                    buckets: [0; DURATION_BUCKETS.len()],
                });
                book.index.insert(key, at);
                at
            }
        };
        let seconds = if seconds.is_finite() && seconds > 0.0 {
            seconds
        } else {
            0.0
        };
        let Some(s) = book.order.get_mut(at) else {
            return;
        };
        s.count += 1;
        s.sum += seconds;
        for (n, bound) in s.buckets.iter_mut().zip(DURATION_BUCKETS) {
            if seconds <= bound {
                *n += 1;
            }
        }
    }

    /// `size`: distinct series held.
    pub fn size(&self) -> usize {
        self.book
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .order
            .len()
    }

    /// `render`: both families, even empty, and the trailing newline the parser requires.
    pub fn render(&self) -> String {
        let book = self
            .book
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut lines = vec![
            format!(
                "# HELP {REQUESTS_TOTAL} Requests answered, by service, module, method, status class and auth outcome."
            ),
            format!("# TYPE {REQUESTS_TOTAL} counter"),
        ];
        for s in &book.order {
            lines.push(format!(
                "{REQUESTS_TOTAL}{} {}",
                render_labels(&s.labels, None),
                count(s.count)
            ));
        }
        lines.push(format!(
            "# HELP {REQUEST_DURATION_SECONDS} Request latency in seconds, measured where the promise to the caller was made."
        ));
        lines.push(format!("# TYPE {REQUEST_DURATION_SECONDS} histogram"));
        for s in &book.order {
            for (n, bound) in s.buckets.iter().zip(DURATION_BUCKETS) {
                lines.push(format!(
                    "{REQUEST_DURATION_SECONDS}_bucket{} {}",
                    render_labels(&s.labels, Some(&js_number_string(bound))),
                    count(*n)
                ));
            }
            lines.push(format!(
                "{REQUEST_DURATION_SECONDS}_bucket{} {}",
                render_labels(&s.labels, Some("+Inf")),
                count(s.count)
            ));
            lines.push(format!(
                "{REQUEST_DURATION_SECONDS}_sum{} {}",
                render_labels(&s.labels, None),
                sample(s.sum)
            ));
            lines.push(format!(
                "{REQUEST_DURATION_SECONDS}_count{} {}",
                render_labels(&s.labels, None),
                count(s.count)
            ));
        }
        format!("{}\n", lines.join("\n"))
    }
}

/// `GaugeSample`: one gauge; `value` is exposition text, so a big integer never passes through a float.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GaugeSample {
    pub name: String,
    pub help: String,
    pub value: String,
}

/// `renderGauges`: each gauge's HELP (written as given), TYPE and one sample under `service`, with the service's
/// backslashes, quotes and line feeds dropped.
pub fn render_gauges(samples: &[GaugeSample], service: &str) -> String {
    let service: String = service
        .chars()
        .filter(|c| !matches!(c, '\\' | '"' | '\n'))
        .collect();
    let mut out = String::new();
    for g in samples {
        out.push_str(&format!("# HELP {} {}\n", g.name, g.help));
        out.push_str(&format!("# TYPE {} gauge\n", g.name));
        out.push_str(&format!(
            "{}{{service=\"{service}\"}} {}\n",
            g.name, g.value
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_and_methods_are_bounded() {
        assert_eq!(status_class(0), "5xx");
        assert_eq!(status_class(99), "5xx");
        assert_eq!(status_class(100), "2xx");
        assert_eq!(status_class(204), "2xx");
        assert_eq!(status_class(301), "3xx");
        assert_eq!(status_class(404), "4xx");
        assert_eq!(status_class(503), "5xx");
        assert_eq!(status_class(600), "5xx");
        assert_eq!(method_label("get"), "GET");
        assert_eq!(method_label("PROPFIND"), "_other");
        assert_eq!(method_label(""), "_other");
    }

    #[test]
    fn an_empty_registry_declares_both_families() {
        let text = Metrics::default().render();
        assert!(text.ends_with('\n'));
        assert!(text.contains("# TYPE intafaced_http_requests_total counter\n"));
        assert!(text.contains("# TYPE intafaced_http_request_duration_seconds histogram\n"));
    }
}
