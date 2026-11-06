//! Every streamline of a file, in file order, in bounded chunks (§6.3.1): the parsers' streamlines are
//! drained as they close, so retained memory follows the chunk size and not the file's. Independent of
//! the display budget by construction, because this reads the file and never the held copy.

use tvx_core::{Error, Result};

use crate::builder::{lengths_of, Builder};
use crate::{Loader, Parser, SidecarLoader, TractFormat, Tractogram};

/// `offsets` start at 0; `first_source` is the file index of the first streamline.
pub struct ScanChunk {
    pub first_source: u64,
    pub offsets: Vec<u32>,
    pub positions: Vec<f32>,
    pub streamline_fields: Vec<(String, Vec<f32>)>,
    pub vertex_fields: Vec<(String, Vec<f32>)>,
}

struct Sidecar {
    loader: Option<SidecarLoader>,
    ended: bool,
    name: String,
}

pub struct TractScanner {
    loader: Option<Loader>,
    chunk_points: u32,
    fields: Vec<String>,
    /// What was loaded: its fingerprint, and the shape a sidecar is checked against.
    loaded: Tractogram,
    /// Per-streamline values held whole for the session: attached tables and TRX `dps/`.
    whole: Vec<(String, Vec<f32>)>,
    sidecars: Vec<Sidecar>,
    head: Option<ScanChunk>,
    started: bool,
    ended: bool,
    fields_checked: bool,
    next_source: u64,
    points: u64,
}

impl TractScanner {
    /// `t` is the loaded dataset whatever its budget: only its identity is read. `fields` empty is
    /// geometry only.
    pub fn new(
        t: &Tractogram,
        format: TractFormat,
        total_len: u64,
        fields: Vec<String>,
        chunk_points: u32,
    ) -> Result<Self> {
        let mut loaded = Builder::new().finish();
        loaded.source_streamlines = t.source_streamlines;
        loaded.source_points = t.source_points;
        loaded.fingerprint.clone_from(&t.fingerprint);
        Ok(Self {
            loader: Some(Loader::for_scan(format, total_len)?),
            chunk_points: chunk_points.max(1),
            fields,
            loaded,
            whole: Vec::new(),
            sidecars: Vec::new(),
            head: None,
            started: false,
            ended: false,
            fields_checked: false,
            next_source: 0,
            points: 0,
        })
    }

    fn parser(&mut self) -> &mut Parser {
        self.loader.as_mut().expect("until finish").parser_mut()
    }

    /// An attached file: a table is read to its end now, a `.tsf` as chunks come to need it.
    pub fn attach_begin(&mut self, name: &str) -> Result<u32> {
        let loader = SidecarLoader::for_scan(name, &self.loaded)?;
        self.sidecars.push(Sidecar {
            loader: Some(loader),
            ended: false,
            name: name.to_string(),
        });
        Ok(self.sidecars.len() as u32 - 1)
    }

    fn sidecar(&mut self, at: u32) -> Result<&mut Sidecar> {
        self.sidecars
            .get_mut(at as usize)
            .ok_or_else(|| Error::Parse(format!("scan sidecar {at} is not open")))
    }

    /// Does this sidecar need more bytes before the next [`Self::take`]?
    pub fn attach_hungry(&self, at: u32) -> bool {
        let Some(car) = self.sidecars.get(at as usize) else {
            return false;
        };
        let Some(loader) = car.loader.as_ref().filter(|_| !car.ended) else {
            return false;
        };
        if !loader.is_lockstep() {
            return true;
        }
        // After the last chunk, read on just far enough to catch a `.tsf` with values left over.
        let need = match &self.head {
            Some(h) => h.offsets.windows(2).filter(|w| w[1] > w[0]).count(),
            None => usize::from(self.ended),
        };
        loader.lockstep_short(need)
    }

    pub fn attach_push(&mut self, at: u32, chunk: &[u8]) -> Result<()> {
        let Self {
            sidecars, loaded, ..
        } = self;
        let car = sidecars
            .get_mut(at as usize)
            .ok_or_else(|| Error::Parse(format!("scan sidecar {at} is not open")))?;
        match &mut car.loader {
            Some(l) => l.push(loaded, chunk),
            None => Err(Error::Parse(format!("{} has ended", car.name))),
        }
    }

    /// The sidecar's bytes have run out.
    pub fn attach_end(&mut self, at: u32) -> Result<()> {
        let car = self.sidecar(at)?;
        car.ended = true;
        if car.loader.as_ref().is_some_and(SidecarLoader::is_lockstep) {
            return Ok(());
        }
        let loader = car.loader.take().expect("ends once");
        let columns = loader.finish_whole(&self.loaded)?;
        self.whole.extend(
            columns
                .into_iter()
                .filter(|(name, _)| self.fields.contains(name)),
        );
        Ok(())
    }

