//! §6.3's mandated grouping primitive: a counting sort on the **minimum vertex**, then an ordinary
//! sort inside each bucket on the remaining components.
//!
//! This exists instead of a packed key. A 3×21-bit `u64` face key aliases distinct faces on
//! `ernie_seeg.msh` (2,301,899 nodes = 22 bits) and `ernie-seeg.msh` (2,323,873 nodes) `[DATA]`,
//! silently merging them as interior and **deleting real boundary faces**. Bucketing on the minimum
//! vertex has no node-count limit at all, because the bucket index *is* a node index.
//!
//! Both users — undirected-edge adjacency (`N = 2`) and unique tet faces (`N = 3`) — go through
//! here so there is one implementation of the rule to get right.

/// Items grouped by their minimum vertex, sorted lexicographically inside each group.
pub struct MinBuckets<const N: usize> {
    /// `n_keys + 1` offsets into [`items`](Self::items).
    pub starts: Vec<u32>,
    /// The payload — everything *except* the bucket key.
    pub items: Vec<[u32; N]>,
}

impl<const N: usize> MinBuckets<N> {
    /// `emit` is called **twice**: once to count and once to place, so nothing is buffered between
    /// the two passes. It must produce exactly the same sequence both times — every caller here
    /// walks the same element array with no interior mutability, so it does.
    pub fn build(n_keys: usize, mut emit: impl FnMut(&mut dyn FnMut(u32, [u32; N]))) -> Self {
        let mut starts = vec![0u32; n_keys + 1];
        {
            let mut count = |k: u32, _v: [u32; N]| {
                starts[k as usize + 1] += 1;
            };
            emit(&mut count);
        }
        for i in 0..n_keys {
            starts[i + 1] += starts[i];
        }
        let total = starts[n_keys] as usize;
        let mut items = vec![[0u32; N]; total];
        {
            let mut cursor = starts.clone();
            let mut place = |k: u32, v: [u32; N]| {
                let i = cursor[k as usize] as usize;
                items[i] = v;
                cursor[k as usize] += 1;
            };
            emit(&mut place);
        }
        // Sorting each bucket makes equal payloads adjacent. `sort_unstable` on `[u32; N]` is
        // lexicographic over every component, so the *last* component (the owning element) breaks
        // ties in ascending order — which is what makes "the owner is the lowest-numbered element"
        // deterministic and identical on native and wasm (§6.3).
        for k in 0..n_keys {
            let (a, b) = (starts[k] as usize, starts[k + 1] as usize);
            if b - a > 1 {
                items[a..b].sort_unstable();
            }
        }
        Self { starts, items }
    }

    pub fn group(&self, key: usize) -> &[[u32; N]] {
        let (a, b) = (self.starts[key] as usize, self.starts[key + 1] as usize);
        &self.items[a..b]
    }
}

/// Walk the runs of equal *leading* `lead` components inside one bucket.
///
/// Used to find "the same undirected edge" (`lead = 1`: the other vertex) and "the same face"
/// (`lead = 2`: the two remaining vertices).
pub fn for_each_run<const N: usize>(
    items: &[[u32; N]],
    lead: usize,
    mut f: impl FnMut(&[[u32; N]]),
) {
    let mut i = 0;
    while i < items.len() {
        let mut j = i + 1;
        while j < items.len() && items[j][..lead] == items[i][..lead] {
            j += 1;
        }
        f(&items[i..j]);
        i = j;
    }
}
