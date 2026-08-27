//! Building the §6.5 payloads as real JS objects.
//!
//! Nothing here goes through JSON. The wire types carry `NaN` (a field with gaps is filled with
//! `NaN` and `partial: true`, §6.2) and `Infinity` (a float volume's stats), neither of which JSON
//! can represent — `JSON.stringify` writes `null` and the value is silently lost. Building the
//! object with `Reflect::set` keeps every double exactly as Rust computed it.
//!
//! **Memory rule (§6.4).** Every bulk array crosses as a `js_sys::*Array::from(&slice)`, which
//! allocates a fresh JS typed array and memcpys into it — an owned buffer the worker may transfer.
//! No `*Array::view()` onto `wasm.memory.buffer` ever crosses a call boundary: `memory.grow`
//! detaches every outstanding view.

use tvx_core::FieldStats;
use wasm_bindgen::prelude::*;

pub fn obj() -> js_sys::Object {
    js_sys::Object::new()
}

/// `o[key] = v`. `Reflect::set` can only fail on a frozen or exotic target, and every target here
/// is a fresh `Object`, so the result is dropped rather than unwrapped (an unwrap would trap).
pub fn set(o: &js_sys::Object, key: &str, v: &JsValue) {
    let _ = js_sys::Reflect::set(o, &JsValue::from_str(key), v);
}

pub fn set_str(o: &js_sys::Object, key: &str, v: &str) {
    set(o, key, &JsValue::from_str(v));
}

pub fn set_f64(o: &js_sys::Object, key: &str, v: f64) {
    set(o, key, &JsValue::from_f64(v));
}

pub fn set_u32(o: &js_sys::Object, key: &str, v: u32) {
    set(o, key, &JsValue::from_f64(f64::from(v)));
}

pub fn set_usize(o: &js_sys::Object, key: &str, v: usize) {
    set(o, key, &JsValue::from_f64(v as f64));
}

pub fn set_bool(o: &js_sys::Object, key: &str, v: bool) {
    set(o, key, &JsValue::from_bool(v));
}

pub fn f32s(v: &[f32]) -> js_sys::Float32Array {
    js_sys::Float32Array::from(v)
}

pub fn u32s(v: &[u32]) -> js_sys::Uint32Array {
    js_sys::Uint32Array::from(v)
}

pub fn i32s(v: &[i32]) -> js_sys::Int32Array {
    js_sys::Int32Array::from(v)
}

pub fn u8s(v: &[u8]) -> js_sys::Uint8Array {
    js_sys::Uint8Array::from(v)
}

/// A JS array of numbers (`number[]`), for the tuple-typed members of §6.5.1.
pub fn nums<I: IntoIterator<Item = f64>>(it: I) -> js_sys::Array {
    let a = js_sys::Array::new();
    for x in it {
        a.push(&JsValue::from_f64(x));
    }
    a
}

/// `[f32; 3]` → `[number, number, number]`.
pub fn vec3(v: [f32; 3]) -> js_sys::Array {
    nums(v.iter().map(|x| f64::from(*x)))
}

/// A row-major `[[f64; 4]; 4]` → a §6.5.1 `Mat4x4`: **flat, length 16, column-major**
/// (`w[col * 4 + row] = m[row][col]`, §3). Every crossing of that boundary transposes.
pub fn mat4_from_row_major(m: &[[f64; 4]; 4]) -> js_sys::Array {
    let a = js_sys::Array::new();
    for col in 0..4 {
        for row in m.iter() {
            a.push(&JsValue::from_f64(row[col]));
        }
    }
    a
}

/// §6.5.1 `StatsT`. `histogram` is the 256-bin display histogram (§6.0 `FieldStats`).
pub fn stats(s: &FieldStats) -> js_sys::Object {
    let o = obj();
    set_f64(&o, "min", f64::from(s.min));
    set_f64(&o, "max", f64::from(s.max));
    set_f64(&o, "mean", s.mean);
    set(
        &o,
        "percentiles",
        &nums(s.percentiles.iter().map(|x| f64::from(*x))).into(),
    );
    set(&o, "histogram", &u32s(&s.histogram).into());
    set_f64(&o, "histogramLo", f64::from(s.histogram_lo));
    set_f64(&o, "histogramHi", f64::from(s.histogram_hi));
    o
}

/// §6.5.1 `LabelEntryT[]` from a [`tvx_core::LabelTable`]. Colours are RGBA 0..255 (§4.1).
pub fn label_entries(t: &tvx_core::LabelTable) -> js_sys::Array {
    let a = js_sys::Array::new();
    for e in &t.entries {
        let o = obj();
        set_u32(&o, "id", e.id);
        set_str(&o, "name", &e.name);
        set(
            &o,
            "color",
            &nums(e.color.iter().map(|c| f64::from(*c))).into(),
        );
        a.push(&o);
    }
    a
}
