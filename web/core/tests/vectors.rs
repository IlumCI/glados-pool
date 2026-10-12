//! Published vectors only: nothing here chose its own answer.

use glados_web_core::blake2s::{blake2s, Blake2sHeader};
use glados_web_core::sha256::{sha256, Sha256d};
use glados_web_core::yespower::Yespower;

fn hex(s: &str) -> Vec<u8> {
    let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// openwall/yespower TESTS-OK, verbatim.
#[test]
fn yespower_tests_ok() {
    let mut src = [0u8; 80];
    for (i, b) in src.iter_mut().enumerate() {
        *b = (i * 3) as u8;
    }
    let cases: &[(bool, u32, u32, Option<&[u8]>, &str)] = &[
        (false, 2048, 8, Some(b"Client Key"), "a5 9f ec 4c 4f dd a1 6e 3b 14 05 ad da 66 d5 25 b6 8e 7c ad fc fe 6a c0 66 c7 ad 11 8c d8 05 90"),
        (false, 2048, 8, Some(&src), "5e a2 b2 95 6a 9e ac e3 0a 32 37 ff 1d 44 1e de e1 dc 25 aa b8 f0 ea 15 c1 21 65 f8 3a 7b c2 65"),
        (false, 4096, 16, Some(b"Client Key"), "92 7e 72 d0 de d3 d8 04 75 47 3f 40 f1 74 3c 67 28 9d 45 3d 52 42 d4 f5 5a f4 e3 25 e0 66 99 c5"),
        (false, 4096, 24, Some(b"Jagaricoin"), "0e 13 66 97 32 11 e7 fe a8 ad 9d 81 98 9c 84 a2 54 d9 68 c9 d3 33 dd 8f f0 99 32 4f 38 61 1e 04"),
        (false, 4096, 32, Some(b"WaviBanana"), "3a e0 5a bb 3c 5c f6 f7 54 15 a9 25 54 c9 8d 50 e3 8e c9 55 2c fa 78 37 36 16 f4 80 b2 4e 55 9f"),
        (false, 2048, 32, Some(b"Client Key"), "56 0a 89 1b 5c a2 e1 c6 36 11 1a 9f f7 c8 94 a5 d0 a2 60 2f 43 fd cf a5 94 9b 95 e2 2f e4 46 1e"),
        (false, 1024, 32, Some(b"Client Key"), "2a 79 e5 3d 1b e6 66 9b c5 56 cc c4 17 bc e3 d2 2a 74 a2 32 f5 6b 8e 1d 39 b4 57 92 67 5d e1 08"),
        (false, 2048, 8, None, "5e cb d8 e8 d7 c9 0b ae d4 bb f8 91 6a 12 25 dc c3 c6 5f 5c 91 65 ba e8 1c dd e3 cf fa d1 28 e8"),
        (true, 2048, 8, None, "69 e0 e8 95 b3 df 7a ee b8 37 d7 1f e1 99 e9 d3 4f 7e c4 6e cb ca 7a 2c 43 08 e5 18 57 ae 9b 46"),
        (true, 4096, 16, None, "33 fb 8f 06 38 24 a4 a0 20 f6 3d ca 53 5f 5c a6 6a b5 57 64 68 c7 5d 1c ca ac 75 42 f7 64 95 ac"),
        (true, 4096, 32, None, "77 1a ee fd a8 fe 79 a0 82 5b c7 f2 ae e1 62 ab 55 78 57 46 39 ff c6 ca 37 23 cc 18 e5 e3 e2 85"),
        (true, 2048, 32, None, "d5 ef b8 13 cd 26 3e 9b 34 54 01 30 23 3c bb c6 a9 21 fb ff 34 31 e5 ec 1a 1a bd e2 ae a6 ff 4d"),
        (true, 1024, 32, None, "50 1b 79 2d b4 2e 38 8f 6e 7d 45 3c 95 d0 3a 12 a3 60 16 a5 15 4a 68 83 90 dd c6 09 a4 0c 67 99"),
        (true, 1024, 32, Some(b"personality test"), "1f 02 69 ac f5 65 c4 9a dc 0e f9 b8 f2 6a b3 80 8c dc 38 39 4a 25 4f dd ee dc c3 aa cf f6 ad 9d"),
    ];
    let mut bad = Vec::new();
    for (v10, n, r, pers, want) in cases {
        let mut y = Yespower::new(*v10, *n, *r, pers.map(|p| p.to_vec())).unwrap();
        let got = y.hash(&src);
        if got.to_vec() != hex(want) {
            bad.push(format!("v10={v10} N={n} r={r}"));
        }
    }
    assert!(bad.is_empty(), "mismatched: {bad:?}");
}

/// The XOR loops: 75 parameter sets per version, and the 0.5 one is chosen by
/// upstream to hit the duplicate-index case in the last SMix2.
#[test]
fn yespower_xor_loops() {
    let mut src = [0u8; 80];
    src[0] = 43;
    for i in 1..80 {
        src[i] = (i * 3) as u8;
    }
    for (v10, pers, want) in [
        (false, Some(b"Client Key".to_vec()), "ae f1 32 91 87 0f 55 70 47 f4 2e 9b ef a6 16 df e5 f1 96 77 e1 3f 8b a6 92 f7 c5 97 55 a0 f5 0e"),
        (true, None, "8d 13 c5 fb 07 30 96 75 d1 b8 48 92 77 ba 4b e4 40 33 be df ae 7a 60 43 8a 9b e2 1f 3a 7b 12 37"),
    ] {
        let mut x = [0u8; 32];
        let mut n = 1024;
        while n <= 4096 {
            for r in 8..=32 {
                let mut y = Yespower::new(v10, n, r, pers.clone()).unwrap();
                for (a, b) in x.iter_mut().zip(y.hash(&src)) {
                    *a ^= b;
                }
            }
            n <<= 1;
        }
        assert_eq!(x.to_vec(), hex(want), "xor loop v10={v10}");
    }
}

/// Reusing one hasher across inputs must give what a fresh one gives: the
/// S-box cursor and offsets are per hash, and a leak between nonces would
/// hash a different function from the second nonce on.
#[test]
fn yespower_hasher_is_reusable() {
    let mut a = Yespower::new(true, 2048, 8, None).unwrap();
    let h1 = a.hash(b"first");
    let h2 = a.hash(b"second");
    assert_eq!(h1, Yespower::new(true, 2048, 8, None).unwrap().hash(b"first"));
    assert_eq!(h2, Yespower::new(true, 2048, 8, None).unwrap().hash(b"second"));
}

#[test]
fn yespower_refuses_rather_than_clamps() {
    assert!(Yespower::new(true, 1000, 8, None).is_err());
    assert!(Yespower::new(true, 512, 8, None).is_err());
    assert!(Yespower::new(true, 2048, 7, None).is_err());
    assert!(Yespower::new(true, 2048, 33, None).is_err());
}

#[test]
fn sha256_fips() {
    assert_eq!(sha256(b"abc").to_vec(), hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    assert_eq!(sha256(b"").to_vec(), hex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
    let long = b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    assert_eq!(sha256(long).to_vec(), hex("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"));
}

/// Bitcoin block 125552, whose id anybody can look up.
#[test]
fn sha256d_bitcoin_block_125552() {
    let header: [u8; 80] = hex(
        "0100000081cd02ab7e569e8bcd9317e2fe99f2de44d49ab2b8851ba4a308000000000000\
         e320b6c2fffc8d750423db8b1eb942ae710e951ed797f7affc8892b0f1fc122b\
         c7f5d74df2b9441a42a14695",
    )
    .try_into()
    .unwrap();
    let nonce = u32::from_le_bytes(header[76..80].try_into().unwrap());
    let mut d = Sha256d::new(&header).hash(nonce);
    d.reverse();
    assert_eq!(d.to_vec(), hex("00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d"));
    // The midstate path must equal a plain double hash of the whole header.
    let mut h = header;
    h[76..80].copy_from_slice(&1234u32.to_le_bytes());
    assert_eq!(Sha256d::new(&header).hash(1234), sha256(&sha256(&h)));
}

/// RFC 7693 Appendix B, and the header path against the plain one.
#[test]
fn blake2s_rfc7693() {
    assert_eq!(blake2s(b"abc").to_vec(), hex("508C5E8C327C14E2E1A72BA34EEB452F37458B209ED63A294D999B4C86675982"));
    assert_eq!(blake2s(b"").to_vec(), hex("69217A3079908094E11121D042354A7C1F55B6482CA1A51E1B250DFD1ED0EEF9"));
    let mut header = [0u8; 80];
    for (i, b) in header.iter_mut().enumerate() {
        *b = (i * 7) as u8;
    }
    let mut h = header;
    h[76..80].copy_from_slice(&0xdeadbeefu32.to_le_bytes());
    assert_eq!(Blake2sHeader::new(&header).hash(0xdeadbeef), blake2s(&h));
}

#[test]
fn target_compare_reads_the_digest_little_endian() {
    use glados_web_core::below_target;
    let mut d = [0u8; 32];
    d[31] = 0x00;
    d[30] = 0x10; // most significant byte is d[31]
    let mut t = [0u8; 32];
    t[1] = 0x10;
    assert!(below_target(&d, &t), "equal is a pass");
    t[1] = 0x0f;
    assert!(!below_target(&d, &t));
    d[0] = 0xff; // least significant byte cannot outvote a higher one
    t[1] = 0x11;
    assert!(below_target(&d, &t));
}

#[test]
fn a_scan_finds_exactly_what_hashing_each_nonce_finds() {
    use glados_web_core::{below_target, Job, ALGO_SHA256D};
    let header = [7u8; 80];
    let mut target = [0u8; 32];
    target[0] = 0x0f; // about one nonce in sixteen
    target[1..].fill(0xff);
    let mut j = Job::new(ALGO_SHA256D, false, 0, 0, None, &header, &target).unwrap();
    let mut found = Vec::new();
    j.scan(u32::MAX - 100, 200, &mut found); // across the wrap
    let want: Vec<u32> = (0..200u32)
        .map(|i| (u32::MAX - 100).wrapping_add(i))
        .filter(|&n| below_target(&j.hash(n), &target))
        .take(32)
        .collect();
    assert_eq!(found, want);
    assert!(!found.is_empty());
}

#[test]
#[ignore]
fn native_rate() {
    let mut y = Yespower::new(true, 2048, 8, None).unwrap();
    let t = std::time::Instant::now();
    for i in 0..400u32 { y.hash(&i.to_le_bytes()); }
    println!("native yespower 1.0 N=2048 r=8: {:.0} H/s", 400.0 / t.elapsed().as_secs_f64());
}

fn nbits_target(nbits: u32) -> [u8; 32] {
    // Compact form: exponent in the top byte, 3-byte mantissa, big-endian out.
    let exp = (nbits >> 24) as usize;
    let mant = nbits & 0x00ff_ffff;
    let mut t = [0u8; 32];
    for (i, b) in mant.to_be_bytes()[1..].iter().enumerate() {
        t[32 - exp + i] = *b;
    }
    t
}

/// Two Feathercoin blocks the network accepted. The digests are recomputed
/// here, and separately each must beat the target in its own header's nbits,
/// which is what makes a block a vector nobody here chose.
#[test]
fn neoscrypt_feathercoin_blocks() {
    use glados_web_core::{below_target, neoscrypt::Neoscrypt};
    let cases = [
        (
            "02000000 54aa94a46a70931d29f2a2ed3ee4ab5832cd6446a090f6f63292d004dd306e96 bca6f3f22928ee4aa468ed5d5ff0f0a31137c2f9e780e0a70411a4a39b98d91c 1b364d54 dcdd3d1d 52660400",
            "aac8eaaea3c756f584d884f2de9e0e8c401f3ba0a640a14221550d2d06000000",
        ),
        (
            "04000020 0a9245b1198825ab30d6dbae2b185e31f342d1058cc36851629bf435fc682b55 4d100771e4a23d210cd3a1503e3b1ca524e8482913ee5b4036edf4bd20db6a29 93c0a16a dc09011d 002c5f48",
            "ff87010b15afee123759c6cb14fe33078d1795ca6f39286c3566d52500000000",
        ),
    ];
    for (h, want) in cases {
        let header: [u8; 80] = hex(h).try_into().unwrap();
        let d = Neoscrypt::default().hash(&header);
        assert_eq!(d.to_vec(), hex(want), "digest of {}", &h[..20]);
        let nbits = u32::from_le_bytes(header[72..76].try_into().unwrap());
        assert!(below_target(&d, &nbits_target(nbits)), "beats its own nbits {nbits:08x}");
    }
}

/// RFC 7693's keyed BLAKE2s KAT (blake2s-kat.txt): key 00..1f, message 00..3f.
#[test]
fn blake2s_keyed_kat() {
    let key: Vec<u8> = (0..32).collect();
    let msg: Vec<u8> = (0..64).collect();
    assert_eq!(
        glados_web_core::blake2s::keyed_64(&msg, &key).to_vec(),
        hex("8975b0577fd35566d750b362b0897a26c399136df07bababbde6203ff2954ed4")
    );
}
