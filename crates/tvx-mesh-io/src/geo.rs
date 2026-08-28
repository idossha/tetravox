//! Gmsh **parsed post-processing** views — `.geo` / `.pos` (§6.2).
//!
//! This is not the Gmsh *scripting* language. A parsed view is a literal dump of primitives:
//!
//! ```text
//! View "electrodes" {
//! SP(71.1, 76.0, 1.2){0};
//! T3(71.1, 76.0, 6.2, 0){"E001"};
//! };
//! ```
//!
//! SimNIBS writes `m2m_*/eeg_positions/*.geo` in exactly this dialect (with an **empty, unspaced**
//! view name — `View""{` — which is why the name is `Option`-shaped and defaulted, never required).
//!
//! **Coordinates are component-major, not interleaved.** A primitive with `n` vertices lists
//! `x1..xn, y1..yn, z1..zn` and *then* — inside the braces — one value per vertex per time step.
//! Getting this wrong is silent: it only shows up for `n > 1`, so `SP` alone cannot catch it. The
//! synthetic fixture therefore carries an `ST` whose three vertices are distinguishable.
//!
//! Supported primitives (§6.2, task 6): `SP`/`VP` points, `SL`/`VL` lines, `ST`/`VT` triangles,
//! `SQ`/`VQ` quads (fanned into two triangles), `T2`/`T3` text. Everything else — `SS`/`SH`
//! tetrahedra, `TIME`, `INTERPOLATION_SCHEME` — is skipped and counted, never an error, exactly as
//! `read_msh` counts unsupported element types.
//!
//! **Vector primitives are reduced to their magnitude.** `GeoView::point_values` is one scalar per
//! vertex; a `VP`/`VL`/`VT` contributes `|v|`. The renderer's points/surface colouring is a scalar
//! colormap (§4.4), so a three-component value has nowhere to go, and keeping the raw components
//! would make the value arrays' stride depend on the primitive that produced them.
//!
//! Only the **first time step** is read. A parsed view may list several values per vertex (one per
//! step); §6.2 already rejects a multi-step `$NodeData`, and this reader takes the same line by
//! using step 0 and reporting the rest through `GeoView::time_steps`.
//!
//! A `.geo` that is a *geometry script* (`Point(1) = {…};`, `Line(…)`, `Surface(…)`) is
//! [`tvx_core::Error::Unsupported`] with a message that names the command — it is a CAD input, not
//! data, and silently returning an empty view would look like a corrupt file.

use tvx_core::{Aabb, Error, Result};

use crate::util::{parse_err, unsupported};

/// One `View "name" { … };` block of a parsed `.geo` / `.pos` file (§6.2).
///
/// Every geometric array is **de-indexed** — a parsed view has no node table, so points, line
/// endpoints and triangle corners are independent world-mm positions.
#[derive(Clone, Debug, PartialEq)]
pub struct GeoView {
    /// The quoted name, verbatim. SimNIBS writes `View""`, so this is routinely empty.
    pub name: String,
    /// `SP`/`VP` positions, world mm.
    pub points: Vec<[f32; 3]>,
    /// One scalar per entry of [`GeoView::points`] (magnitude for `VP`).
    pub point_values: Vec<f32>,
    /// `T2`/`T3` anchors and their strings, in file order. A `T3` with several strings contributes
    /// one entry per string, all at the same anchor.
    pub labels: Vec<([f32; 3], String)>,
    /// `SL`/`VL` segments, 2 endpoints each.
    pub lines: Vec<[[f32; 3]; 2]>,
    /// 2 scalars per entry of [`GeoView::lines`] — one per endpoint.
    pub line_values: Vec<f32>,
    /// `ST`/`VT` triangles, plus the two-triangle fan of every `SQ`/`VQ`.
    pub tris: Vec<[[f32; 3]; 3]>,
    /// 3 scalars per entry of [`GeoView::tris`] — one per corner.
    pub tri_values: Vec<f32>,
    /// `(primitive name, count)` for primitives this reader drops, like [`crate::Mesh::skipped`].
    pub skipped: Vec<(String, u64)>,
    /// Values per vertex found in the braces of the first primitive that had any — i.e. the number
    /// of time steps. Only step 0 is read.
    pub time_steps: usize,
    /// Over points, line endpoints, triangle corners **and label anchors**. The anchors count
    /// because they are drawn: SimNIBS puts each electrode's `T3` 5 mm above its `SP`, so a box
    /// that excluded them would frame the net with its labels clipped.
    ///
    /// Degenerate (`min > max`) only if the view is entirely empty, which `read_view` normalises
    /// to the origin box.
    pub bounds: Aabb,
}

