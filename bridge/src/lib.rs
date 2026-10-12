//! WebSocket in, the pool's line-delimited JSON out.
//!
//! A browser cannot open a TCP socket, and the pool speaks newline-delimited
//! JSON over one. This is the whole of the translation: one WebSocket text
//! frame is one line, in both directions, and nothing in between is parsed
//! beyond what it takes to refuse a frame that would not be one line.
//!
//! **Why the bridge does not read the protocol.** The pool already parses every
//! message, bounds every rate that matters and refuses what it should. A second
//! parser here would be a second opinion about the same bytes, and the place two
//! readers disagree is where a share gets credited by one and refused by the
//! other. So the bridge is a pipe with limits on the pipe, and the limits are
//! about the pipe: frame size, frame rate, connection count, who may open one.
//!
//! **Origin is checked, and that is the anti-cryptojacking property.** Any page
//! on the web can open a WebSocket to any host; only the browser-sent `Origin`
//! says which page did. Without the check, a third-party site could embed a
//! miner pointed at this bridge and mine on its visitors' machines without
//! their consent, with this bridge as the accomplice. The allowlist is
//! required, not optional: an empty one refuses every browser.
//!
//! **The client address comes from the proxy only when told to trust it.** The
//! bridge sits behind a TLS terminator, so every peer looks like 127.0.0.1 and
//! a per-address cap would cap the whole internet at once. `X-Forwarded-For` is
//! honoured only with `trust_proxy`, because from anywhere else it is a header
//! the client wrote.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{Instant, timeout};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

/// The longest line accepted in either direction. A job is a few hundred bytes
/// and a submit under two hundred; anything near this is not a miner.
pub const MAX_LINE: usize = 8 * 1024;

#[derive(Clone, Debug)]
pub struct Config {
    pub pool: String,
    pub origins: Vec<String>,
    pub trust_proxy: bool,
    pub max_conns: usize,
    pub max_per_ip: usize,
    /// Frames per second a connection may send upstream, as a token bucket.
    pub rate: f64,
    pub burst: f64,
    /// A connection that has said nothing for this long is closed. The pool
    /// sends a job at least every thirty seconds, so a live miner is never idle
    /// in the downstream direction; this bounds a socket nobody is using.
    pub idle: Duration,
}

impl Default for Config {
    fn default() -> Config {
        Config {
            pool: "127.0.0.1:3334".into(),
            origins: Vec::new(),
            trust_proxy: false,
            max_conns: 1024,
            max_per_ip: 8,
            rate: 10.0,
            burst: 40.0,
            idle: Duration::from_secs(300),
        }
    }
}

/// Live connection counts, overall and per client address.
#[derive(Default)]
pub struct Counts {
    total: usize,
    per_ip: HashMap<IpAddr, usize>,
}

/// Holding one is holding a slot; dropping it gives the slot back on every path
/// out, the failing ones included.
pub struct Slot {
    counts: Arc<Mutex<Counts>>,
    ip: IpAddr,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut c = self.counts.lock().unwrap();
        c.total -= 1;
        if let Some(n) = c.per_ip.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                c.per_ip.remove(&self.ip);
            }
        }
    }
}

pub fn claim(counts: &Arc<Mutex<Counts>>, ip: IpAddr, cfg: &Config) -> Result<Slot, &'static str> {
    let mut c = counts.lock().unwrap();
    if c.total >= cfg.max_conns {
        return Err("bridge full");
    }
    let n = c.per_ip.entry(ip).or_insert(0);
    if *n >= cfg.max_per_ip {
        return Err("too many connections from this address");
    }
    *n += 1;
    c.total += 1;
    Ok(Slot { counts: counts.clone(), ip })
}

/// Whether an `Origin` header is one the operator allowed. Exact match on the
/// serialised origin, scheme and port included: a prefix or suffix rule is how
/// `https://glados.example.attacker.net` gets in.
pub fn origin_ok(origin: Option<&str>, allowed: &[String]) -> bool {
    match origin {
        Some(o) => allowed.iter().any(|a| a == o),
        None => false,
    }
}

