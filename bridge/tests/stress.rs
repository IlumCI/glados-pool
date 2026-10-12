//! Abuse, not use: what the bridge does when a client or the pool behaves badly.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use glados_bridge::{Config, serve};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const ORIGIN: &str = "https://pool.example.org";

async fn pool_echo() -> SocketAddr {
    // A pool that accepts and answers each line with a fixed job, then idles.
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a = l.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = l.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                while let Ok(n) = s.read(&mut buf).await {
                    if n == 0 || s.write_all(b"{\"method\":\"glados.job\",\"params\":{}}\n").await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    a
}

async fn bridge(cfg: Config) -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a = l.local_addr().unwrap();
    tokio::spawn(serve(l, cfg));
    a
}

fn cfg(pool: SocketAddr) -> Config {
    Config { pool: pool.to_string(), origins: vec![ORIGIN.into()], ..Config::default() }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

async fn open(addr: SocketAddr) -> Result<Ws, String> {
    let mut req = format!("ws://{addr}/").into_client_request().unwrap();
    req.headers_mut().insert("origin", ORIGIN.parse().unwrap());
    tokio_tungstenite::connect_async(req).await.map(|(w, _)| w).map_err(|e| e.to_string())
}

/// The close frame's reason, if the bridge sent one before the socket ended.
async fn close_reason(ws: &mut Ws) -> Option<String> {
    loop {
        match timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Close(Some(f))))) => return Some(f.reason.to_string()),
            Ok(Some(Ok(Message::Close(None)))) | Ok(None) | Ok(Some(Err(_))) | Err(_) => return None,
            Ok(Some(Ok(_))) => continue,
        }
    }
}

#[tokio::test]
async fn a_ping_flood_is_cut_off_like_any_other_flood() {
    let b = bridge(Config { rate: 5.0, burst: 10.0, ..cfg(pool_echo().await) }).await;
    let mut ws = open(b).await.unwrap();
    let t = Instant::now();
    let mut sent = 0;
    while t.elapsed() < Duration::from_secs(3) {
        if ws.send(Message::Ping(vec![0u8; 100].into())).await.is_err() {
            break;
        }
        sent += 1;
        if sent > 5000 {
            break;
        }
    }
    // Draining what came back: a bridge that answers every ping is still open.
    let cut = timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return true,
                _ => {}
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(cut, "{sent} pings sent and the connection is still open");
}

#[tokio::test]
async fn a_dead_pool_is_named_in_the_close_frame() {
    let dead: SocketAddr = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap() // dropped: nothing listens here now
    };
    let b = bridge(cfg(dead)).await;
    let mut ws = open(b).await.unwrap();
    let why = close_reason(&mut ws).await;
    assert!(why.as_deref().is_some_and(|w| w.contains("pool")), "close reason was {why:?}");
}

#[tokio::test]
async fn sockets_that_never_handshake_are_bounded() {
    let b = bridge(Config { max_conns: 16, ..cfg(pool_echo().await) }).await;
    // Many raw TCP connections that send nothing: each holds a task and a
    // descriptor until the handshake timeout, unless something bounds them.
    let mut idle = Vec::new();
    for _ in 0..200 {
        if let Ok(s) = TcpStream::connect(b).await {
            idle.push(s);
        }
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    // How many of them the bridge closed rather than held.
    let mut closed = 0;
    for s in idle.iter_mut() {
        let mut one = [0u8; 1];
        if let Ok(Ok(0)) = timeout(Duration::from_millis(20), s.read(&mut one)).await {
            closed += 1;
        }
    }
    assert!(closed >= 150, "only {closed} of 200 idle pre-handshake sockets were refused");
}

#[tokio::test]
async fn the_total_cap_holds_across_addresses() {
    let b = bridge(Config { max_conns: 5, max_per_ip: 100, ..cfg(pool_echo().await) }).await;
    let mut held = Vec::new();
    for _ in 0..5 {
        held.push(open(b).await.unwrap());
    }
    let mut sixth = open(b).await.unwrap();
    let why = close_reason(&mut sixth).await;
    assert!(why.as_deref().is_some_and(|w| w.contains("full")), "sixth got {why:?}");
}

#[tokio::test]
async fn a_slow_handshake_is_dropped_on_time() {
    let b = bridge(cfg(pool_echo().await)).await;
    let mut s = TcpStream::connect(b).await.unwrap();
    // A byte at a time, never finishing: the handshake deadline must win.
    let t = Instant::now();
    let r = timeout(Duration::from_secs(20), async {
        for byte in b"GET / HTTP/1.1\r\nHost: x\r\n".iter().cycle() {
            if s.write_all(&[*byte]).await.is_err() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await;
    assert!(r.is_ok(), "the bridge still held a trickling handshake after 20 s");
    assert!(t.elapsed() < Duration::from_secs(15), "dropped only after {:?}", t.elapsed());
}