impl Default for GeoView {
    fn default() -> Self {
        GeoView {
            name: String::new(),
            points: Vec::new(),
            point_values: Vec::new(),
            labels: Vec::new(),
            lines: Vec::new(),
            line_values: Vec::new(),
            tris: Vec::new(),
            tri_values: Vec::new(),
            skipped: Vec::new(),
            time_steps: 0,
            // Degenerate on purpose: `grow` folds real vertices into it, and a view with none
            // is normalised to the origin box by `read_view`.
            bounds: Aabb {
                min: [f32::INFINITY; 3],
                max: [f32::NEG_INFINITY; 3],
            },
        }
    }
}

impl GeoView {
    fn is_empty(&self) -> bool {
        self.points.is_empty() && self.lines.is_empty() && self.tris.is_empty()
    }
}

/// Vertex count and value-components-per-vertex of a supported primitive.
fn primitive(tag: &str) -> Option<(usize, usize)> {
    Some(match tag {
        "SP" => (1, 1),
        "VP" => (1, 3),
        "SL" => (2, 1),
        "VL" => (2, 3),
        "ST" => (3, 1),
        "VT" => (3, 3),
        "SQ" => (4, 1),
        "VQ" => (4, 3),
        _ => return None,
    })
}

/// Geometry-script commands that make a `.geo` a CAD input rather than a parsed view.
const GEOMETRY_COMMANDS: [&str; 8] = [
    "Point", "Line", "Surface", "Volume", "Circle", "Spline", "Physical", "Extrude",
];

// ---------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------

/// A cursor that knows the three things this grammar needs: whitespace/comments are free, an
/// identifier runs to the first non-alphanumeric, and a quoted string may contain `\"`.
struct Lexer<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Lexer<'a> {
    fn new(b: &'a [u8]) -> Self {
        Lexer { b, pos: 0 }
    }

    /// Skip whitespace, `//` line comments and `/* … */` block comments.
    fn skip_ws(&mut self) {
        loop {
            while self.pos < self.b.len() && self.b[self.pos].is_ascii_whitespace() {
                self.pos += 1;
            }
            if self.b[self.pos..].starts_with(b"//") {
                while self.pos < self.b.len() && self.b[self.pos] != b'\n' {
                    self.pos += 1;
                }
                continue;
            }
            if self.b[self.pos..].starts_with(b"/*") {
                self.pos += 2;
                while self.pos < self.b.len() && !self.b[self.pos..].starts_with(b"*/") {
                    self.pos += 1;
                }
                self.pos = (self.pos + 2).min(self.b.len());
                continue;
            }
            return;
        }
    }

    fn eof(&mut self) -> bool {
        self.skip_ws();
        self.pos >= self.b.len()
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.b.get(self.pos).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.pos += 1;
            return true;
        }
        false
    }

    fn expect(&mut self, c: u8) -> Result<()> {
        if self.eat(c) {
            return Ok(());
        }
        Err(parse_err(format!(
            "expected `{}` at byte {}, found {}",
            c as char,
            self.pos,
            self.here()
        )))
    }

    /// A short quoted excerpt of what is at the cursor, for error messages.
    fn here(&self) -> String {
        let end = (self.pos + 24).min(self.b.len());
        format!("{:?}", String::from_utf8_lossy(&self.b[self.pos..end]))
    }

    /// `[A-Za-z_][A-Za-z0-9_]*`, or `""` when the cursor is not on one.
    fn ident(&mut self) -> &'a str {
        self.skip_ws();
        let start = self.pos;
        if self
            .b
            .get(self.pos)
            .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
        {
            self.pos += 1;
            while self
                .b
                .get(self.pos)
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
            {
                self.pos += 1;
            }
        }
        std::str::from_utf8(&self.b[start..self.pos]).unwrap_or("")
    }

    /// A `"…"` string with `\"` escapes. The cursor must be on the opening quote.
    fn string(&mut self) -> Result<String> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let c = *self
                .b
                .get(self.pos)
                .ok_or_else(|| parse_err("unterminated string"))?;
            self.pos += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let n = *self
                        .b
                        .get(self.pos)
                        .ok_or_else(|| parse_err("unterminated escape"))?;
                    self.pos += 1;
                    out.push(n as char);
                }
                _ => out.push(c as char),
            }
        }
    }

    /// A decimal number, scientific notation included.
    fn number(&mut self) -> Result<f64> {
        self.skip_ws();
        let start = self.pos;
        if matches!(self.b.get(self.pos), Some(b'+' | b'-')) {
            self.pos += 1;
        }
        while self
            .b
            .get(self.pos)
            .is_some_and(|c| c.is_ascii_digit() || *c == b'.')
        {
            self.pos += 1;
        }
        if matches!(self.b.get(self.pos), Some(b'e' | b'E')) {
            let save = self.pos;
            self.pos += 1;
            if matches!(self.b.get(self.pos), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if self.b.get(self.pos).is_some_and(u8::is_ascii_digit) {
                while self.b.get(self.pos).is_some_and(u8::is_ascii_digit) {
                    self.pos += 1;
                }
            } else {
                // `1e` followed by something else: the `e` was not an exponent after all.
                self.pos = save;
            }
        }
        match std::str::from_utf8(&self.b[start..self.pos])
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
        {
            Some(n) => Ok(n),
            None => {
                self.pos = start;
                Err(parse_err(format!(
                    "expected a number at byte {start}, found {}",
                    self.here()
                )))
            }
        }
    }

    /// Skip a balanced `(`…`)` or `{`…`}` run, strings included. Used for primitives we drop.
    fn skip_balanced(&mut self, open: u8, close: u8) -> Result<()> {
        self.expect(open)?;
        let mut depth = 1usize;
        while depth > 0 {
            match self.b.get(self.pos) {
                None => return Err(parse_err("unbalanced brackets")),
                Some(b'"') => {
                    self.string()?;
                    continue;
                }
                Some(c) if *c == open => depth += 1,
                Some(c) if *c == close => depth -= 1,
                Some(_) => {}
            }
            self.pos += 1;
        }
        Ok(())
    }
}

