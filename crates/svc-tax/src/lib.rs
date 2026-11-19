//! svc-tax in Rust. It builds and serves nothing yet: `services/svc-tax` (TypeScript) is the running service, and
//! its calls move here one at a time, each behind a replay of the recorded calls that must pass on both.

/// The service this crate becomes.
pub const SERVICE: &str = "svc-tax";

#[cfg(test)]
mod tests {
    use super::SERVICE;

    #[test]
    fn names_the_service_it_replaces() {
        assert_eq!(SERVICE, "svc-tax");
    }
}
