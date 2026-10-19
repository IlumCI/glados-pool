// Pearl's own verdict on proofs a miner built: reads [{name, header (76-byte
// hex), proof_b64}] on stdin, and for each runs verify_plain_proof at an
// always-met target (the structure is what is under test; a pool sets the
// real bound) and recomputes the jackpot hash through Pearl's functions.
use base64::Engine;
use std::io::Read;
use zk_pow::api::proof::IncompleteBlockHeader;
use zk_pow::api::proof_utils::{CompiledPublicParams, compute_jackpot_hash};
use zk_pow::api::seed::SeedDerivation;
use zk_pow::api::verify::verify_plain_proof;
use zk_pow::circuit::chip::jackpot::helper::compute_jackpot;
use zk_pow::circuit::pearl_noise::compute_noise;
use zk_pow::ffi::plain_proof::PlainProof;

fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let items: Vec<serde_json::Value> = serde_json::from_str(&s).unwrap();
    let mut out = Vec::new();
    for it in items {
        let name = it["name"].as_str().unwrap().to_string();
        let hb = hex::decode(it["header"].as_str().unwrap()).unwrap();
        // The header exactly as mined: its nbits is part of the job key. The
        // target is relaxed through verify_plain_proof's own override instead.
        let header = IncompleteBlockHeader::from_bytes(&hb).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(it["proof_b64"].as_str().unwrap()).unwrap();
        let verdict = match bincode::deserialize::<PlainProof>(&bytes) {
            Err(e) => serde_json::json!({ "name": name, "accepts": false, "why": format!("bincode: {e}") }),
            Ok(p) => match verify_plain_proof(&header, &p, Some(0x207f_ffff), SeedDerivation::Salted) {
                Err(e) => serde_json::json!({ "name": name, "accepts": false, "why": format!("{e:#}") }),
                Ok(()) => {
                    let (private, public) = p.parse_proof(header, SeedDerivation::Salted).unwrap();
                    let c = CompiledPublicParams::from(&public);
                    let jh = compute_jackpot_hash(&compute_jackpot(&c, &private.s_a, &private.s_b, &compute_noise(&c)), c.commitment_hash.1);
                    serde_json::json!({ "name": name, "accepts": true, "jackpot_hash": hex::encode(jh) })
                }
            },
        };
        out.push(verdict);
    }
    println!("{}", serde_json::to_string(&out).unwrap());
}