/// `View` is the first token — the only way a parsed view starts, and a token a geometry script
/// never opens with. Deliberately *not* keyed on the extension, which both `.geo` dialects share.
/// Comments before it are free, which is why this reuses the lexer instead of a byte prefix test.
pub fn looks_like_view(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(4096)];
    let mut lx = Lexer::new(head);
    lx.skip_ws();
    head[lx.pos.min(head.len())..].starts_with(b"View")
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

/// Read every `View` block of a parsed `.geo` / `.pos` file.
pub fn read(bytes: &[u8]) -> Result<Vec<GeoView>> {
    reject_geometry_script(bytes)?;
    let mut lx = Lexer::new(bytes);
    let mut views: Vec<GeoView> = Vec::new();

    while !lx.eof() {
        let kw = lx.ident();
        if kw.is_empty() {
            return Err(parse_err(format!(
                "expected `View` at byte {}, found {}",
                lx.pos,
                lx.here()
            )));
        }
        // Gmsh **option statements** — `myView = PostProcessing.NbViews-1;`,
        // `View[myView].PointSize = 6;` — trail every net SimNIBS writes except the smallest.
        // They are display hints for Gmsh's own GUI, not data, and §7.4 owns point size here, so
        // they are skipped to the statement terminator rather than parsed. Anything else at top
        // level is a file this reader has no business guessing at.
        if kw != "View" || matches!(lx.peek(), Some(b'[' | b'=')) {
            if kw != "View" && !matches!(lx.peek(), Some(b'[' | b'=' | b'.')) {
                return Err(unsupported(format!(
                    "`{kw}` is not a parsed post-processing view; only `View \"…\" {{ … }};` blocks \
                     and Gmsh option statements are read"
                )));
            }
            skip_statement(&mut lx)?;
            continue;
        }
        views.push(read_view(&mut lx)?);
    }

    if views.is_empty() {
        return Err(parse_err("no `View` block in this file"));
    }
    Ok(views)
}

/// Skip a Gmsh option statement to its `;`, brackets and strings balanced.
fn skip_statement(lx: &mut Lexer<'_>) -> Result<()> {
    loop {
        match lx.peek() {
            None => return Ok(()),
            Some(b';') => {
                lx.pos += 1;
                return Ok(());
            }
            Some(b'"') => {
                lx.string()?;
            }
            Some(b'[') => lx.skip_balanced(b'[', b']')?,
            Some(b'{') => lx.skip_balanced(b'{', b'}')?,
            Some(_) => lx.pos += 1,
        }
    }
}

