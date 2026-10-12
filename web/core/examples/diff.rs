//! Same line format as the C reference harness used in stress testing:
//! "algo v10 N r pers_hex|- header_hex" in, digest hex out.
use std::io::{BufRead, Write};
use glados_web_core::{neoscrypt::Neoscrypt, yespower::Yespower};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn main() {
    let out = std::io::stdout();
    let mut out = out.lock();
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() != 6 { continue; }
        let header: [u8; 80] = unhex(f[5]).try_into().unwrap();
        let d = match f[0] {
            "yespower" => {
                let pers = if f[4] == "-" { None } else if f[4] == "E" { Some(vec![]) } else { Some(unhex(f[4])) };
                match Yespower::new(f[1] == "1", f[2].parse().unwrap(), f[3].parse().unwrap(), pers) {
                    Ok(mut y) => y.hash(&header),
                    Err(_) => { writeln!(out, "FAILED").unwrap(); continue; }
                }
            }
            "neoscrypt" => Neoscrypt::default().hash(&header),
            _ => { writeln!(out, "UNKNOWN").unwrap(); continue; }
        };
        writeln!(out, "{}", d.iter().map(|b| format!("{b:02x}")).collect::<String>()).unwrap();
    }
}
