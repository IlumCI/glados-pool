// Reference vectors for a browser Pearl miner, produced by Pearl's own code.
//
// 1. Mine with Pearl's `try_mine_one` on small matrices from a fixed-seed RNG, at
//    an easy target so the first tile hits.
// 2. Check the result with Pearl's `verify_plain_proof`.
// 3. Recompute the tile through Pearl's verifier functions (parse_proof ->
//    compute_noise -> compute_jackpot -> compute_jackpot_hash) and dump every
//    intermediate, plus the full A and B the RNG produced, as JSON.
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

fn b64(v: &[i8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(v.iter().map(|&x| x as u8).collect::<Vec<u8>>())
}

fn run(name: &str, seed: u64, m: usize, n: usize, k: usize, rank: u16, rows: &[u32], cols: &[u32], sd: SeedDerivation) -> serde_json::Value {
    let header = IncompleteBlockHeader {
        version: 1,
        prev_block: [0x11; 32],
        merkle_root: [0x22; 32],
        timestamp: 1_790_000_000,
        nbits: 0x207f_ffff, // easy: every tile meets it
    };
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
        .expect("the easy target should hit on the first tile");
    verify_plain_proof(&header, &proof, None, sd).expect("Pearl's verifier rejected its own proof");

    let (private, public) = proof.parse_proof(header, sd).expect("parse_proof");
    let compiled = CompiledPublicParams::from(&public);
    let noise = compute_noise(&compiled);
    let jackpot = compute_jackpot(&compiled, &private.s_a, &private.s_b, &noise);
    let jh = compute_jackpot_hash(&jackpot, compiled.commitment_hash.1);
    let bound = extract_difficulty_bound(header.nbits, &config);
    assert!(U256::from_little_endian(&jh) <= bound);

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
    })
}

fn main() {
    let rows16: Vec<u32> = (0..16).collect();
    let rows8: Vec<u32> = (0..8).collect();
    let out = serde_json::json!([
        run("square-16x16-salted", 42, 64, 64, 2048, 128, &rows16, &rows16, SeedDerivation::Salted),
        run("rect-8x16-salted", 7, 32, 64, 4096, 256, &rows8, &rows16, SeedDerivation::Salted),
        run("square-16x16-legacy", 42, 64, 64, 2048, 128, &rows16, &rows16, SeedDerivation::Legacy),
    ]);
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