/// `View "name" { primitives };` — the cursor is just past `View`.
fn read_view(lx: &mut Lexer<'_>) -> Result<GeoView> {
    let mut v = GeoView {
        name: lx.string()?,
        bounds: Aabb {
            min: [f32::INFINITY; 3],
            max: [f32::NEG_INFINITY; 3],
        },
        ..GeoView::default()
    };
    lx.expect(b'{')?;

    while !lx.eat(b'}') {
        if lx.eof() {
            return Err(parse_err("unterminated `View` block"));
        }
        let tag = lx.ident();
        if tag.is_empty() {
            return Err(parse_err(format!(
                "expected a primitive at byte {}, found {}",
                lx.pos,
                lx.here()
            )));
        }
        match tag {
            "T2" | "T3" => read_text(lx, tag, &mut v)?,
            _ => match primitive(tag) {
                Some((nverts, ncomp)) => read_primitive(lx, tag, nverts, ncomp, &mut v)?,
                None => {
                    // Unsupported primitive or a view attribute (`TIME`, `INTERPOLATION_SCHEME`):
                    // skip its parenthesised header, if any, and its braced payload.
                    if lx.peek() == Some(b'(') {
                        lx.skip_balanced(b'(', b')')?;
                    }
                    if lx.peek() == Some(b'{') {
                        lx.skip_balanced(b'{', b'}')?;
                    }
                    bump(&mut v.skipped, tag);
                }
            },
        }
        // Primitive separators are free: Gmsh writes `;`, but a run of them is not an error.
        while lx.eat(b';') {}
    }
    lx.eat(b';');

    if v.is_empty() && v.labels.is_empty() {
        v.bounds = Aabb {
            min: [0.0; 3],
            max: [0.0; 3],
        };
    }
    Ok(v)
}

/// `SP(x…,y…,z…){v…};` — component-major coordinates, then one value per vertex per time step.
fn read_primitive(
    lx: &mut Lexer<'_>,
    tag: &str,
    nverts: usize,
    ncomp: usize,
    v: &mut GeoView,
) -> Result<()> {
    lx.expect(b'(')?;
    let mut coords = vec![0f64; nverts * 3];
    for axis in 0..3 {
        for i in 0..nverts {
            if axis + i > 0 {
                lx.expect(b',')?;
            }
            // Component-major: `x1..xn, y1..yn, z1..zn`.
            coords[i * 3 + axis] = lx.number()?;
        }
    }
    lx.expect(b')')?;

    let values = read_values(lx, nverts * ncomp, v)?;
    // One scalar per vertex: the value itself, or the magnitude of a vector one.
    let scalar = |i: usize| -> f32 {
        if ncomp == 1 {
            values
                .first()
                .map_or(0.0, |first| *first.get(i).unwrap_or(&0.0)) as f32
        } else {
            let step = values.first().map(Vec::as_slice).unwrap_or(&[]);
            let g = |k: usize| *step.get(i * ncomp + k).unwrap_or(&0.0);
            ((g(0) * g(0) + g(1) * g(1) + g(2) * g(2)) as f32).sqrt()
        }
    };
    let vert = |i: usize| -> [f32; 3] {
        [
            coords[i * 3] as f32,
            coords[i * 3 + 1] as f32,
            coords[i * 3 + 2] as f32,
        ]
    };

    match nverts {
        1 => {
            v.points.push(vert(0));
            v.point_values.push(scalar(0));
        }
        2 => {
            v.lines.push([vert(0), vert(1)]);
            v.line_values.push(scalar(0));
            v.line_values.push(scalar(1));
        }
        3 => {
            v.tris.push([vert(0), vert(1), vert(2)]);
            v.tri_values
                .extend_from_slice(&[scalar(0), scalar(1), scalar(2)]);
        }
        4 => {
            // Fan: (0,1,2) + (0,2,3), the triangulation Gmsh itself draws a `SQ` with.
            v.tris.push([vert(0), vert(1), vert(2)]);
            v.tri_values
                .extend_from_slice(&[scalar(0), scalar(1), scalar(2)]);
            v.tris.push([vert(0), vert(2), vert(3)]);
            v.tri_values
                .extend_from_slice(&[scalar(0), scalar(2), scalar(3)]);
        }
        _ => return Err(parse_err(format!("primitive `{tag}` has no triangulation"))),
    }
    for i in 0..nverts {
        grow(&mut v.bounds, vert(i));
    }
    Ok(())
}

