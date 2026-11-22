//! The `own-controls` slice (`README.md`): what a person sets around their own agent (`own/routes.ts`, limits, usage,
//! analytics, the payment method, policy, privacy, memory and consents; `own/usage-limits-routes.ts`), answered as the
//! TypeScript answers them.
//!
//! - [`limits`]: the caps per call, per session and per month.
//! - [`usage_limits`]: the soft alert and the monthly hard limit.
//! - [`payment`]: the wallet chosen to pay for runs (the run's reading of it is `crate::runtime::funds`).
//! - [`policy`]: the allow and deny rules by action and account, and the gate svc-trade asks.
//! - [`memory`]: what the agent remembers, and what is kept and for how long.
//! - [`consents`]: the person's consent to each class of tools.
//! - [`slice`]: the calls, with the usage windows, the usage by day and the analytics.

pub mod consents;
pub mod limits;
pub mod memory;
pub mod payment;
pub mod policy;
pub mod slice;
pub mod usage_limits;
