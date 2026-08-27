//! `fingerprint` — the `DatasetRef.fingerprint` digest (§4.6, §6.0).
//!
//! §4.6 keys the relocate dialog on a per-dataset fingerprint, and §5 rule 3 forbids the UI thread
//! from ever seeing the file bytes, so the digest has to be taken **in the dataset worker, over the
//! bytes handed to the loader, before §5 rule 5 drops them**. This module is where it is taken, so
//! that `tvx-nifti` and `tvx-mesh-io` (and any future loader) all produce the same string by
//! construction rather than by agreement.
//!
//! **This identifies a file; it does not authenticate one.** A cryptographic digest would mean a new
//! workspace dependency (the dependency set is frozen, §12.3) and ~180 MB of SHA-256 on the load
//! path for the largest reference mesh. So the algorithm is a fully specified non-cryptographic one,
//! written out here rather than delegated to a hasher's default, because the string is persisted in
//! a `*.tetravox.json` and has to mean the same thing on every platform and in every future build.
//!
//! # `tvxfp1`, normative
//!
//! ```text
//! fingerprint(bytes) = "tvxfp1-" ++ hex16(len) ++ "-" ++ hex16(h)
//! ```
//!
//! * `len` is `bytes.len()` as a `u64`, formatted as 16 lower-case hex digits.
//! * `h` is [`FNV_OFFSET`]-seeded **FNV-1a-64** over a canonical stream, finished with MurmurHash3's
//!   `fmix64` avalanche, formatted the same way.
//! * The canonical stream is the 8 bytes of `len` **little-endian**, followed by the sampled chunks
//!   in ascending offset order.
//! * The chunks are the whole slice when `len <= `[`FULL_LIMIT`] (8 MiB); otherwise exactly three
//!   [`CHUNK`]-byte (1 MiB) windows: the first, the one starting at `len / 2 - CHUNK / 2`, and the
//!   last. Above 8 MiB those three windows never overlap, so a file is always digested over 3 MiB.
//!
//! Only `^`, `*` and shifts on `u64` are used, so the value is identical on wasm32 and on every
//! native target — the same portability argument §6.3's determinism rule makes for geometry.
//!
//! # What it can and cannot tell apart
//!
//! Two files of different length always differ, because `len` is both a field of the string and the
//! prefix of the hashed stream. Two files of the same length differ unless every one of the sampled
//! bytes agrees *and* the 64-bit hash collides. Over a file larger than 8 MiB an edit that touches
//! none of the three windows is **not** detected — that is the price of not reading 180 MB twice,
//! and it is the right trade for a dialog that asks "is this the file you moved?".
//!
//! # What is digested
//!
//! The bytes **the loader is handed**, which is after `.gz` inflation: §5 rule 4 inflates in the
//! worker, so WASM never sees the compressed stream (`packages/wasm/src/sources.ts`). A `.nii` and a
//! `.nii.gz` of the same volume therefore share a fingerprint, which is the answer §4.6 wants — the
//! dialog is matching *the dataset*, not the container it arrived in.

/// The 64-bit FNV-1a offset basis.
pub const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
/// The 64-bit FNV-1a prime.
pub const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
/// Files this size or smaller are digested whole.
pub const FULL_LIMIT: usize = 8 * 1024 * 1024;
/// The window size of each of the three samples taken from a larger file.
pub const CHUNK: usize = 1024 * 1024;
/// The algorithm tag every fingerprint string starts with.
pub const TAG: &str = "tvxfp1";