/// `T3(x,y,z,style){"a","b"};` / `T2(x,y,style){"a"};`. The style int is read and discarded —
/// it packs Gmsh's font/alignment bits, which the overlay pass does not honour (§7.2).
fn read_text(lx: &mut Lexer<'_>, tag: &str, v: &mut GeoView) -> Result<()> {
    lx.expect(b'(')?;
    let naxes = if tag == "T3" { 3 } else { 2 };
    let mut pos = [0f32; 3];
    for (axis, slot) in pos.iter_mut().enumerate().take(naxes) {
        if axis > 0 {
            lx.expect(b',')?;
        }
        *slot = lx.number()? as f32;
    }
    lx.expect(b',')?;
    let _style = lx.number()?;
    lx.expect(b')')?;

    lx.expect(b'{')?;
    loop {
        // A text primitive's payload is strings; a leading number is Gmsh's "text is in the
        // string table at index n" form, which no writer we read emits.
        let s = lx.string()?;
        v.labels.push((pos, s));
        if !lx.eat(b',') {
            break;
        }
    }
    lx.expect(b'}')?;
    grow(&mut v.bounds, pos);
    Ok(())
}

/// `{ v… }` — `per_step` values per time step, all steps read so `time_steps` is honest, but only
/// step 0 is returned to the caller in a shape it uses.
fn read_values(lx: &mut Lexer<'_>, per_step: usize, v: &mut GeoView) -> Result<Vec<Vec<f64>>> {
    lx.expect(b'{')?;
    let mut all: Vec<f64> = Vec::with_capacity(per_step);
    if lx.peek() != Some(b'}') {
        loop {
            all.push(lx.number()?);
            if !lx.eat(b',') {
                break;
            }
        }
    }
    lx.expect(b'}')?;
    if per_step == 0 || all.is_empty() {
        return Ok(vec![Vec::new()]);
    }
    if !all.len().is_multiple_of(per_step) {
        return Err(parse_err(format!(
            "primitive has {} values, not a multiple of {per_step} per time step",
            all.len()
        )));
    }
    let steps = all.len() / per_step;
    if v.time_steps == 0 {
        v.time_steps = steps;
    }
    Ok(all.chunks(per_step).map(<[f64]>::to_vec).collect())
}

fn bump(skipped: &mut Vec<(String, u64)>, tag: &str) {
    if let Some(e) = skipped.iter_mut().find(|e| e.0 == tag) {
        e.1 += 1;
    } else {
        skipped.push((tag.to_string(), 1));
    }
}

fn grow(bb: &mut Aabb, p: [f32; 3]) {
    for (a, v) in p.iter().enumerate() {
        bb.min[a] = bb.min[a].min(*v);
        bb.max[a] = bb.max[a].max(*v);
    }
}

