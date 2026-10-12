//! NeoScrypt, the default profile every coin using it runs: N = 128, r = 2,
//! ChaCha20/20 and Salsa20/20 both, FastKDF-BLAKE2s either side. Written from
//! ghostlander's `neoscrypt.c` (BSD-2-Clause, Colin Percival, ArtForz, Andrew
//! Moon, Samuel Neves, John Doering), following its readable path rather than
//! its unrolled one.
//!
//! Upstream ships no test vectors. What settles it is two Feathercoin blocks
//! the network accepted: a header only reached the chain if its NeoScrypt
//! digest beat the target its own nbits declares, so reproducing those digests
//! by accident is not a thing that happens.

use crate::blake2s::keyed_64;

const N: usize = 128;
const R: usize = 2;
const BLOCK_WORDS: usize = 16;
const X_WORDS: usize = 2 * R * BLOCK_WORDS; // 64 words, 256 bytes
const KDF_BUF: usize = 256;

/// FastKDF with BLAKE2s, iterations 32, as `neoscrypt_fastkdf`.
fn fastkdf(password: &[u8], salt: &[u8], out: &mut [u8]) {
    let mut a = [0u8; KDF_BUF + 64];
    let mut b = [0u8; KDF_BUF + 64];
    for (i, x) in a[..KDF_BUF].iter_mut().enumerate() {
        *x = password[i % password.len()];
    }
    a[KDF_BUF..KDF_BUF + 64].copy_from_slice(&password[..64]);
    for (i, x) in b[..KDF_BUF].iter_mut().enumerate() {
        *x = salt[i % salt.len()];
    }
    b[KDF_BUF..KDF_BUF + 32].copy_from_slice(&salt[..32]);

    let mut ptr = 0usize;
    for _ in 0..32 {
        let prf = keyed_64(&a[ptr..ptr + 64], &b[ptr..ptr + 32]);
        ptr = prf.iter().map(|&x| x as usize).sum::<usize>() & (KDF_BUF - 1);
        for i in 0..32 {
            b[ptr + i] ^= prf[i];
        }
        // Head modified, tail updated; tail modified, head updated.
        if ptr < 32 {
            let n = 32.min(32 - ptr);
            b.copy_within(ptr..ptr + n, KDF_BUF + ptr);
        } else if KDF_BUF - ptr < 32 {
            let n = 32 - (KDF_BUF - ptr);
            b.copy_within(KDF_BUF..KDF_BUF + n, 0);
        }
    }
    let len = out.len();
    let room = KDF_BUF - ptr;
    if room >= len {
        for i in 0..len {
            out[i] = b[ptr + i] ^ a[i];
        }
    } else {
        for i in 0..room {
            out[i] = b[ptr + i] ^ a[i];
        }
        for i in 0..len - room {
            out[room + i] = b[i] ^ a[room + i];
        }
    }
}

fn salsa(x: &mut [u32], rounds: usize) {
    let mut v: [u32; 16] = x[..16].try_into().unwrap();
    macro_rules! q {
        ($a:expr, $b:expr, $c:expr, $d:expr) => {
            v[$b] ^= v[$a].wrapping_add(v[$d]).rotate_left(7);
            v[$c] ^= v[$b].wrapping_add(v[$a]).rotate_left(9);
            v[$d] ^= v[$c].wrapping_add(v[$b]).rotate_left(13);
            v[$a] ^= v[$d].wrapping_add(v[$c]).rotate_left(18);
        };
    }
    for _ in 0..rounds / 2 {
        q!(0, 4, 8, 12); q!(5, 9, 13, 1); q!(10, 14, 2, 6); q!(15, 3, 7, 11);
        q!(0, 1, 2, 3); q!(5, 6, 7, 4); q!(10, 11, 8, 9); q!(15, 12, 13, 14);
    }
    for i in 0..16 {
        x[i] = x[i].wrapping_add(v[i]);
    }
}

fn chacha(x: &mut [u32], rounds: usize) {
    let mut v: [u32; 16] = x[..16].try_into().unwrap();
    macro_rules! q {
        ($a:expr, $b:expr, $c:expr, $d:expr) => {
            v[$a] = v[$a].wrapping_add(v[$b]); v[$d] = (v[$d] ^ v[$a]).rotate_left(16);
            v[$c] = v[$c].wrapping_add(v[$d]); v[$b] = (v[$b] ^ v[$c]).rotate_left(12);
            v[$a] = v[$a].wrapping_add(v[$b]); v[$d] = (v[$d] ^ v[$a]).rotate_left(8);
            v[$c] = v[$c].wrapping_add(v[$d]); v[$b] = (v[$b] ^ v[$c]).rotate_left(7);
        };
    }
    for _ in 0..rounds / 2 {
        q!(0, 4, 8, 12); q!(1, 5, 9, 13); q!(2, 6, 10, 14); q!(3, 7, 11, 15);
        q!(0, 5, 10, 15); q!(1, 6, 11, 12); q!(2, 7, 8, 13); q!(3, 4, 9, 14);
    }
    for i in 0..16 {
        x[i] = x[i].wrapping_add(v[i]);
    }
}

/// `neoscrypt_blkmix` for r = 2: four chained blocks, then the middle pair
/// swapped. The swap is the step that differs from scrypt's flow and the one
/// a transliteration most easily gets wrong.
fn blkmix(x: &mut [u32; X_WORDS], use_chacha: bool) {
    let mix = |b: &mut [u32]| if use_chacha { chacha(b, 20) } else { salsa(b, 20) };
    for i in 0..4 {
        let prev = (i + 3) % 4;
        for k in 0..16 {
            x[i * 16 + k] ^= x[prev * 16 + k];
        }
        mix(&mut x[i * 16..i * 16 + 16]);
    }
    for k in 0..16 {
        x.swap(16 + k, 32 + k);
    }
}

fn smix(x: &mut [u32; X_WORDS], v: &mut [u32], use_chacha: bool) {
    for i in 0..N {
        v[i * X_WORDS..(i + 1) * X_WORDS].copy_from_slice(x);
        blkmix(x, use_chacha);
    }
    for _ in 0..N {
        let j = (x[16 * (2 * R - 1)] as usize & (N - 1)) * X_WORDS;
        for k in 0..X_WORDS {
            x[k] ^= v[j + k];
        }
        blkmix(x, use_chacha);
    }
}

pub struct Neoscrypt {
    v: Vec<u32>,
}

impl Default for Neoscrypt {
    fn default() -> Self {
        Neoscrypt { v: vec![0; N * X_WORDS] }
    }
}

impl Neoscrypt {
    pub fn hash(&mut self, header: &[u8; 80]) -> [u8; 32] {
        let mut xb = [0u8; 4 * X_WORDS];
        fastkdf(header, header, &mut xb);
        let mut x = [0u32; X_WORDS];
        for i in 0..X_WORDS {
            x[i] = u32::from_le_bytes(xb[4 * i..4 * i + 4].try_into().unwrap());
        }
        // ChaCha first, Salsa second, XOR them.
        let mut z = x;
        smix(&mut z, &mut self.v, true);
        smix(&mut x, &mut self.v, false);
        for i in 0..X_WORDS {
            xb[4 * i..4 * i + 4].copy_from_slice(&(x[i] ^ z[i]).to_le_bytes());
        }
        let mut out = [0u8; 32];
        fastkdf(header, &xb, &mut out);
        out
    }
}
