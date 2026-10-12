//! The bridge against a fake pool, end to end over real sockets.
//!
//! The fake pool speaks just enough of the protocol to answer a hello, push a
//! job and acknowledge a submit -- and it records every line it received, so
//! the claims are about what actually crossed the bridge rather than about
//! what the bridge meant to send.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use glados_bridge::{Config, client_ip, frame_ok, origin_ok, serve};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const ORIGIN: &str = "https://pool.example.org";

async fn fake_pool() -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let (s, _) = l.accept().await.unwrap();
            let log = log.clone();
            tokio::spawn(async move {
                let (r, mut w) = s.into_split();
                let mut lines = BufReader::new(r).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log.lock().unwrap().push(line.clone());
                    if line.contains("glados.hello") {
                        w.write_all(b"{\"id\":1,\"result\":{\"v\":1,\"slots\":2,\"session\":\"s\"},\"error\":null}\n").await.unwrap();
                        w.write_all(b"{\"method\":\"glados.job\",\"params\":{\"slot\":1,\"job\":\"a3f1\"}}\n").await.unwrap();
                    } else if line.contains("glados.submit") {
                        w.write_all(b"{\"id\":7,\"result\":{\"ok\":true},\"error\":null}\n").await.unwrap();
                    }
                }
            });
        }
    });
    (addr, seen)
}

async fn bridge(cfg: Config) -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(serve(l, cfg));
    addr
}

fn cfg(pool: SocketAddr) -> Config {
    Config { pool: pool.to_string(), origins: vec![ORIGIN.into()], ..Config::default() }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn open(addr: SocketAddr, origin: Option<&str>) -> Result<Ws, String> {
    let mut req = format!("ws://{addr}/").into_client_request().unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws).map_err(|e| e.to_string())
}

async fn next_text(ws: &mut Ws) -> Option<String> {
    match timeout(Duration::from_secs(5), ws.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => Some(t.to_string()),
        _ => None,
    }
}

/// Whether the bridge has closed this connection, within a deadline.
async fn closed(ws: &mut Ws) -> bool {
    loop {
        match timeout(Duration::from_secs(5), ws.next()).await {
            Err(_) => return false,
            Ok(None) | Ok(Some(Err(_))) | Ok(Some(Ok(Message::Close(_)))) => return true,
            Ok(Some(Ok(_))) => continue,
        }
    }
}

#[tokio::test]
async fn a_session_crosses_the_bridge_both_ways() {
    let (pool, seen) = fake_pool().await;
    let b = bridge(cfg(pool)).await;
    let mut ws = open(b, Some(ORIGIN)).await.unwrap();

    let hello = r#"{"id":1,"method":"glados.hello","params":{"v":1,"worker":"0xabc","agent":"web/0.1"}}"#;
    ws.send(Message::text(hello)).await.unwrap();
    assert!(next_text(&mut ws).await.unwrap().contains("\"session\""));
    assert!(next_text(&mut ws).await.unwrap().contains("glados.job"));

    let submit = r#"{"id":7,"method":"glados.submit","params":{"job":"a3f1","nonce":"1f8c04b2","echo":{}}}"#;
    ws.send(Message::text(submit)).await.unwrap();
    assert!(next_text(&mut ws).await.unwrap().contains("\"ok\":true"));

    // Byte for byte what was sent, one frame to one line, nothing added.
    let got = seen.lock().unwrap().clone();
    assert_eq!(got, vec![hello.to_string(), submit.to_string()]);
}

#[tokio::test]
async fn a_foreign_origin_never_reaches_the_pool() {
    let (pool, seen) = fake_pool().await;
    let b = bridge(cfg(pool)).await;
    assert!(open(b, Some("https://evil.example.net")).await.is_err());
    assert!(open(b, Some("https://pool.example.org.evil.net")).await.is_err());
    assert!(open(b, None).await.is_err());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_frame_carrying_a_second_line_is_refused_not_split() {
    let (pool, seen) = fake_pool().await;
    let b = bridge(cfg(pool)).await;
    let mut ws = open(b, Some(ORIGIN)).await.unwrap();
    ws.send(Message::text("{\"id\":1}\n{\"id\":2,\"method\":\"glados.submit\"}")).await.unwrap();
    assert!(closed(&mut ws).await);
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn binary_and_oversized_frames_end_the_connection() {
    let (pool, _) = fake_pool().await;
    let b = bridge(cfg(pool)).await;

    let mut ws = open(b, Some(ORIGIN)).await.unwrap();
    ws.send(Message::binary(vec![1, 2, 3])).await.unwrap();
    assert!(closed(&mut ws).await);

    let mut ws = open(b, Some(ORIGIN)).await.unwrap();
    let big = format!("{{\"x\":\"{}\"}}", "a".repeat(glados_bridge::MAX_LINE));
    let _ = ws.send(Message::text(big)).await;
    assert!(closed(&mut ws).await);
}

#[tokio::test]
async fn the_per_address_cap_holds_and_frees_on_close() {
    let (pool, _) = fake_pool().await;
    let b = bridge(Config { max_per_ip: 2, ..cfg(pool) }).await;
    let a1 = open(b, Some(ORIGIN)).await.unwrap();
    let _a2 = open(b, Some(ORIGIN)).await.unwrap();
    let mut a3 = open(b, Some(ORIGIN)).await.unwrap();
    assert!(closed(&mut a3).await, "a third connection from one address was kept");

    drop(a1);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut a4 = open(b, Some(ORIGIN)).await.unwrap();
    let hello = r#"{"id":1,"method":"glados.hello","params":{}}"#;
    a4.send(Message::text(hello)).await.unwrap();
    assert!(next_text(&mut a4).await.is_some(), "the freed slot was not given back");
}

#[tokio::test]
async fn a_flood_is_cut_off_at_the_bucket() {
    let (pool, seen) = fake_pool().await;
    let b = bridge(Config { rate: 1.0, burst: 5.0, ..cfg(pool) }).await;
    let mut ws = open(b, Some(ORIGIN)).await.unwrap();
    for i in 0..50 {
        if ws.send(Message::text(format!("{{\"id\":{i}}}"))).await.is_err() {
            break;
        }
    }
    assert!(closed(&mut ws).await);
    let n = seen.lock().unwrap().len();
    assert!(n <= 6, "{n} frames got through a burst of 5");
}

#[test]
fn pure_rules() {
    let allowed = vec![ORIGIN.to_string()];
    assert!(origin_ok(Some(ORIGIN), &allowed));
    assert!(!origin_ok(Some("http://pool.example.org"), &allowed), "scheme is part of an origin");
    assert!(!origin_ok(Some("https://pool.example.org:444"), &allowed), "so is the port");
    assert!(!origin_ok(Some(ORIGIN), &[]), "an empty allowlist refuses everyone");

    assert!(frame_ok("{\"id\":1}"));
    assert!(!frame_ok(""));
    assert!(!frame_ok("{\"id\":1}\r"));
    assert!(!frame_ok("[1,2]"));

    let peer: SocketAddr = "127.0.0.1:5000".parse().unwrap();
    let ip = |x, t| client_ip(peer, x, t).to_string();
    assert_eq!(ip(Some("1.2.3.4"), false), "127.0.0.1", "an untrusted header is the client's own words");
    assert_eq!(ip(Some("6.6.6.6, 1.2.3.4"), true), "1.2.3.4", "the proxy appends; earlier entries are forged");
    assert_eq!(ip(Some("garbage"), true), "127.0.0.1");
}
