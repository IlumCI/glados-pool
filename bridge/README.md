# glados-bridge

A browser cannot open a TCP socket, and the pool speaks newline-delimited JSON
over one. This turns one WebSocket text frame into one line and back, and does
nothing else to the protocol: the pool parses, bounds and refuses; the bridge
bounds the pipe.

## What it enforces

| | |
|---|---|
| Origin allowlist | required; an empty list refuses everyone. Stops third-party sites pointing their visitors' browsers at this bridge without consent |
| One frame, one line | a frame containing a newline is refused, never split |
| Frame size | 8 KiB, either direction |
| Frame rate | token bucket per connection, default 10/s, burst 40 |
| Connections | 1024 total, 8 per client address |
| Idle | closed after 300 s of client silence |

`--trust-proxy` takes the client address from the last `X-Forwarded-For`
entry, which is the one the TLS proxy appended. Without it the header is
ignored, since from anywhere else it is the client's own words.

## Run

```bash
cargo build --release --target x86_64-unknown-linux-musl
glados-bridge --pool 127.0.0.1:3334 --listen 127.0.0.1:8080 \
  --trust-proxy --origin https://pool.aperture.institute
```

`deploy/` has a Caddyfile (free Let's Encrypt TLS) and a systemd unit. The
intended placement is the pool's own host: the bridge reaches the pool over
loopback, so the pool's plaintext protocol never crosses the internet.

## Test

```bash
cargo test
```

Seven claims against a fake pool over real sockets, including that a foreign
origin, a smuggled second line, a binary frame and a flood each fail to reach
the pool.
