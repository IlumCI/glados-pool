//! `glados-bridge --pool 127.0.0.1:3334 --listen 127.0.0.1:8080 --origin https://...`

use std::time::Duration;

use glados_bridge::{Config, serve};

const USAGE: &str = "usage: glados-bridge --origin URL [--origin URL ...] [--listen ADDR] [--pool ADDR]
                    [--trust-proxy] [--max-conns N] [--max-per-ip N] [--rate F] [--burst F] [--idle SECS]";

fn main() {
    let mut cfg = Config::default();
    let mut listen = String::from("127.0.0.1:8080");
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = || args.next().unwrap_or_else(|| die(&format!("{a} wants a value")));
        match a.as_str() {
            "--listen" => listen = val(),
            "--pool" => cfg.pool = val(),
            "--origin" => cfg.origins.push(val()),
            "--trust-proxy" => cfg.trust_proxy = true,
            "--max-conns" => cfg.max_conns = num(&val()),
            "--max-per-ip" => cfg.max_per_ip = num(&val()),
            "--rate" => cfg.rate = num(&val()),
            "--burst" => cfg.burst = num(&val()),
            "--idle" => cfg.idle = Duration::from_secs(num(&val())),
            "-h" | "--help" => {
                println!("{USAGE}");
                return;
            }
            _ => die(&format!("unknown argument {a}")),
        }
    }
    // Refused rather than defaulted to "allow all": an open bridge is one any
    // site can point its visitors' browsers at without asking them.
    if cfg.origins.is_empty() {
        die("at least one --origin is required");
    }
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    rt.block_on(async {
        let l = tokio::net::TcpListener::bind(&listen).await.unwrap_or_else(|e| die(&format!("bind {listen}: {e}")));
        eprintln!("[bridge] listening on {listen}, pool {}, {} origin(s)", cfg.pool, cfg.origins.len());
        if let Err(e) = serve(l, cfg).await {
            die(&format!("accept: {e}"));
        }
    });
}

fn num<T: std::str::FromStr>(s: &str) -> T {
    s.parse().unwrap_or_else(|_| die(&format!("not a number: {s}")))
}

fn die(msg: &str) -> ! {
    eprintln!("glados-bridge: {msg}\n{USAGE}");
    std::process::exit(2)
}
