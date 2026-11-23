//! The curriculum: the embedded spine and the catalogue the curriculum calls serve over it, the import bar, the
//! deep-links, locale fallback and coach spine, the signed-out catalogue, the reads an item passes before its body is
//! served, and the coach's S2S door. `slices::curriculum` answers the calls; other slices look the spine up through
//! [`spine`] and reuse [`gates`] and [`links`].

pub mod gates;
pub mod internal;
pub mod links;
pub mod spine;
pub mod substance;
