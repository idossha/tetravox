//! `tvx_core::Error` → the §6.5 `WorkerError` shape, as a plain JS object.
//!
//! Every §6.4 export returns `Result<JsValue, JsValue>`; the rejected value is
//! `{ code, message }` with `code` drawn from §6.5's `ErrorCode` union. The worker copies it
//! straight into `Res.error`, so the mapping lives here and nowhere else.
//!
//! `'panic'` is deliberately **not** produced here: a Rust panic traps the module and the worker
//! sees a `WebAssembly.RuntimeError`, which is what it maps to `'panic'` (§5 rule 8).

use tvx_core::Error;
use wasm_bindgen::prelude::*;

use crate::jsv;

/// §6.5 `ErrorCode` for one `tvx_core::Error` variant.
pub fn code_of(e: &Error) -> &'static str {
    match e {
        Error::Parse(_) => "parse",
        Error::Unsupported(_) => "unsupported",
        Error::Io(_) => "io",
        Error::OutOfMemory(_) => "oom",
        Error::Cancelled => "cancelled",
    }
}

/// `{ code, message }`, the rejected half of every §6.4 export.
pub fn to_js(e: &Error) -> JsValue {
    let o = jsv::obj();
    jsv::set_str(&o, "code", code_of(e));
    jsv::set_str(&o, "message", &e.to_string());
    o.into()
}

/// `Error::Parse` as a rejected `JsValue`, for the argument checks the exports do themselves.
pub fn parse(msg: impl Into<String>) -> JsValue {
    to_js(&Error::Parse(msg.into()))
}

/// `Error::Unsupported` as a rejected `JsValue`.
pub fn unsupported(msg: impl Into<String>) -> JsValue {
    to_js(&Error::Unsupported(msg.into()))
}

/// Adapter for `?` on a `tvx_core::Result` inside an export.
pub fn map(e: Error) -> JsValue {
    to_js(&e)
}
