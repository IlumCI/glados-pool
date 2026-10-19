// Reference vectors for a browser Pearl miner, produced by Pearl's own code.
//
// 1. Mine with Pearl's `try_mine_one` on small matrices from a fixed-seed RNG.
// 2. Check the result with Pearl's `verify_plain_proof`.
// 3. Recompute the tile through Pearl's verifier functions (parse_proof ->
//    compute_noise -> compute_jackpot -> compute_jackpot_hash) and dump every
//    intermediate, plus the full A and B the RNG produced, as JSON.
// 4. Dump the proof as it travels to a pool -- base64(bincode(PlainProof)), the
//    `plain_proof` of a `mining.submit` -- and a set of broken copies of it,
//    each with whether Pearl's verifier accepts it, so a pool-side verifier can
//    be held to the same answers.
use base64::Engine;
use primitive_types::U256;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use zk_pow::api::proof::{IncompleteBlockHeader, MMAType, MiningConfiguration, PeriodicPattern};
use zk_pow::api::proof_utils::{CompiledPublicParams, compute_jackpot_hash};
use zk_pow::api::sanity_checks::extract_difficulty_bound;
use zk_pow::api::seed::SeedDerivation;
use zk_pow::api::verify::verify_plain_proof;
use zk_pow::circuit::chip::jackpot::helper::compute_jackpot;
use zk_pow::circuit::pearl_noise::compute_noise;
use zk_pow::ffi::mine::try_mine_one;
use zk_pow::ffi::plain_proof::PlainProof;

fn b64(v: &[i8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(v.iter().map(|&x| x as u8).collect::<Vec<u8>>())
}
fn b64u(v: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(v)
}

fn header(nbits: u32) -> IncompleteBlockHeader {
    IncompleteBlockHeader { version: 1, prev_block: [0x11; 32], merkle_root: [0x22; 32], timestamp: 1_790_000_000, nbits }
}

// Each broken copy, and Pearl's own verdict on it.
fn tampered(h: &IncompleteBlockHeader, proof: &PlainProof, sd: SeedDerivation) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let mut push = |what: &str, p: PlainProof| {
        let ok = verify_plain_proof(h, &p, None, sd).is_ok();
        out.push(serde_json::json!({ "what": what, "plain_proof_b64": b64u(&bincode::serialize(&p).unwrap()), "pearl_accepts": ok }));
    };
    let mut p = proof.clone();
    p.a.proof.leaf_data[0][5] ^= 1; // a matrix byte inside the tile
    push("a byte of A flipped", p);
    let mut p = proof.clone();
    p.bt.proof.leaf_data[0][9] ^= 1;
    push("a byte of B flipped", p);
    let mut p = proof.clone();
    if let Some(s) = p.a.proof.siblings.first_mut() { s[0] ^= 1; }
    push("an A Merkle sibling flipped", p);
    let mut p = proof.clone();
    p.a.proof.root[3] ^= 1;
    push("A's root changed", p);
    let mut p = proof.clone();
    p.noise_rank *= 2;
    push("noise_rank doubled", p);
    let mut p = proof.clone();
    p.a.proof.leaf_data[0][0] = 100; // out of the [-64, 64] signal range
    push("an A value out of range", p);
    out
}

// Proofs that are internally consistent -- every Merkle path checks -- and still
// wrong: matrices committed honestly but outside the signal range, and a tile
// whose hash does not meet the target. Only the later checks can refuse these.
fn honest_but_wrong() -> Vec<serde_json::Value> {
    let rows16: Vec<u32> = (0..16).collect();
    let cfg = || MiningConfiguration { common_dim: 2048, rank: 128, mma_type: MMAType::Int7xInt7ToInt32,
        rows_pattern: PeriodicPattern::from_list(&rows16).unwrap(), cols_pattern: PeriodicPattern::from_list(&rows16).unwrap(), moe: None };
    let sd = SeedDerivation::Salted;
    let mut out = Vec::new();
    // A: values to +-100, at an easy target, so only the range check can object.
    let h = header(0x207f_ffff);
    let mut r = ChaCha8Rng::seed_from_u64(99);
    let p = try_mine_one(&mut r, 64, 64, 2048, h, cfg(), Some((-100, 100)), false, sd).unwrap().unwrap();
    out.push(serde_json::json!({ "what": "values outside [-64, 64], committed honestly", "header": hex::encode(h.to_bytes()), "nbits": h.nbits,
        "plain_proof_b64": b64u(&bincode::serialize(&p).unwrap()), "pearl_accepts": verify_plain_proof(&h, &p, None, sd).is_ok() }));
    // B: a tile chosen *because* it misses a moderate target.
    let h = header(0x1d7f_ffff);
    let mut r = ChaCha8Rng::seed_from_u64(5);
    let p = try_mine_one(&mut r, 64, 64, 2048, h, cfg(), None, true, sd).unwrap().unwrap();
    out.push(serde_json::json!({ "what": "a jackpot hash above the target", "header": hex::encode(h.to_bytes()), "nbits": h.nbits,
        "plain_proof_b64": b64u(&bincode::serialize(&p).unwrap()), "pearl_accepts": verify_plain_proof(&h, &p, None, sd).is_ok() }));
    out
}

