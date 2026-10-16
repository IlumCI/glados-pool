//! HeavyHash as Optical Bitcoin (OBTC) defines it, which is what zpool's
//! `heavyhash` port mines. Ported from `GLaDOS/src/mine/heavyhash.rs`, with
//! `GLaDOS/tools/heavyhash.py` as the oracle it was read against.
//!
//! In one line: SHA3-256 of the header, a 64x64 nibble matrix applied to that
//! digest's nibbles, XOR back, SHA3-256 again -- with the matrix drawn from
//! xoshiro256++ seeded by SHA3-256 of the previous block hash.
//!
//! **The matrix is per job and not per nonce**, since it depends on the
//! previous block hash alone (header bytes 4..36). So `Heavy` holds it and the
//! browser builds one per `job_set`, reusing it across every nonce in the scan.
//!
//! **The rank test is modular here, exact in the oracle, floating upstream.**
//! Rank modulo a prime can only fall below rank over the rationals, so a matrix
//! full-rank mod p is full-rank, full stop. The only disagreement possible is a
//! matrix singular mod *both* primes and invertible over Q, which for random
//! nibbles is about (64/2^31)^2 -- stated rather than reachable by a test.

use crate::sha3::sha3_256;

pub type Matrix = [[u8; 64]; 64];

fn xoshiro_next(s: &mut [u64; 4]) -> u64 {
    let result = s[0].wrapping_add(s[3]).rotate_left(23).wrapping_add(s[0]);
    let t = s[1] << 17;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = s[3].rotate_left(45);
    result
}

fn full_rank_mod(m: &Matrix, p: u64) -> bool {
    let mut a = [[0u64; 64]; 64];
    for i in 0..64 {
        for j in 0..64 {
            a[i][j] = m[i][j] as u64 % p;
        }
    }
    let inv = |x: u64| -> u64 {
        // Fermat: x^(p-2) mod p, p prime.
        let (mut b, mut e, mut r) = (x % p, p - 2, 1u64);
        while e > 0 {
            if e & 1 == 1 {
                r = r * b % p;
            }
            b = b * b % p;
            e >>= 1;
        }
        r
    };
    for c in 0..64 {
        let Some(piv) = (c..64).find(|&r| a[r][c] != 0) else {
            return false;
        };
        a.swap(c, piv);
        let ic = inv(a[c][c]);
        for r in c + 1..64 {
            if a[r][c] != 0 {
                let f = a[r][c] * ic % p;
                for k in c..64 {
                    a[r][k] = (a[r][k] + p - f * a[c][k] % p) % p;
                }
            }
        }
    }
    true
}

/// The matrix for a previous-block hash, as stored in the header (bytes 4..36).
pub fn matrix(prev: &[u8; 32]) -> Box<Matrix> {
    let seed = sha3_256(prev);
    let mut s = [0u64; 4];
    for (i, w) in s.iter_mut().enumerate() {
        let mut b = [0u8; 8];
        b.copy_from_slice(&seed[i * 8..i * 8 + 8]);
        *w = u64::from_le_bytes(b);
    }
    let mut m: Box<Matrix> = Box::new([[0u8; 64]; 64]);
    loop {
        for row in m.iter_mut() {
            for j in (0..64).step_by(16) {
                let v = xoshiro_next(&mut s);
                for k in 0..16 {
                    row[j + k] = ((v >> (4 * k)) & 0xF) as u8;
                }
            }
        }
        // Two primes below 2^31, so every product fits a u64.
        if full_rank_mod(&m, 2_147_483_647) || full_rank_mod(&m, 2_147_483_629) {
            return m;
        }
    }
}

/// SHA3, the matrix step, SHA3: the digest in memory order, compared
/// little-endian against a target like every other hash here.
pub fn hash(m: &Matrix, header: &[u8; 80]) -> [u8; 32] {
    let h = sha3_256(header);
    let mut v = [0u32; 64];
    for (k, b) in h.iter().enumerate() {
        v[2 * k] = (b >> 4) as u32;
        v[2 * k + 1] = (b & 0xF) as u32;
    }
    let mut x = [0u8; 32];
    for k in 0..32 {
        let mut p = [0u32; 2];
        for (half, pi) in p.iter_mut().enumerate() {
            let row = &m[2 * k + half];
            let mut acc = 0u32;
            for j in 0..64 {
                acc += row[j] as u32 * v[j];
            }
            // At most 64 * 15 * 15 = 14,400, so after the shift it is below 16
            // and packs into a nibble without a mask -- the same fact obtc-core
            // relies on by not masking either.
            *pi = acc >> 10;
        }
        x[k] = h[k] ^ ((p[0] << 4) | p[1]) as u8;
    }
    sha3_256(&x)
}

/// The prepared form a hash loop holds: the matrix for this job's previous
/// block, built once and reused for every nonce.
pub struct Heavy {
    m: Box<Matrix>,
}

impl Heavy {
    pub fn new(header: &[u8; 80]) -> Heavy {
        let mut prev = [0u8; 32];
        prev.copy_from_slice(&header[4..36]);
        Heavy { m: matrix(&prev) }
    }

    pub fn hash(&self, header: &[u8; 80], nonce: u32) -> [u8; 32] {
        let mut h = *header;
        h[76..80].copy_from_slice(&nonce.to_le_bytes());
        hash(&self.m, &h)
    }

    /// The 64x64 matrix, nibble per byte, for the GPU to upload.
    pub fn matrix(&self) -> &Matrix {
        &self.m
    }
}