/// The client's address: the proxy's word for it when trusted, the socket's
/// otherwise. The *last* `X-Forwarded-For` entry is the one the trusted proxy
/// appended; earlier ones are whatever the client sent.
pub fn client_ip(peer: SocketAddr, xff: Option<&str>, trust_proxy: bool) -> IpAddr {
    if trust_proxy
        && let Some(ip) = xff
            .and_then(|v| v.rsplit(',').next())
            .and_then(|s| s.trim().parse::<IpAddr>().ok())
    {
        return ip;
    }
    peer.ip()
}

/// Whether a downstream frame may become one upstream line. Refusing rather
/// than splitting a frame with a newline in it is the point: a newline would
/// let one frame inject a second message the bridge never counted.
pub fn frame_ok(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= MAX_LINE
        && !text.contains(['\n', '\r'])
        && text.trim_start().starts_with('{')
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

impl Bucket {
    fn take(&mut self, rate: f64, burst: f64) -> bool {
        let now = Instant::now();
        self.tokens = (self.tokens + now.duration_since(self.last).as_secs_f64() * rate).min(burst);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

pub async fn serve(listener: TcpListener, cfg: Config) -> std::io::Result<()> {
    let cfg = Arc::new(cfg);
    let counts = Arc::new(Mutex::new(Counts::default()));
    // Every socket in any state holds a permit, the ones still handshaking
    // included. Without it the connection cap is counted only after a
    // handshake, and a client opening sockets that never send a byte holds a
    // task and a descriptor apiece for the whole handshake timeout, unbounded.
    // Twice the connection cap leaves room for honest handshakes in flight.
    let sockets = Arc::new(tokio::sync::Semaphore::new(cfg.max_conns.saturating_mul(2).max(1)));
    loop {
        let (stream, peer) = listener.accept().await?;
        let Ok(permit) = sockets.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let cfg = cfg.clone();
        let counts = counts.clone();
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(e) = handle(stream, peer, cfg, counts).await {
                eprintln!("[bridge] {peer} closed: {e}");
            }
        });
    }
}

async fn handle(
    stream: TcpStream,
    peer: SocketAddr,
    cfg: Arc<Config>,
    counts: Arc<Mutex<Counts>>,
) -> Result<(), String> {
    stream.set_nodelay(true).ok();
    let mut origin = None;
    let mut xff = None;
    let allowed = cfg.origins.clone();
    // The error type is tungstenite's, fixed by `accept_hdr_async`'s signature.
    #[allow(clippy::result_large_err)]
    let callback = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let h = |k| req.headers().get(k).and_then(|v| v.to_str().ok()).map(String::from);
        origin = h("origin");
        xff = h("x-forwarded-for");
        if !origin_ok(origin.as_deref(), &allowed) {
            let mut r = ErrorResponse::new(Some("origin not allowed".into()));
            *r.status_mut() = StatusCode::FORBIDDEN;
            return Err(r);
        }
        Ok(resp)
    };
    // tungstenite's default read buffer is 128 KiB per connection, which at
    // the connection cap was ~150 MiB measured -- on a host the pool's own
    // sizing calls comfortable at 32 MB. Messages are capped at 8 KiB, so a
    // buffer of the same order loses nothing.
    let ws_cfg = WebSocketConfig::default()
        .max_message_size(Some(MAX_LINE))
        .max_frame_size(Some(MAX_LINE))
        .read_buffer_size(4096)
        .write_buffer_size(0)
        .max_write_buffer_size(64 * 1024);
    let ws = timeout(
        Duration::from_secs(10),
        tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(ws_cfg)),
    )
    .await
    .map_err(|_| "handshake timed out".to_string())?
    .map_err(|e| format!("handshake: {e}"))?;

    let ip = client_ip(peer, xff.as_deref(), cfg.trust_proxy);
    let (mut ws_tx, mut ws_rx) = ws.split();
    let _slot = match claim(&counts, ip, &cfg) {
        Ok(s) => s,
        Err(why) => {
            close_with(&mut ws_tx, CloseCode::Again, why).await;
            return Err(why.into());
        }
    };
    eprintln!("[bridge] {ip} open, origin {}", origin.as_deref().unwrap_or("-"));
    let r = relay(&mut ws_tx, &mut ws_rx, &cfg).await;
    // Every way out after the handshake says why in the close frame: a
    // browser sees only the frame, and "disconnected" with no reason is a
    // fault nobody can act on -- a dead pool reads exactly like a dead bridge.
    if let Err(why) = &r {
        let code = if why.starts_with("pool") { CloseCode::Again } else { CloseCode::Policy };
        close_with(&mut ws_tx, code, why).await;
    }
    r
}

