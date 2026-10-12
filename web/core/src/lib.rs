//! Hash functions for the browser miner, and the boundary the page calls.
//!
//! **One instance per Web Worker, no shared memory.** Each worker loads its
//! own copy of this module, so there is no `SharedArrayBuffer`, no atomics and
//! no cross-origin isolation -- which GitHub Pages cannot provide anyway,
//! since it sets no response headers. A slice of the nonce space per worker is
//! all the coordination mining needs.
//!
//! **No bindgen.** The surface is six functions over integers and one buffer,
//! which a few lines of JavaScript can call directly; a generated glue layer
//! would be a second source of truth about the same six functions.
//!
//! The wire contract it implements is the pool's: an 80-byte header with the
//! nonce little-endian at offset 76, and a 32-byte big-endian target that the
//! byte-reversed digest must not exceed.

pub mod blake2s;
pub mod sha256;
pub mod yespower;

use blake2s::Blake2sHeader;
use sha256::Sha256d;
use yespower::Yespower;

pub const ALGO_SHA256D: u32 = 1;
pub const ALGO_BLAKE2S: u32 = 2;
pub const ALGO_YESPOWER: u32 = 3;

/// Where the page writes a job: header at 0, target at 80, personalisation
/// at 112. Results come back in the same buffer: found nonces from 512.
const IO_LEN: usize = 1024;
const PERS_MAX: usize = 400;
const FOUND_AT: usize = 512;
pub const FOUND_MAX: usize = 32;

enum Hasher {
    Sha256d(Sha256d),
    Blake2s(Blake2sHeader),
    Yespower(Box<Yespower>, [u8; 80]),
}

impl Hasher {
    fn hash(&mut self, nonce: u32) -> [u8; 32] {
        match self {
            Hasher::Sha256d(h) => h.hash(nonce),
            Hasher::Blake2s(h) => h.hash(nonce),
            Hasher::Yespower(y, header) => {
                header[76..80].copy_from_slice(&nonce.to_le_bytes());
                y.hash(header)
            }
        }
    }
}

/// Whether a digest, read as the little-endian integer every Bitcoin-family
/// chain reads it as, is at or below a big-endian target.
pub fn below_target(digest: &[u8; 32], target_be: &[u8; 32]) -> bool {
    for i in 0..32 {
        let d = digest[31 - i];
        if d != target_be[i] {
            return d < target_be[i];
        }
    }
    true
}

pub struct Job {
    hasher: Hasher,
    target: [u8; 32],
}

impl Job {
    pub fn new(algo: u32, v10: bool, n: u32, r: u32, pers: Option<&[u8]>, header: &[u8; 80], target: &[u8; 32]) -> Option<Job> {
        let hasher = match algo {
            ALGO_SHA256D => Hasher::Sha256d(Sha256d::new(header)),
            ALGO_BLAKE2S => Hasher::Blake2s(Blake2sHeader::new(header)),
            ALGO_YESPOWER => Hasher::Yespower(Box::new(Yespower::new(v10, n, r, pers.map(|p| p.to_vec())).ok()?), *header),
            _ => return None,
        };
        Some(Job { hasher, target: *target })
    }

    pub fn hash(&mut self, nonce: u32) -> [u8; 32] {
        self.hasher.hash(nonce)
    }

    /// Scan `count` nonces from `start`, wrapping at 2^32, and collect those
    /// that meet the target, at most `FOUND_MAX`.
    pub fn scan(&mut self, start: u32, count: u32, found: &mut Vec<u32>) {
        for i in 0..count {
            let n = start.wrapping_add(i);
            if below_target(&self.hasher.hash(n), &self.target) && found.len() < FOUND_MAX {
                found.push(n);
            }
        }
    }
}

// ----------------------------------------------------------------------------
// The exported surface. Single-threaded by construction (one instance per
// worker), which is the only reason `static mut` is sound here.

static mut IO: [u8; IO_LEN] = [0; IO_LEN];
static mut JOB: Option<Job> = None;

#[allow(static_mut_refs)]
fn io() -> &'static mut [u8; IO_LEN] {
    unsafe { &mut IO }
}

#[allow(static_mut_refs)]
fn job() -> &'static mut Option<Job> {
    unsafe { &mut JOB }
}

#[unsafe(no_mangle)]
pub extern "C" fn io_ptr() -> *mut u8 {
    io().as_mut_ptr()
}

/// Install the job written at `io_ptr()`. `pers_len` of -1 means no
/// personalisation, which differs from an empty one for yespower 0.5.
/// Answers 1 on success, 0 for parameters this build refuses.
#[unsafe(no_mangle)]
pub extern "C" fn job_set(algo: u32, v10: u32, n: u32, r: u32, pers_len: i32) -> u32 {
    let b = io();
    let header: [u8; 80] = b[..80].try_into().unwrap();
    let target: [u8; 32] = b[80..112].try_into().unwrap();
    let pers = match pers_len {
        l if l < 0 => None,
        l if l as usize <= PERS_MAX => Some(b[112..112 + l as usize].to_vec()),
        _ => return 0,
    };
    *job() = Job::new(algo, v10 != 0, n, r, pers.as_deref(), &header, &target);
    job().is_some() as u32
}

/// Scan and answer how many nonces met the target; they are at
/// `io_ptr() + 512` as little-endian u32s.
#[unsafe(no_mangle)]
pub extern "C" fn scan(start: u32, count: u32) -> u32 {
    let Some(j) = job().as_mut() else { return 0 };
    let mut found = Vec::new();
    j.scan(start, count, &mut found);
    let b = io();
    for (i, n) in found.iter().enumerate() {
        b[FOUND_AT + 4 * i..FOUND_AT + 4 * i + 4].copy_from_slice(&n.to_le_bytes());
    }
    found.len() as u32
}

/// The midstate of a SHA-256d or BLAKE2s job, as eight little-endian u32s
/// over the start of the buffer: the GPU kernels start from it, so the first
/// 64 bytes are compressed once per job on the CPU rather than once per
/// nonce on the GPU. Answers 0 for an algorithm with no midstate.
#[unsafe(no_mangle)]
pub extern "C" fn job_mid() -> u32 {
    let mid = match job().as_ref().map(|j| &j.hasher) {
        Some(Hasher::Sha256d(h)) => h.midstate(),
        Some(Hasher::Blake2s(h)) => h.midstate(),
        _ => return 0,
    };
    for (i, w) in mid.iter().enumerate() {
        io()[4 * i..4 * i + 4].copy_from_slice(&w.to_le_bytes());
    }
    1
}

/// The digest of one nonce, written over the start of the buffer. For
/// re-checking a share and for the page's known-answer test.
#[unsafe(no_mangle)]
pub extern "C" fn hash_one(nonce: u32) -> u32 {
    let Some(j) = job().as_mut() else { return 0 };
    let d = j.hash(nonce);
    io()[..32].copy_from_slice(&d);
    1
}
