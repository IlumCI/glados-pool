//! SHA3-256 (FIPS 202), for HeavyHash and nothing else here.
//!
//! This is the same permutation as the Keccak-256 in `proto.js` (EIP-55) and
//! differs in one byte of padding -- `0x06` here against Keccak's `0x01`. The
//! port is `GLaDOS/src/crypto/keccak.rs::sha3_256`, kept to its arrangement so
//! the two read the same: Rho and Pi as one loop carrying the displaced lane,
//! and the pad written so a message that exactly fills the rate still lands its
//! `0x06` and `0x80` in one block.
//!
//! The longest input it sees is an 80-byte header, so there is no streaming
//! form: one call absorbs one or two blocks and squeezes 32 bytes.

/// The 24 round constants of Keccak-f[1600].
const RC: [u64; 24] = [
    0x0000000000000001,
    0x0000000000008082,
    0x800000000000808a,
    0x8000000080008000,
    0x000000000000808b,
    0x0000000080000001,
    0x8000000080008081,
    0x8000000000008009,
    0x000000000000008a,
    0x0000000000000088,
    0x0000000080008009,
    0x000000008000000a,
    0x000000008000808b,
    0x800000000000008b,
    0x8000000000008089,
    0x8000000000008003,
    0x8000000000008002,
    0x8000000000000080,
    0x000000000000800a,
    0x800000008000000a,
    0x8000000080008081,
    0x8000000000008080,
    0x0000000080000001,
    0x8000000080008008,
];

/// Rho's rotation amounts, in the order Pi visits the lanes.
const ROT: [u32; 24] = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];

/// Pi's lane permutation, as the destination index of each step.
const PI: [usize; 24] = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

/// The rate in bytes for a 256-bit digest: 200 - 2 * 32.
const RATE: usize = 136;

fn f1600(st: &mut [u64; 25]) {
    for r in 0..24 {
        // Theta
        let mut bc = [0u64; 5];
        for i in 0..5 {
            bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
        }
        for i in 0..5 {
            let t = bc[(i + 4) % 5] ^ bc[(i + 1) % 5].rotate_left(1);
            let mut j = 0;
            while j < 25 {
                st[j + i] ^= t;
                j += 5;
            }
        }

        // Rho and Pi
        let mut t = st[1];
        for i in 0..24 {
            let j = PI[i];
            let held = st[j];
            st[j] = t.rotate_left(ROT[i]);
            t = held;
        }

        // Chi
        let mut j = 0;
        while j < 25 {
            let row = [st[j], st[j + 1], st[j + 2], st[j + 3], st[j + 4]];
            for i in 0..5 {
                st[j + i] = row[i] ^ (!row[(i + 1) % 5] & row[(i + 2) % 5]);
            }
            j += 5;
        }

        // Iota
        st[0] ^= RC[r];
    }
}

fn absorb(st: &mut [u64; 25], block: &[u8]) {
    for (i, chunk) in block.chunks(8).enumerate() {
        let mut w = [0u8; 8];
        w[..chunk.len()].copy_from_slice(chunk);
        st[i] ^= u64::from_le_bytes(w);
    }
}

/// FIPS 202 SHA3-256 of a message.
pub fn sha3_256(msg: &[u8]) -> [u8; 32] {
    let mut st = [0u64; 25];

    let full = msg.len() / RATE;
    for b in 0..full {
        absorb(&mut st, &msg[b * RATE..(b + 1) * RATE]);
        f1600(&mut st);
    }

    let mut tail = [0u8; RATE];
    let rest = &msg[full * RATE..];
    tail[..rest.len()].copy_from_slice(rest);
    tail[rest.len()] ^= 0x06;
    tail[RATE - 1] ^= 0x80;
    absorb(&mut st, &tail);
    f1600(&mut st);

    let mut out = [0u8; 32];
    for i in 0..4 {
        out[i * 8..(i + 1) * 8].copy_from_slice(&st[i].to_le_bytes());
    }
    out
}
