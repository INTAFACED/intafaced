//! The learner slice's own logic: the learner path, enrolment and purchases (`services/svc-academy/src/{purchases,
//! learning}/`, `curriculum/course-{preview,learners,enrolment}.ts` and their parts of `academy-service.ts` and
//! `router.ts`). `slices/learner.rs` routes each call here.

pub mod planner;
pub mod preview;
pub mod purchases;
pub mod sql;
pub mod store;
pub mod video;
