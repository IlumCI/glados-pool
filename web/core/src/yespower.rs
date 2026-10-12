//! yespower 0.5 and 1.0, written from openwall's reference specification
//! (`yespower-ref.c`, BSD-2-Clause, Colin Percival and Alexander Peslyak).
//!
//! The reference is a specification and this follows its steps and step
//! numbers one for one rather than its optimised sibling, so a disagreement
//! with the published vectors points at a step and not at a trick. Speed comes
//! from not allocating: the scratch (V, X, B and the S-boxes) is owned by the
//! hasher and reused across nonces, since at N=2048 r=32 V alone is 8 MiB.
//!
//! Words are little-endian, which is WebAssembly's byte order and the
//! reference's `le32dec`, so a block read from bytes and a block held as words
//! agree without a swap anywhere.

use crate::sha256::{hmac, pbkdf2_1, sha256};

const PWX_SIMPLE: usize = 2;
const PWX_GATHER: usize = 4;
const PWX_WORDS: usize = PWX_GATHER * PWX_SIMPLE * 2; // 16 words, 64 bytes

#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    N,
    R,
}

pub struct Yespower {
    v10: bool,
    n: u32,
    r: usize,
    pers: Option<Vec<u8>>,
    salsa_rounds: u32,
    pwx_rounds: usize,
    swidth: u32,
    smask: u32,
    v: Vec<u32>,
    x: Vec<u32>,
    b: Vec<u32>,
    s: Vec<u32>,
    // The rotating S-box offsets, in words, and the write cursor, in pairs.
    // Reset on every hash: the reference builds a fresh context per call.
    s0: usize,
    s1: usize,
    s2: usize,
    w: usize,
}

impl Yespower {
    /// Parameters are refused rather than clamped: a clamped N hashes a
    /// different function correctly and every share it finds is rejected.
    pub fn new(v10: bool, n: u32, r: u32, pers: Option<Vec<u8>>) -> Result<Yespower, Refused> {
        if !(1024..=512 * 1024).contains(&n) || !n.is_power_of_two() {
            return Err(Refused::N);
        }
        if !(8..=32).contains(&r) {
            return Err(Refused::R);
        }
        let r = r as usize;
        let (salsa_rounds, pwx_rounds, swidth, sboxes) = if v10 { (2, 3, 11, 3) } else { (8, 6, 8, 2) };
        let sbytes1 = (1usize << swidth) * PWX_SIMPLE * 8;
        Ok(Yespower {
            v10,
            n,
            r,
            pers,
            salsa_rounds,
            pwx_rounds,
            swidth,
            smask: (((1u32 << swidth) - 1) as usize * PWX_SIMPLE * 8) as u32,
            v: vec![0; 32 * r * n as usize],
            x: vec![0; 32 * r],
            b: vec![0; 32 * r],
            s: vec![0; sboxes * sbytes1 / 4],
            s0: 0,
            s1: 0,
            s2: 0,
            w: 0,
        })
    }

    pub fn hash(&mut self, src: &[u8]) -> [u8; 32] {
        let r = self.r;
        let b_size = 128 * r;
        let sbox_words = (1usize << self.swidth) * PWX_SIMPLE * 2;
        self.s0 = 0;
        self.s1 = sbox_words;
        self.s2 = 2 * sbox_words;
        self.w = 0;

        let mut key = sha256(src);
        let salt: &[u8] = if self.v10 { self.pers.as_deref().unwrap_or(&[]) } else { src };

        // 1: (B_0 ... B_{p-1}) <-- PBKDF2(P, S, 1, p * MFLen)
        let mut bb = vec![0u8; b_size];
        pbkdf2_1(&key, salt, &mut bb);
        key.copy_from_slice(&bb[..32]);
        for (i, w) in self.b.iter_mut().enumerate() {
            *w = u32::from_le_bytes(bb[4 * i..4 * i + 4].try_into().unwrap());
        }

        // 3: B_i <-- MF(B_i, N)
        self.smix();

        for (i, w) in self.b.iter().enumerate() {
            bb[4 * i..4 * i + 4].copy_from_slice(&w.to_le_bytes());
        }
        let mut dst = [0u8; 32];
        if !self.v10 {
            // 5: DK <-- PBKDF2(P, B, 1, dkLen)
            pbkdf2_1(&key, &bb, &mut dst);
            if let Some(p) = &self.pers {
                dst = sha256(&hmac(&dst, p));
            }
        } else {
            dst = hmac(&bb[b_size - 64..], &key);
        }
        dst
    }

