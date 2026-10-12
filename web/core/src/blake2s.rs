//! BLAKE2s-256, unkeyed (RFC 7693), over an 80-byte header.
//!
//! An 80-byte message is one full block plus a 16-byte tail, and only the tail
//! holds the nonce, so the first block is compressed once per job.

const IV: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SIGMA: [[usize; 16]; 10] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

fn compress(h: &mut [u32; 8], block: &[u8; 64], count: u64, last: bool) {
    let mut m = [0u32; 16];
    for i in 0..16 {
        m[i] = u32::from_le_bytes(block[4 * i..4 * i + 4].try_into().unwrap());
    }
    let mut v = [0u32; 16];
    v[..8].copy_from_slice(h);
    v[8..].copy_from_slice(&IV);
    v[12] ^= count as u32;
    v[13] ^= (count >> 32) as u32;
    if last {
        v[14] = !v[14];
    }
    #[inline(always)]
    fn g(v: &mut [u32; 16], a: usize, b: usize, c: usize, d: usize, x: u32, y: u32) {
        v[a] = v[a].wrapping_add(v[b]).wrapping_add(x);
        v[d] = (v[d] ^ v[a]).rotate_right(16);
        v[c] = v[c].wrapping_add(v[d]);
        v[b] = (v[b] ^ v[c]).rotate_right(12);
        v[a] = v[a].wrapping_add(v[b]).wrapping_add(y);
        v[d] = (v[d] ^ v[a]).rotate_right(8);
        v[c] = v[c].wrapping_add(v[d]);
        v[b] = (v[b] ^ v[c]).rotate_right(7);
    }
    for s in SIGMA.iter() {
        g(&mut v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
        g(&mut v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
        g(&mut v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
        g(&mut v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
        g(&mut v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
        g(&mut v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
        g(&mut v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
        g(&mut v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for i in 0..8 {
        h[i] ^= v[i] ^ v[i + 8];
    }
}

fn param_iv() -> [u32; 8] {
    let mut h = IV;
    h[0] ^= 0x0101_0020; // digest length 32, no key, fanout 1, depth 1
    h
}

/// BLAKE2s-256 of an arbitrary message, for the RFC vectors.
pub fn blake2s(data: &[u8]) -> [u8; 32] {
    let mut h = param_iv();
    let mut off = 0usize;
    // Every full block but the last is compressed as non-final; the last block
    // (full or partial, or empty for an empty message) carries the flag.
    while data.len() - off > 64 {
        compress(&mut h, data[off..off + 64].try_into().unwrap(), (off + 64) as u64, false);
        off += 64;
    }
    let mut b = [0u8; 64];
    b[..data.len() - off].copy_from_slice(&data[off..]);
    compress(&mut h, &b, data.len() as u64, true);
    out(&h)
}

fn out(h: &[u32; 8]) -> [u8; 32] {
    let mut o = [0u8; 32];
    for i in 0..8 {
        o[4 * i..4 * i + 4].copy_from_slice(&h[i].to_le_bytes());
    }
    o
}

pub struct Blake2sHeader {
    mid: [u32; 8],
    tail: [u8; 16],
}

impl Blake2sHeader {
    pub fn new(header: &[u8; 80]) -> Blake2sHeader {
        let mut mid = param_iv();
        compress(&mut mid, header[..64].try_into().unwrap(), 64, false);
        Blake2sHeader { mid, tail: header[64..80].try_into().unwrap() }
    }

    pub fn hash(&self, nonce: u32) -> [u8; 32] {
        let mut b = [0u8; 64];
        b[..16].copy_from_slice(&self.tail);
        b[12..16].copy_from_slice(&nonce.to_le_bytes());
        let mut h = self.mid;
        compress(&mut h, &b, 80, true);
        out(&h)
    }
}
