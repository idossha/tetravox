//! The handle table (§6.4).
//!
//! One worker owns exactly one wasm instance and, in practice, one dataset (§5 rule 1) — but the
//! §6.4 surface is handle-based, so the table is general. `free(handle)` drops the dataset **and
//! every mask attached to it**; giving the linear memory back is `worker.terminate()`, which is the
//! client's job (§5 rule 1).
//!
//! State that is not in the parsed file lives here too, because §6.4 exports no constructor for it:
//! the lazily built `TetBlocks` / `PointLocator` / `TetTopology`, the isolation masks, and the
//! `generation` counter §6.5 requires ("a `u32` per mesh handle, starting at 0 and incremented on
//! every successful `isolate`").
//!
//! Re-entrancy: the `RefCell` is borrowed across the long geometry calls, so a `js_sys::Function`
//! progress callback that re-entered a §6.4 export would panic on the second borrow. The worker's
//! callback only `postMessage`s (§6.5), which cannot re-enter a synchronous wasm call.

use std::cell::RefCell;
use std::collections::BTreeMap;

use tvx_core::{BitMask, Error, LabelTable, Result};
use tvx_geom::{PointLocator, TetBlocks, TetTopology};
use tvx_mesh_io::{Mesh, MshOptions};
use tvx_nifti::Volume;

/// One isolation mask, tagged with the `generation` at which it was produced. A `maskId` from an
/// older generation is `Error::Parse`, never a silent stale draw (§6.5 lifecycle rules).
pub struct MaskEntry {
    pub generation: u32,
    pub mask: BitMask,
}

/// Everything a mesh handle owns.
pub struct MeshState {
    pub mesh: Mesh,
    /// §6.3 load-time invariants. Built inside `load_mesh` when the `geom` feature is on.
    pub blocks: Option<TetBlocks>,
    pub locator: Option<PointLocator>,
    /// Set by the `buildTopology` op; `extract_boundary` uses it when present.
    pub topo: Option<TetTopology>,
    pub generation: u32,
    next_mask: u32,
    masks: BTreeMap<u32, MaskEntry>,
    /// `MeshMeta.labelTables`, keyed by node-field name (`.label.gii`, §6.5.1).
    pub label_tables: Vec<(String, LabelTable)>,
    /// The parsed `.msh.opt` sidecar, kept so `MeshMeta.opt` can be rebuilt without re-parsing.
    pub opt: Option<MshOptions>,
    /// Tag names from `$PhysicalNames` → `_LUT.txt` → `.msh.opt`, resolved once at load (§6.2).
    pub tag_names: Vec<(i32, String)>,
    /// Tag colours from the same ladder, palette-filled.
    pub tag_colors: Vec<(i32, [u8; 4])>,
}

impl MeshState {
    pub fn new(mesh: Mesh) -> Self {
        Self {
            mesh,
            blocks: None,
            locator: None,
            topo: None,
            generation: 0,
            next_mask: 1,
            masks: BTreeMap::new(),
            label_tables: Vec::new(),
            opt: None,
            tag_names: Vec::new(),
            tag_colors: Vec::new(),
        }
    }

    /// Register a freshly evaluated mask and bump the handle's generation (§6.5).
    pub fn add_mask(&mut self, mask: BitMask) -> u32 {
        self.generation = self.generation.wrapping_add(1);
        let id = self.next_mask;
        self.next_mask += 1;
        self.masks.insert(
            id,
            MaskEntry {
                generation: self.generation,
                mask,
            },
        );
        id
    }

    /// `None` for "no mask asked for". A `maskId` that is unknown, or that belongs to an older
    /// generation, is `Error::Parse` — never silently ignored.
    pub fn mask(&self, id: Option<u32>) -> Result<Option<&BitMask>> {
        let Some(id) = id else { return Ok(None) };
        match self.masks.get(&id) {
            None => Err(Error::Parse(format!(
                "mask {id} is not live on this handle"
            ))),
            Some(e) if e.generation != self.generation => Err(Error::Parse(format!(
                "mask {id} is from generation {} and the handle is at {}",
                e.generation, self.generation
            ))),
            Some(e) => Ok(Some(&e.mask)),
        }
    }

    pub fn free_mask(&mut self, id: u32) {
        self.masks.remove(&id);
    }
}

pub enum Dataset {
    Volume(Box<Volume>),
    Mesh(Box<MeshState>),
}

#[derive(Default)]
struct Registry {
    next: u32,
    map: BTreeMap<u32, Dataset>,
}

thread_local! {
    static REG: RefCell<Registry> = const { RefCell::new(Registry { next: 1, map: BTreeMap::new() }) };
}

pub fn insert(d: Dataset) -> u32 {
    REG.with(|r| {
        let mut r = r.borrow_mut();
        let h = r.next;
        r.next += 1;
        r.map.insert(h, d);
        h
    })
}

pub fn free(handle: u32) {
    REG.with(|r| {
        r.borrow_mut().map.remove(&handle);
    });
}

fn missing(handle: u32) -> Error {
    Error::Parse(format!("handle {handle} is not live in this worker"))
}

pub fn with_volume<R>(handle: u32, f: impl FnOnce(&Volume) -> Result<R>) -> Result<R> {
    REG.with(|r| match r.borrow().map.get(&handle) {
        Some(Dataset::Volume(v)) => f(v),
        Some(Dataset::Mesh(_)) => Err(Error::Parse(format!("handle {handle} is a mesh"))),
        None => Err(missing(handle)),
    })
}

pub fn with_mesh<R>(handle: u32, f: impl FnOnce(&MeshState) -> Result<R>) -> Result<R> {
    REG.with(|r| match r.borrow().map.get(&handle) {
        Some(Dataset::Mesh(m)) => f(m),
        Some(Dataset::Volume(_)) => Err(Error::Parse(format!("handle {handle} is a volume"))),
        None => Err(missing(handle)),
    })
}

pub fn with_mesh_mut<R>(handle: u32, f: impl FnOnce(&mut MeshState) -> Result<R>) -> Result<R> {
    REG.with(|r| match r.borrow_mut().map.get_mut(&handle) {
        Some(Dataset::Mesh(m)) => f(m),
        Some(Dataset::Volume(_)) => Err(Error::Parse(format!("handle {handle} is a volume"))),
        None => Err(missing(handle)),
    })
}

/// `free_mask` (§6.4). A mask that is already gone is not an error — the client frees eagerly on
/// every isolation change and a double free must not poison the module.
pub fn free_mask(handle: u32, mask_id: u32) {
    let _ = with_mesh_mut(handle, |m| {
        m.free_mask(mask_id);
        Ok(())
    });
}

/// Linear-memory high-water mark, stamped onto every `Res` (§6.5) and read by the §9.2 memory bar.
///
/// `WebAssembly.Memory` has `grow` and no shrink and Rust's wasm dlmalloc keeps freed pages, so this
/// only ever rises for the life of the worker — which is exactly why §5 mandates worker-per-dataset
/// with `terminate()`.
pub fn heap_bytes() -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        let pages = core::arch::wasm32::memory_size(0) as u64;
        (pages * 65_536).min(u64::from(u32::MAX)) as u32
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}