fn run(name: &str, seed: u64, m: usize, n: usize, k: usize, rank: u16, rows: &[u32], cols: &[u32], sd: SeedDerivation, nbits: u32) -> serde_json::Value {
    let header = header(nbits);
    let config = MiningConfiguration {
        common_dim: k as u32,
        rank,
        mma_type: MMAType::Int7xInt7ToInt32,
        rows_pattern: PeriodicPattern::from_list(rows).unwrap(),
        cols_pattern: PeriodicPattern::from_list(cols).unwrap(),
        moe: None,
    };

    // The same draws try_mine_one makes, from a clone of the same RNG: A (m x k)
    // row by row, then B (k x n) row by row.
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let mut twin = rng.clone();
    let a: Vec<Vec<i8>> = (0..m).map(|_| (0..k).map(|_| twin.random_range(-64i8..=64)).collect()).collect();
    let b: Vec<Vec<i8>> = (0..k).map(|_| (0..n).map(|_| twin.random_range(-64i8..=64)).collect()).collect();

    let proof = try_mine_one(&mut rng, m, n, k, header, config, None, false, sd)
        .expect("try_mine_one")
        .expect("some tile should hit at this target");
    verify_plain_proof(&header, &proof, None, sd).expect("Pearl's verifier rejected its own proof");

    let (private, public) = proof.parse_proof(header, sd).expect("parse_proof");
    let compiled = CompiledPublicParams::from(&public);
    let noise = compute_noise(&compiled);
    let jackpot = compute_jackpot(&compiled, &private.s_a, &private.s_b, &noise);
    let jh = compute_jackpot_hash(&jackpot, compiled.commitment_hash.1);
    let bound = extract_difficulty_bound(header.nbits, &config);
    assert!(U256::from_little_endian(&jh) <= bound);

    let wire = bincode::serialize(&proof).expect("bincode");
    let back: PlainProof = bincode::deserialize(&wire).expect("bincode round trip");
    assert_eq!(bincode::serialize(&back).unwrap(), wire);

    let flat = |mm: &Vec<Vec<i8>>| mm.iter().flatten().copied().collect::<Vec<i8>>();
    serde_json::json!({
        "name": name, "seed": seed, "seed_derivation": format!("{:?}", sd),
        "header": { "version": header.version, "prev_block": hex::encode(header.prev_block),
                    "merkle_root": hex::encode(header.merkle_root), "timestamp": header.timestamp, "nbits": header.nbits,
                    "bytes": hex::encode(header.to_bytes()) },
        "config": { "k": k, "rank": rank, "rows": rows, "cols": cols, "bytes": hex::encode(config.to_bytes()) },
        "m": m, "n": n,
        "a_b64_row_major": b64(&flat(&a)),
        "b_b64_row_major_k_by_n": b64(&flat(&b)),
        "job_key": hex::encode(compiled.job_key),
        "hash_a": hex::encode(public.hash_a), "hash_b": hex::encode(public.hash_b),
        "b_noise_seed": hex::encode(compiled.commitment_hash.0), "a_noise_seed": hex::encode(compiled.commitment_hash.1),
        "tile_rows": compiled.a_rows_indices, "tile_cols": compiled.b_cols_indices,
        "t_rows": public.t_rows, "t_cols": public.t_cols,
        "noise_a_b64": noise.a.iter().map(|r| b64(r)).collect::<Vec<_>>(),
        "noise_b_b64": noise.b.iter().map(|r| b64(r)).collect::<Vec<_>>(),
        "jackpot": jackpot.to_vec(),
        "jackpot_hash": hex::encode(jh),
        "bound": format!("{:x}", bound),
        "plain_proof_b64": b64u(&wire),
        "tampered": tampered(&header, &proof, sd),
    })
}

fn main() {
    let rows16: Vec<u32> = (0..16).collect();
    let rows8: Vec<u32> = (0..8).collect();
    // A harder target, so the hit is on some later tile rather than the first:
    // 0x1d7fffff scaled by 16*16*2048 is about 2^250, one tile in 64.
    let later = (1u64..).find(|&s| {
        let mut r = ChaCha8Rng::seed_from_u64(s);
        let cfg = MiningConfiguration { common_dim: 2048, rank: 128, mma_type: MMAType::Int7xInt7ToInt32,
            rows_pattern: PeriodicPattern::from_list(&rows16).unwrap(), cols_pattern: PeriodicPattern::from_list(&rows16).unwrap(), moe: None };
        matches!(try_mine_one(&mut r, 128, 128, 2048, header(0x1d7f_ffff), cfg, None, false, SeedDerivation::Salted), Ok(Some(p)) if p.a.row_indices[0] != 0 || p.bt.row_indices[0] != 0)
    }).unwrap();
    let mut first = run("square-16x16-salted", 42, 64, 64, 2048, 128, &rows16, &rows16, SeedDerivation::Salted, 0x207f_ffff);
    first["honest_but_wrong"] = serde_json::json!(honest_but_wrong());
    let out = serde_json::json!([
        first,
        run("rect-8x16-salted", 7, 32, 64, 4096, 256, &rows8, &rows16, SeedDerivation::Salted, 0x207f_ffff),
        run("square-16x16-legacy", 42, 64, 64, 2048, 128, &rows16, &rows16, SeedDerivation::Legacy, 0x207f_ffff),
        run("later-tile-128x128-salted", later, 128, 128, 2048, 128, &rows16, &rows16, SeedDerivation::Salted, 0x1d7f_ffff),
    ]);
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