fn fnv1a(mut h: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

/// MurmurHash3's 64-bit finalizer. FNV-1a's low bits move well but its high bits are lazy; one
/// avalanche makes every output bit depend on every input byte, which is what a hex string that a
/// human compares by its first characters needs.
fn fmix64(mut h: u64) -> u64 {
    h ^= h >> 33;
    h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
    h ^= h >> 33;
    h = h.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    h ^= h >> 33;
    h
}

/// The byte ranges `tvxfp1` samples, in ascending order (§4.6).
///
/// Exposed so a test can assert the sampling rule itself rather than re-deriving it from a digest.
pub fn sample_ranges(len: usize) -> Vec<std::ops::Range<usize>> {
    // Pushed one at a time rather than built with `vec![]`: clippy reads a `vec!` whose only
    // element is a range as a botched `(0..len).collect()`, and here the range *is* the element.
    let mut out = Vec::with_capacity(3);
    if len <= FULL_LIMIT {
        out.push(0..len);
        return out;
    }
    let mid = len / 2 - CHUNK / 2;
    out.push(0..CHUNK);
    out.push(mid..mid + CHUNK);
    out.push(len - CHUNK..len);
    out
}

/// The §4.6 `DatasetRef.fingerprint` of these bytes — see the module header for `tvxfp1` in full.
pub fn fingerprint(bytes: &[u8]) -> String {
    let len = bytes.len() as u64;
    let mut h = fnv1a(FNV_OFFSET, &len.to_le_bytes());
    for r in sample_ranges(bytes.len()) {
        h = fnv1a(h, &bytes[r]);
    }
    format!("{TAG}-{len:016x}-{:016x}", fmix64(h))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cross-build pin. Computed independently in Python from the spec in the module header
    /// (FNV-1a-64 over `len` little-endian followed by the bytes, then `fmix64`), not read back out
    /// of this implementation. If this value moves, every persisted `*.tetravox.json` stops
    /// matching its dataset, so it moves only with a new `TAG`.
    #[test]
    fn known_vectors_pin_the_algorithm() {
        assert_eq!(fingerprint(b""), "tvxfp1-0000000000000000-7bd3144f29c0cc9e");
        assert_eq!(
            fingerprint(b"tetravox"),
            "tvxfp1-0000000000000008-5c8c9854af79690c"
        );
        let ramp: Vec<u8> = (0..=255u8).collect();
        assert_eq!(
            fingerprint(&ramp),
            "tvxfp1-0000000000000100-c37b22a1203f6ab0"
        );
    }

    #[test]
    fn the_same_bytes_give_the_same_string() {
        let a: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        assert_eq!(fingerprint(&a), fingerprint(&a.clone()));
    }

    #[test]
    fn one_flipped_byte_changes_it() {
        let mut a: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        let before = fingerprint(&a);
        a[2000] ^= 1;
        assert_ne!(fingerprint(&a), before);
    }

    /// The length is in the hashed stream, not only in the printed prefix: a prefix of a file and
    /// the file itself must not share a hash half either.
    #[test]
    fn a_truncated_file_differs_in_both_halves() {
        let a: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        let full = fingerprint(&a);
        let short = fingerprint(&a[..4095]);
        assert_ne!(full, short);
        let (len_a, hash_a) = full.rsplit_once('-').expect("two dashes");
        let (len_b, hash_b) = short.rsplit_once('-').expect("two dashes");
        assert_ne!(len_a, len_b);
        assert_ne!(hash_a, hash_b);
    }

    #[test]
    fn the_shape_is_the_documented_one() {
        let fp = fingerprint(&[1, 2, 3]);
        let parts: Vec<&str> = fp.split('-').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], TAG);
        assert_eq!(parts[1].len(), 16);
        assert_eq!(parts[2].len(), 16);
        assert!(parts[1..].iter().all(|p| p
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())));
        assert_eq!(parts[1], format!("{:016x}", 3u64));
    }

    /// Below the limit the whole file is read; above it, exactly three 1 MiB windows, in ascending
    /// order and non-overlapping.
    #[test]
    fn the_sampling_rule_is_the_documented_one() {
        let empty = sample_ranges(0);
        assert_eq!(empty.len(), 1);
        assert_eq!(empty[0], 0..0);
        let whole = sample_ranges(FULL_LIMIT);
        assert_eq!(whole.len(), 1);
        assert_eq!(whole[0], 0..FULL_LIMIT);
        let n = 184_207_351; // ernie.msh
        let r = sample_ranges(n);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0], 0..CHUNK);
        assert_eq!(r[2], n - CHUNK..n);
        assert!(r[0].end <= r[1].start && r[1].end <= r[2].start);
        assert!(r.iter().all(|x| x.len() == CHUNK));
        // Just past the limit the three windows still fit without overlapping.
        let r = sample_ranges(FULL_LIMIT + 1);
        assert!(r[0].end <= r[1].start && r[1].end <= r[2].start);
    }

    /// The bytes between the sampled windows are *not* read — stated as a test so the limitation is
    /// a decision on record rather than a surprise in the relocate dialog.
    #[test]
    fn an_edit_between_the_windows_of_a_large_file_is_not_seen() {
        let mut a = vec![7u8; FULL_LIMIT + 4 * CHUNK];
        let before = fingerprint(&a);
        a[CHUNK + 16] ^= 0xff;
        assert_eq!(fingerprint(&a), before);
        // …and an edit inside any of the three windows is.
        for at in [0usize, a.len() / 2, a.len() - 1] {
            let mut b = vec![7u8; a.len()];
            b[at] ^= 0xff;
            assert_ne!(fingerprint(&b), before, "edit at {at}");
        }
    }
}
