//! The svc-blueprint process. Until the switch (`PORT.md`) it only runs `svc-blueprint migrate [--down]`, which
//! applies (or reverses) the blueprint schema's migrations; serving is the switch's, and the TypeScript service serves.

use std::process::ExitCode;

use svc_blueprint::migrate;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = if args.first().map(String::as_str) == Some("migrate") {
        let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| migrate::DEFAULT_URL.to_owned());
        migrate::run(
            &url,
            args.iter().any(|a| a == "--down"),
            &mut std::io::stdout(),
        )
    } else {
        Err("svc-blueprint in Rust serves nothing yet: the TypeScript service serves until the switch (crates/svc-blueprint/PORT.md). Run `svc-blueprint migrate [--down]`.".to_owned())
    };
    match out {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