    fn tsf_names(&self) -> Vec<String> {
        self.sidecars
            .iter()
            .filter_map(|c| c.loader.as_ref())
            .filter(|l| l.is_lockstep())
            .map(SidecarLoader::field_name)
            .collect()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<()> {
        if !self.started {
            self.started = true;
            let tsf = self.tsf_names();
            let file_fields = self
                .fields
                .iter()
                .filter(|f| !tsf.contains(f) && !self.whole.iter().any(|(n, _)| n == *f))
                .cloned()
                .collect();
            if let Parser::Trx(p) = self.parser() {
                p.set_scan_fields(file_fields);
            }
        }
        self.loader.as_mut().expect("until finish").push(chunk)?;
        if let Parser::Trx(p) = self.parser() {
            let dps = p.take_scan_whole();
            self.whole.extend(dps);
        }
        Ok(())
    }

    /// `true` asks for the file from the start once more.
    pub fn end_pass(&mut self) -> Result<bool> {
        let again = self.loader.as_mut().expect("until finish").end_pass()?;
        self.ended = !again;
        Ok(again)
    }

    fn check_fields(&mut self) -> Result<()> {
        if self.fields_checked {
            return Ok(());
        }
        self.fields_checked = true;
        let tsf = self.tsf_names();
        let whole: Vec<String> = self.whole.iter().map(|(n, _)| n.clone()).collect();
        let fields = self.fields.clone();
        let b = self.parser().builder_mut();
        for f in &fields {
            let in_file = b.vertex_fields.iter().any(|(n, _)| n == f)
                || b.streamline_fields.iter().any(|(n, _)| n == f);
            if !in_file && !tsf.contains(f) && !whole.contains(f) && f != "length_mm" {
                return Err(Error::Parse(format!(
                    "{f} is not in this file or an attached sidecar, so a scan cannot deliver it for every streamline"
                )));
            }
        }
        Ok(())
    }

    /// Is a chunk's geometry waiting? Once `true`, feed hungry sidecars and call [`Self::take`].
    pub fn ready(&mut self) -> Result<bool> {
        if self.head.is_some() {
            return Ok(true);
        }
        let (ended, chunk_points) = (self.ended, self.chunk_points);
        let b = self.parser().builder_mut();
        let closed = b.closed_streamlines();
        if closed == 0 || (!ended && b.closed_points() < chunk_points) {
            return Ok(false);
        }
        self.check_fields()?;
        let drained = self.parser().builder_mut().drain_closed(chunk_points);
        let first_source = self.next_source;
        self.next_source += drained.offsets.len() as u64 - 1;
        self.points += u64::from(*drained.offsets.last().expect("starts with 0"));
        self.head = Some(ScanChunk {
            first_source,
            offsets: drained.offsets,
            positions: drained.positions,
            streamline_fields: drained.streamline_fields,
            vertex_fields: drained.vertex_fields,
        });
        Ok(true)
    }

    /// The waiting chunk with every requested field, or `None` when there is none.
    pub fn take(&mut self) -> Result<Option<ScanChunk>> {
        let Some(mut chunk) = self.head.take() else {
            return Ok(None);
        };
        let count = chunk.offsets.len() - 1;
        let tsf = self.tsf_names();
        let wanted = |f: &(String, Vec<f32>)| self.fields.contains(&f.0);
        chunk
            .vertex_fields
            .retain(|f| wanted(f) && !tsf.contains(&f.0));
        chunk
            .streamline_fields
            .retain(|f| wanted(f) && !self.whole.iter().any(|(n, _)| *n == f.0));
        let first = chunk.first_source as usize;
        for (name, values) in &self.whole {
            let slice = values.get(first..first + count).ok_or_else(|| {
                Error::Parse(format!(
                    "{name} holds {} values, and this file has more streamlines than that: the file changed or it was not made from this tractogram",
                    values.len()
                ))
            })?;
            chunk.streamline_fields.push((name.clone(), slice.to_vec()));
        }
        let builtin = "length_mm";
        if self.fields.iter().any(|f| f == builtin)
            && !chunk.streamline_fields.iter().any(|(n, _)| n == builtin)
        {
            chunk.streamline_fields.push((
                builtin.to_string(),
                lengths_of(&chunk.positions, &chunk.offsets),
            ));
        }
        let lengths: Vec<u32> = chunk.offsets.windows(2).map(|w| w[1] - w[0]).collect();
        for car in &mut self.sidecars {
            if let Some(l) = car.loader.as_mut().filter(|l| l.is_lockstep()) {
                let values = l.lockstep_take(chunk.first_source, &lengths)?;
                chunk.vertex_fields.push((l.field_name(), values));
            }
        }
        Ok(Some(chunk))
    }

    /// `(streamlines, points)` delivered, once the last chunk is taken. Refuses a file that is not the
    /// one loaded, which is the same check a scene's relocation makes.
    pub fn finish(mut self) -> Result<(u64, u64)> {
        self.check_fields()?;
        for car in self.sidecars.iter().filter_map(|c| c.loader.as_ref()) {
            car.lockstep_finish()?;
        }
        let t = self.loader.take().expect("finishes once").finish()?;
        if t.fingerprint != self.loaded.fingerprint {
            return Err(Error::Parse(format!(
                "the file changed since it was loaded: its fingerprint was {} and is now {}",
                self.loaded.fingerprint, t.fingerprint
            )));
        }
        Ok((self.next_source, self.points))
    }

    /// Bytes this session keeps between chunks, excluding what is whole by design (per-streamline).
    pub fn retained_bytes(&mut self) -> usize {
        self.parser().builder_mut().retained_bytes()
    }
}