/// A `.geo` holding CAD commands is out of scope (§6.2, task 6) — say so, and say which command.
///
/// The scan is over the raw bytes rather than the token stream on purpose: it must fire *before*
/// the parser reaches its own "expected `View`" error, so the message names `Point(` rather than a
/// byte offset. `View` blocks contain no `Ident(` construct, so a false positive would need a view
/// *name* like `"Point("` — which is why the check skips quoted strings and comments.
fn reject_geometry_script(bytes: &[u8]) -> Result<()> {
    let mut lx = Lexer::new(bytes);
    while !lx.eof() {
        match lx.peek() {
            Some(b'"') => {
                lx.string()?;
                continue;
            }
            Some(c) if c.is_ascii_alphabetic() || c == b'_' => {}
            Some(_) => {
                lx.pos += 1;
                continue;
            }
            None => break,
        }
        let id = lx.ident();
        if GEOMETRY_COMMANDS.contains(&id) && lx.peek() == Some(b'(') {
            return Err(Error::Unsupported(format!(
                "this is a Gmsh geometry script, not a post-processing view: it contains `{id}(`. \
                 Tetravox reads parsed views only — `View \"name\" {{ SP(…){{…}}; … }};` — as written by \
                 SimNIBS's eeg_positions and by Gmsh's `Save As … .pos`. Mesh the script with gmsh first."
            )));
        }
        if id == "View" {
            // Past the first view header there is nothing left to misread as a command.
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(src: &str) -> GeoView {
        let mut v = read(src.as_bytes()).expect("parse");
        assert_eq!(v.len(), 1);
        v.remove(0)
    }

    #[test]
    fn simnibs_dialect_empty_unspaced_name() {
        let v = one("View\"\"{\nSP(1,2,3){0};\nT3(1,2,8,0){\"E001\"};\n};\n");
        assert_eq!(v.name, "");
        assert_eq!(v.points, vec![[1.0, 2.0, 3.0]]);
        assert_eq!(v.point_values, vec![0.0]);
        assert_eq!(v.labels, vec![([1.0, 2.0, 8.0], "E001".to_string())]);
    }

    /// Component-major coordinates: `x1,x2,x3, y1,y2,y3, z1,z2,z3`. The one rule a `SP`-only
    /// fixture cannot catch.
    #[test]
    fn triangle_coordinates_are_component_major() {
        let v = one("View \"t\" { ST(0,1,0, 0,0,1, 0,0,0){10,20,30}; };");
        assert_eq!(
            v.tris,
            vec![[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]]
        );
        assert_eq!(v.tri_values, vec![10.0, 20.0, 30.0]);
        assert_eq!(v.bounds.min, [0.0, 0.0, 0.0]);
        assert_eq!(v.bounds.max, [1.0, 1.0, 0.0]);
    }

    #[test]
    fn lines_quads_and_scientific_notation() {
        let v = one("View \"m\" {\n\
             SL(0,1e2, 0,0, 0,0){1,2};\n\
             SQ(0,1,1,0, 0,0,1,1, 5,5,5,5){1,2,3,4};\n\
             };");
        assert_eq!(v.lines, vec![[[0.0, 0.0, 0.0], [100.0, 0.0, 0.0]]]);
        assert_eq!(v.line_values, vec![1.0, 2.0]);
        // A quad is a two-triangle fan (0,1,2)+(0,2,3), values carried per corner.
        assert_eq!(v.tris.len(), 2);
        assert_eq!(
            v.tris[1],
            [[0.0, 0.0, 5.0], [1.0, 1.0, 5.0], [0.0, 1.0, 5.0]]
        );
        assert_eq!(v.tri_values, vec![1.0, 2.0, 3.0, 1.0, 3.0, 4.0]);
    }

    #[test]
    fn vector_primitives_reduce_to_magnitude() {
        let v = one("View \"v\" { VP(0,0,0){3,4,0}; };");
        assert_eq!(v.point_values, vec![5.0]);
    }

    #[test]
    fn several_views_per_file_and_free_whitespace() {
        let vs =
            read(b"View \"a\"{SP(0,0,0){1};};View\n\"b\"\n{\nSP(1,1,1){2};\n}\n;").expect("parse");
        assert_eq!(vs.len(), 2);
        assert_eq!(vs[0].name, "a");
        assert_eq!(vs[1].point_values, vec![2.0]);
    }

    #[test]
    fn unsupported_primitives_are_counted_not_fatal() {
        let v = one("View \"s\" { SP(0,0,0){1}; SS(0,0,0,0, 0,0,0,0, 0,0,0,0){1,2,3,4}; };");
        assert_eq!(v.points.len(), 1);
        assert_eq!(v.skipped, vec![("SS".to_string(), 1)]);
    }

    #[test]
    fn comments_are_free() {
        let v = one("// lead\nView \"c\" { /* mid */ SP(0,0,0){7}; };");
        assert_eq!(v.point_values, vec![7.0]);
    }

    #[test]
    fn multi_step_values_take_step_zero() {
        let v = one("View \"t\" { SP(0,0,0){1,2,3}; };");
        assert_eq!(v.point_values, vec![1.0]);
        assert_eq!(v.time_steps, 3);
    }

    #[test]
    fn geometry_script_is_unsupported_with_a_clear_message() {
        let err = read(b"lc = 1e-2;\nPoint(1) = {0, 0, 0, lc};\nLine(1) = {1, 2};\n").unwrap_err();
        let msg = err.to_string();
        assert!(matches!(err, Error::Unsupported(_)), "{msg}");
        assert!(msg.contains("`Point(`"), "{msg}");
        assert!(msg.contains("geometry script"), "{msg}");
    }

    #[test]
    fn surface_command_is_also_rejected() {
        let err = read(b"Surface(1) = {1};").unwrap_err();
        assert!(matches!(err, Error::Unsupported(_)));
    }

    #[test]
    fn a_file_with_no_view_is_a_parse_error() {
        assert!(matches!(read(b"   \n"), Err(Error::Parse(_))));
    }

    #[test]
    fn negative_and_exponent_coordinates() {
        let v = one("View \"n\" { SP(-1.5e-2, +2.0, 3.){0}; };");
        assert!((v.points[0][0] - -0.015).abs() < 1e-9);
        assert_eq!(v.points[0][1], 2.0);
        assert_eq!(v.points[0][2], 3.0);
    }
}