    fn smix(&mut self) {
        let mut nloop_all = self.n.div_ceil(3);
        let mut nloop_rw = nloop_all;
        nloop_all = (nloop_all + 1) & !1;
        if self.v10 {
            nloop_rw = (nloop_rw + 1) & !1;
        } else {
            nloop_rw &= !1;
        }
        let sn = (self.s.len() * 4 / 128) as u32;
        self.smix1_salsa(sn);
        self.smix1_pwx();
        self.smix2(nloop_rw);
        self.smix2(nloop_all - nloop_rw);
    }

    /// smix1 with r = 1 and V = S, which fills the S-boxes with BlockMix_salsa.
    fn smix1_salsa(&mut self, n: u32) {
        let rounds = self.salsa_rounds;
        let mut x = [0u32; 32];
        for k in 0..2 {
            for i in 0..16 {
                x[k * 16 + i] = self.b[k * 16 + (i * 5 % 16)];
            }
        }
        for i in 0..n as usize {
            self.s[i * 32..i * 32 + 32].copy_from_slice(&x);
            if i > 1 {
                let j = wrap(x[16], i as u32) as usize;
                for k in 0..32 {
                    x[k] ^= self.s[j * 32 + k];
                }
            }
            blockmix_salsa(&mut x, rounds);
        }
        for k in 0..2 {
            for i in 0..16 {
                self.b[k * 16 + (i * 5 % 16)] = x[k * 16 + i];
            }
        }
    }

    fn smix1_pwx(&mut self) {
        let r = self.r;
        let s = 32 * r;
        let mut x = core::mem::take(&mut self.x);
        for k in 0..2 * r {
            for i in 0..16 {
                x[k * 16 + i] = self.b[k * 16 + (i * 5 % 16)];
            }
        }
        if self.v10 {
            for k in 1..r {
                let (lo, hi) = x.split_at_mut(k * 32);
                hi[..32].copy_from_slice(&lo[(k - 1) * 32..k * 32]);
                self.blockmix_pwxform(&mut hi[..32], 1);
            }
        }
        for i in 0..self.n as usize {
            self.v[i * s..i * s + s].copy_from_slice(&x);
            if i > 1 {
                let j = wrap(x[(2 * r - 1) * 16], i as u32) as usize;
                for k in 0..s {
                    x[k] ^= self.v[j * s + k];
                }
            }
            self.blockmix_pwxform(&mut x, r);
        }
        for k in 0..2 * r {
            for i in 0..16 {
                self.b[k * 16 + (i * 5 % 16)] = x[k * 16 + i];
            }
        }
        self.x = x;
    }

    fn smix2(&mut self, nloop: u32) {
        let r = self.r;
        let s = 32 * r;
        let mut x = core::mem::take(&mut self.x);
        for k in 0..2 * r {
            for i in 0..16 {
                x[k * 16 + i] = self.b[k * 16 + (i * 5 % 16)];
            }
        }
        for _ in 0..nloop {
            // 7: j <-- Integerify(X) mod N
            let j = (x[(2 * r - 1) * 16] & (self.n - 1)) as usize;
            for k in 0..s {
                x[k] ^= self.v[j * s + k];
            }
            if nloop != 2 {
                self.v[j * s..j * s + s].copy_from_slice(&x);
            }
            self.blockmix_pwxform(&mut x, r);
        }
        for k in 0..2 * r {
            for i in 0..16 {
                self.b[k * 16 + (i * 5 % 16)] = x[k * 16 + i];
            }
        }
        self.x = x;
    }

    fn blockmix_pwxform(&mut self, b: &mut [u32], r: usize) {
        // 1: r_1 <-- 128r / PWXbytes
        let r1 = 128 * r / 64;
        let mut x = [0u32; PWX_WORDS];
        x.copy_from_slice(&b[(r1 - 1) * 16..r1 * 16]);
        for i in 0..r1 {
            if r1 > 1 {
                for k in 0..16 {
                    x[k] ^= b[i * 16 + k];
                }
            }
            self.pwxform(&mut x);
            b[i * 16..i * 16 + 16].copy_from_slice(&x);
        }
        // 10-13
        let mut i = r1 - 1;
        let blk: &mut [u32; 16] = (&mut b[i * 16..i * 16 + 16]).try_into().unwrap();
        salsa20(blk, self.salsa_rounds);
        i += 1;
        while i < 2 * r {
            for k in 0..16 {
                b[i * 16 + k] ^= b[(i - 1) * 16 + k];
            }
            let blk: &mut [u32; 16] = (&mut b[i * 16..i * 16 + 16]).try_into().unwrap();
            salsa20(blk, self.salsa_rounds);
            i += 1;
        }
    }

