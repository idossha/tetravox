//! [`tvx_core::ProgressSink`] over a `js_sys::Function` (§6.4).
//!
//! The callback is `(phase: string, done: number, total: number)`; the worker turns each call into
//! a §6.5 `Progress` message carrying the request's `id`.
//!
//! **`aborted()` always returns `false`.** There is no `SharedArrayBuffer` in this worker — the app
//! is not cross-origin isolated (§1) — so nothing a running wasm call could poll ever changes, and
//! while a synchronous call runs the worker's event loop cannot process a `Cancel` anyway.
//! Cancellation is `worker.terminate()` (§5 rule 6). `aborted()` survives in `tvx-core` for the
//! native/CLI build, which can flip a real `AtomicBool`.

use tvx_core::{Phase, ProgressSink};
use wasm_bindgen::prelude::*;

/// §6.5 `Phase` string for a [`tvx_core::Phase`].
pub fn phase_name(p: Phase) -> &'static str {
    match p {
        Phase::Read => "read",
        Phase::Inflate => "inflate",
        Phase::Parse => "parse",
        Phase::Topology => "topology",
        Phase::Index => "index",
        Phase::Upload => "upload",
    }
}

pub struct JsProgress<'a> {
    f: &'a js_sys::Function,
}

impl<'a> JsProgress<'a> {
    pub fn new(f: &'a js_sys::Function) -> Self {
        Self { f }
    }
}

impl ProgressSink for JsProgress<'_> {
    fn report(&mut self, phase: Phase, done: u64, total: u64) {
        // A throwing callback must not abort the parse: the result is dropped, exactly as a
        // dropped `Progress` message would be.
        let _ = self.f.call3(
            &JsValue::NULL,
            &JsValue::from_str(phase_name(phase)),
            &JsValue::from_f64(done as f64),
            &JsValue::from_f64(total as f64),
        );
    }

    fn aborted(&self) -> bool {
        false
    }
}
