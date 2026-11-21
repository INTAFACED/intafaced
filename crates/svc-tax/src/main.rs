//! The svc-tax process: `svc-tax` serves; `svc-tax migrate [--down]` applies (or reverses) the tax schema's migrations.

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use svc_tax::env;
use svc_tax::http::{Fetch, UreqFetch};
use svc_tax::json::Json;
use svc_tax::server::{self, App};
use svc_tax::service;
use svc_tax::stores::migrate;
use svc_tax::telemetry::{Logger, Telemetry};

fn process_env() -> BTreeMap<String, String> {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("migrate") {
        let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| migrate::DEFAULT_URL.to_owned());
        let down = args.iter().any(|a| a == "--down");
        return match migrate::run(&url, down, &mut std::io::stdout()) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        };
    }
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let env = env::load(&process_env()).map_err(|e| e.message)?;
    let log = Logger::stdout(&env.log_level);
    let fetch: Arc<dyn Fetch> = Arc::new(UreqFetch::new());
    let telemetry = Telemetry::start(
        env.otel_enabled,
        &env.service_name,
        &env.otel_endpoint,
        &env.app_env,
        fetch.clone(),
        log.clone(),
    );
    let booted =
        service::ports(&env, &fetch).and_then(|ports| Ok((service::wire(&env, &ports)?, ports)));
    let (wire, ports) = match booted {
        Ok(b) => b,
        Err(e) => {
            telemetry.shutdown();
            return Err(e);
        }
    };
    let app = App {
        wire,
        service_name: env.service_name.clone(),
        ready_body: svc_tax::ready::ready(&env.tax_jurisdiction_map_json).compact(),
    };
    let port = u16::try_from(env.http_port).map_err(|_| {
        format!(
            "options.port should be >= 0 and < 65536. Received {}.",
            env.http_port
        )
    })?;
    let server =
        tiny_http::Server::http((env.http_host.as_str(), port)).map_err(|e| e.to_string())?;
    log.info(vec![("port", Json::int(i64::from(port)))], "svc-tax ready");

    let stop = Arc::new(AtomicBool::new(false));
    for signal in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(signal, stop.clone()).map_err(|e| e.to_string())?;
    }
    server::serve(&server, &app, &log, &telemetry, &stop);
    drop(server);
    if let Some(pool) = &ports.pool {
        pool.end();
    }
    telemetry.shutdown();
    log.info(Vec::new(), "svc-tax stopped");
    Ok(())
}