    fn pwxform(&mut self, x: &mut [u32; PWX_WORDS]) {
        let (s0, s1, s2) = (self.s0, self.s1, self.s2);
        let smask = self.smask;
        let mut w = self.w;
        let s = &mut self.s;
        for i in 0..self.pwx_rounds {
            for j in 0..PWX_GATHER {
                let xl = x[j * 4];
                let xh = x[j * 4 + 1];
                // 3-4: p0, p1 as word offsets into S0 and S1
                let p0 = s0 + ((xl & smask) / 8) as usize * 2;
                let p1 = s1 + ((xh & smask) / 8) as usize * 2;
                for k in 0..PWX_SIMPLE {
                    let sv0 = ((s[p0 + 2 * k + 1] as u64) << 32) | s[p0 + 2 * k] as u64;
                    let sv1 = ((s[p1 + 2 * k + 1] as u64) << 32) | s[p1 + 2 * k] as u64;
                    let lo = x[j * 4 + 2 * k];
                    let hi = x[j * 4 + 2 * k + 1];
                    // 6: B_{j,k} <-- (hi * lo + S0_{p0,k}) xor S1_{p1,k}
                    let v = ((hi as u64) * (lo as u64)).wrapping_add(sv0) ^ sv1;
                    x[j * 4 + 2 * k] = v as u32;
                    x[j * 4 + 2 * k + 1] = (v >> 32) as u32;
                }
                if self.v10 && (i == 0 || j < PWX_GATHER / 2) {
                    if j & 1 == 1 {
                        for k in 0..PWX_SIMPLE {
                            s[s1 + w * 2] = x[j * 4 + 2 * k];
                            s[s1 + w * 2 + 1] = x[j * 4 + 2 * k + 1];
                            w += 1;
                        }
                    } else {
                        for k in 0..PWX_SIMPLE {
                            s[s0 + (w + k) * 2] = x[j * 4 + 2 * k];
                            s[s0 + (w + k) * 2 + 1] = x[j * 4 + 2 * k + 1];
                        }
                    }
                }
            }
        }
        if self.v10 {
            // 14: (S0, S1, S2) <-- (S2, S0, S1); 15: w <-- w mod 2^Swidth
            self.s0 = s2;
            self.s1 = s0;
            self.s2 = s1;
            self.w = w & ((1usize << self.swidth) * PWX_SIMPLE - 1);
        }
    }
}

fn salsa20(b: &mut [u32; 16], rounds: u32) {
    let mut x = [0u32; 16];
    for i in 0..16 {
        x[i * 5 % 16] = b[i];
    }
    let mut i = 0;
    while i < rounds {
        macro_rules! q {
            ($a:expr, $b:expr, $c:expr, $n:expr) => {
                x[$a] ^= x[$b].wrapping_add(x[$c]).rotate_left($n)
            };
        }
        q!(4, 0, 12, 7); q!(8, 4, 0, 9); q!(12, 8, 4, 13); q!(0, 12, 8, 18);
        q!(9, 5, 1, 7); q!(13, 9, 5, 9); q!(1, 13, 9, 13); q!(5, 1, 13, 18);
        q!(14, 10, 6, 7); q!(2, 14, 10, 9); q!(6, 2, 14, 13); q!(10, 6, 2, 18);
        q!(3, 15, 11, 7); q!(7, 3, 15, 9); q!(11, 7, 3, 13); q!(15, 11, 7, 18);
        q!(1, 0, 3, 7); q!(2, 1, 0, 9); q!(3, 2, 1, 13); q!(0, 3, 2, 18);
        q!(6, 5, 4, 7); q!(7, 6, 5, 9); q!(4, 7, 6, 13); q!(5, 4, 7, 18);
        q!(11, 10, 9, 7); q!(8, 11, 10, 9); q!(9, 8, 11, 13); q!(10, 9, 8, 18);
        q!(12, 15, 14, 7); q!(13, 12, 15, 9); q!(14, 13, 12, 13); q!(15, 14, 13, 18);
        i += 2;
    }
    for i in 0..16 {
        b[i] = b[i].wrapping_add(x[i * 5 % 16]);
    }
}

fn blockmix_salsa(b: &mut [u32; 32], rounds: u32) {
    let mut x = [0u32; 16];
    x.copy_from_slice(&b[16..32]);
    for i in 0..2 {
        for k in 0..16 {
            x[k] ^= b[i * 16 + k];
        }
        salsa20(&mut x, rounds);
        b[i * 16..i * 16 + 16].copy_from_slice(&x);
    }
}

fn wrap(x: u32, i: u32) -> u32 {
    let n = 1u32 << (31 - i.leading_zeros()); // largest power of two <= i
    (x & (n - 1)) + (i - n)
}