type WsTx = futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<TcpStream>, Message>;
type WsRx = futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<TcpStream>>;

async fn close_with(tx: &mut WsTx, code: CloseCode, why: &str) {
    // A close reason is capped at 123 bytes by the protocol.
    let mut reason = why.to_string();
    reason.truncate(120);
    let _ = tx.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
    let _ = tx.close().await;
}

async fn relay(ws_tx: &mut WsTx, ws_rx: &mut WsRx, cfg: &Config) -> Result<(), String> {
    let pool = timeout(Duration::from_secs(10), TcpStream::connect(&cfg.pool))
        .await
        .map_err(|_| "pool connect timed out".to_string())?
        .map_err(|e| format!("pool connect: {e}"))?;
    pool.set_nodelay(true).ok();
    let (pool_rx, mut pool_tx) = pool.into_split();
    // Read the pool on its own task and hand lines over a channel: a channel
    // receive is cancel-safe inside `select!`, `read_line` is not, and losing
    // half a job to a branch that happened to win is a silent wrong job.
    let (line_tx, mut line_rx) = tokio::sync::mpsc::channel::<String>(64);
    let reader = tokio::spawn(read_pool(pool_rx, line_tx));
    let _abort = AbortOnDrop(reader);

    let mut bucket = Bucket { tokens: cfg.burst, last: Instant::now() };
    loop {
        tokio::select! {
            msg = timeout(cfg.idle, ws_rx.next()) => {
                let msg = match msg {
                    Err(_) => return Err("idle".into()),
                    Ok(None) => return Ok(()),
                    Ok(Some(m)) => m.map_err(|e| format!("ws: {e}"))?,
                };
                match msg {
                    Message::Text(t) => {
                        if !frame_ok(t.as_str()) {
                            return Err("malformed frame".into());
                        }
                        if !bucket.take(cfg.rate, cfg.burst) {
                            return Err("frame rate exceeded".into());
                        }
                        let mut buf = Vec::with_capacity(t.len() + 1);
                        buf.extend_from_slice(t.as_bytes());
                        buf.push(b'\n');
                        pool_tx.write_all(&buf).await.map_err(|e| format!("pool: {e}"))?;
                    }
                    // Control frames are frames: tungstenite answers each ping
                    // with a pong, so an uncounted ping is a free way to make
                    // the bridge do work and write bytes.
                    Message::Ping(_) | Message::Pong(_) => {
                        if !bucket.take(cfg.rate, cfg.burst) {
                            return Err("frame rate exceeded".into());
                        }
                    }
                    Message::Close(_) => return Ok(()),
                    Message::Binary(_) | Message::Frame(_) => return Err("binary frame".into()),
                }
            }
            line = line_rx.recv() => {
                match line {
                    None => return Err("pool closed".into()),
                    Some(text) => ws_tx.send(Message::text(text)).await.map_err(|e| format!("ws: {e}"))?,
                }
            }
        }
    }
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Lines from the pool, each bounded. The pool is trusted, but an unbounded
/// read is unbounded whoever is on the other end of it, so a line past the
/// ceiling ends the connection rather than growing a buffer.
async fn read_pool(rx: tokio::net::tcp::OwnedReadHalf, tx: tokio::sync::mpsc::Sender<String>) {
    use tokio::io::AsyncReadExt;
    let mut r = BufReader::new(rx);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let limit = (MAX_LINE * 8) as u64 + 1;
        match (&mut r).take(limit).read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if buf.last() != Some(&b'\n') {
            return; // over the ceiling, or a final line with no terminator
        }
        let Ok(text) = std::str::from_utf8(&buf) else { return };
        let text = text.trim_end_matches(['\n', '\r']);
        if text.is_empty() {
            continue;
        }
        if tx.send(text.to_string()).await.is_err() {
            return;
        }
    }
}
