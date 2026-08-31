/**
 * `@tetravox/module-sdk` — the runtime half of the SDK, and the only file in it that executes.
 *
 * **Zero imports, by construction.** A downloadable module is one ESM file that the renderer loads
 * over `tetravox://module/<id>/<version>/index.js` (ARCHITECTURE.md §13.8). Nothing resolves bare
 * specifiers there — there is no import map, no node_modules and no `script-src` grant for anything
 * else — so a module bundle that still carries `import { createElement } from 'react'` fails at load
 * with a specifier error, not with a diagnosis. The module repo's CI therefore asserts the bundle
 * has **no imports at all**, and this file is what makes that possible: it is *inlined* by the
 * module build (never marked external), and it reaches the host through one global instead.
 *
 * **Why a global rather than an import map or a served URL.** A module's `Panel` renders inside the
 * app's own React tree, so a second React copy is an "invalid hook call", not a size problem. The
 * three ways to hand a downloaded bundle the host's React are an inline `<script type="importmap">`
 * (which needs `script-src 'unsafe-inline'` or a nonce and undoes the policy the module host exists
 * to keep), a rollup `output.paths` rewrite onto a second non-hashed renderer entry (which needs a
 * new `entryFileNames` rule in `electron.vite.config.ts`), and this one — which needs no build
 * configuration at all and leaves `script-src 'self' 'wasm-unsafe-eval' tetravox://module` as the
 * single CSP change. `docs/DECISIONS.md` records the choice and names the rollup rewrite as the
 * fallback if the global ever has to be scoped per module.
 *
 * **The app half is one assignment**, made by the renderer before any module is activated:
 *
 * ```ts
 * globalThis.__tetravoxModuleSdk = {
 *   hostVersion: MODULE_HOST_VERSION,
 *   react,                       // the app's own copy — the whole namespace
 *   ModuleHostError,             // the class, so `instanceof` holds across the boundary
 *   stemOf,                      // `src/modules/manifest-types.ts`, the one definition
 *   contacts,                    // `renderer/src/modules/shared/contacts/**`, as one namespace
 * };
 * ```
 *
 * Every member is a *value the host already owns*. The SDK adds no behaviour of its own: it is a
 * typed doorway, so a module written against it is typechecked against the same declarations the
 * app is built from.
 */
const sdk = globalThis.__tetravoxModuleSdk;
if (sdk === undefined) {
    throw new Error('Tetravox SDK: globalThis.__tetravoxModuleSdk is not set. This bundle is not running inside a ' +
        'Tetravox module host — check that the app is at least the core version this SDK was emitted ' +
        'from, and that the bundle was loaded through tetravox://module/.');
}
/**
 * The whole React namespace, for anything the named exports below do not cover.
 *
 * The named ones exist because they are what a panel actually writes, and because a named import is
 * what tree-shaking and a reader both understand.
 */
const react = sdk.react;
const createElement = sdk.react.createElement;
const useSyncExternalStore = sdk.react.useSyncExternalStore;
sdk.react.useState;
sdk.react.useEffect;
sdk.react.useMemo;
sdk.react.useRef;
sdk.react.useCallback;
/**
 * The host's `ModuleHostError` **class**, not a copy of it.
 *
 * A module throws it and the host catches it; a second class declaration would make every
 * `instanceof` across that boundary false, which is exactly the failure the class exists to prevent.
 */
const ModuleHostError = sdk.ModuleHostError;
/** `{stem}` — the one definition (`src/modules/manifest-types.ts`), shared with main. */
const stemOf = sdk.stemOf;
/**
 * The `shared/contacts` kit, as one namespace.
 *
 * It stays in core (ARCHITECTURE.md §13.3: "a module's second module is a library, not a fork"), so
 * two contact modules share one implementation of a TSV reader, an editlog and a shaft fit rather
 * than forking it. Reached through the host for the same reason React is: one instance.
 */
const contacts = sdk.contacts;
/** The host API version this app implements. Compare it with your manifest's `hostApi`. */
sdk.hostVersion;

/**
 * The geometry of a **depth electrode**, as opposed to the geometry of any contact set.
 *
 * The SDK's contacts kit (`contacts.fitLine`) fits the line; this file knows what an sEEG shaft
 * *is*: a rigid rod pushed through the skull, contacts evenly spaced along it, numbered **1 at the
 * deepest end**. Every rule below is a fact about that hardware and about a head, which is exactly
 * why none of it belongs in the shared kit — that kit stays in the app and serves every contact
 * module, and a second contact module is a library's user, not a fork.
 *
 * ## The tip rule, stated
 *
 * Slicer's `_tipSign` is a **stub**: its docstring describes a heuristic and its body is
 * `return 1.0  # neutral default`, so "Renumber tip-first" there numbers from whichever end the line
 * fit happened to point at, and the module's own README lists "verify contact 1 = deepest" as a known
 * limitation. This build implements the heuristic the docstring describes, and states it:
 *
 * > **Contact 1 is the end of the shaft nearer the reference centre; the entry is the end farther
 * > from it.** The reference is the centre of the bound volume's bounding box — the head, near
 * > enough — falling back to the centroid of every contact in the set when there is no volume.
 *
 * Why that reference and not the electrode's own centroid: a shaft's own centroid lies *between* its
 * ends, so both ends are about equidistant from it and the rule would be a coin toss. The head's
 * centre is the thing "deep" is measured against, and every shaft is inserted from the outside
 * inward. It is a **heuristic**, not a brain mask: an occipital shaft entering close to the midline
 * can defeat it, which is why the tip is shown in the panel, `t` flips it, and **nothing renumbers
 * implicitly** — see below.
 *
 * ## What renumbers, and what does not
 *
 * Only **Re-fit** and **Renumber tip-first** ever change a contact's number or name. Loading a table,
 * placing a contact, dragging one, snapping and deleting all leave the numbering exactly as it was.
 * So a clinical table's numbering — which is wired to the recording system through `csc` — can only
 * be changed by a button that says it changes it. Re-fit relabels because that is what Slicer's
 * Re-fit does and what its label promises; it does not re-derive the tip, it uses the electrode's
 * current one.
 */
const { centroidOf, contactName: contactName$1, contactsOf: contactsOf$1, distanceMm, fitLine, lineMetrics, orderAlong, respaceEven, } = contacts;
/** Two ends that are this close to equidistant from the reference are a tie, in millimetres. */
const TIP_TIE_MM = 1e-6;
/** Which end of the fitted line is the tip, by the heuristic above. `'low'` on a tie or no fit. */
function tipEnd(positions, reference) {
    const fit = fitLine(positions);
    if (fit === null)
        return "low";
    const order = orderAlong(positions);
    const low = positions[order[0]];
    const high = positions[order[order.length - 1]];
    const dLow = distanceMm(low, reference);
    const dHigh = distanceMm(high, reference);
    // Nearer the head's centre is deeper. A tie keeps the low end, so the rule is total.
    return dHigh < dLow - TIP_TIE_MM ? "high" : "low";
}
/** The end this electrode is numbered from: what the user pinned, or the heuristic. */
function resolveTip(group, positions, reference) {
    return group.tip === "auto" ? tipEnd(positions, reference) : group.tip;
}
/** `t` — pin the other end, whichever one is currently in force. Never `'auto'` again. */
function flippedTip(group, positions, reference) {
    return resolveTip(group, positions, reference) === "low" ? "high" : "low";
}
/**
 * The reference the tip rule measures "deep" against.
 *
 * The centre of the bound volume's bounds when there is one, and otherwise the centroid of every
 * contact in the set — which is a poor proxy for one electrode and a decent one for a whole implant.
 */
function tipReference(bounds, set) {
    if (bounds !== null) {
        return [
            (bounds.min[0] + bounds.max[0]) / 2,
            (bounds.min[1] + bounds.max[1]) / 2,
            (bounds.min[2] + bounds.max[2]) / 2,
        ];
    }
    return centroidOf(set.contacts.map((c) => c.position)) ?? [0, 0, 0];
}
/** The contacts of `group`, ordered from the tip outward. */
function tipFirstOrder(contacts, tip) {
    const order = orderAlong(contacts.map((c) => c.position));
    const along = order.map((index) => contacts[index]);
    return tip === "low" ? along : along.reverse();
}
function shaftStats(set, group) {
    const contacts = contactsOf$1(set, group);
    const metrics = lineMetrics(contacts.map((c) => c.position));
    return {
        electrode: group,
        n: contacts.length,
        rmsMm: metrics?.rmsMm ?? null,
        spacingCv: metrics?.spacingCv ?? null,
        pitchMm: metrics?.pitchMm ?? null,
    };
}
/** Every electrode's stats, in the set's group order — the `stats` operation's result. */
function allShaftStats(set) {
    return set.groups.map((group) => shaftStats(set, group.name));
}
const DIAGRAM_LAYOUT = { width: 200, height: 24, padX: 10 };
/** A projected span narrower than this is no span at all, in the fit's units (millimetres). */
const DIAGRAM_SPAN_EPS = 1e-9;
/**
 * Lay one electrode's contacts out along a horizontal baseline for the panel's sketch.
 *
 * Each dot sits at its own fraction along the shaft — its projection onto the fitted line,
 * normalised across the shaft's span. **The span is the trap.** A one-contact electrode, or one
 * whose contacts all project to a single point (every position identical, which real exports — the
 * owner's P077 among them — do contain), has a span of zero, and the natural `(t − min) / span` is
 * then `0 / 0 = NaN`, or `k / 0 = ±Infinity` for any contact off the minimum. Fed to an SVG `x1` /
 * `x2` / `cx` that logs `<line> attribute x1: Expected length, "Infinity"` on every render —
 * cosmetic, but it spams the console. So when there is no span to normalise against, the dots fall
 * back to an even spread by index, which is always finite and reads correctly for the one-contact
 * case: a single dot at the midpoint.
 *
 * `null` only for an electrode with no contacts — there is nothing to draw.
 *
 * `selectedIndex` is the row the panel has selected, so the sketch can say *which* dot the list and
 * the panes are talking about; `null`, or an index outside the electrode, marks nothing.
 */
function shaftDiagram(positions, tipIndex = null, selectedIndex = null, layout = DIAGRAM_LAYOUT) {
    const n = positions.length;
    if (n === 0)
        return null;
    const { width, height, padX } = layout;
    const y = height / 2;
    const drawWidth = width - 2 * padX;
    // The along-shaft fraction of each contact, guaranteed finite. `fitLine` is `null` for a single
    // contact (nothing to project onto); an identical-position set fits but spans nothing.
    const fit = fitLine(positions);
    let fracs;
    if (fit === null) {
        fracs = positions.map(() => 0.5);
    }
    else {
        const t = fit.t;
        const min = Math.min(...t);
        const max = Math.max(...t);
        const span = max - min;
        fracs =
            span > DIAGRAM_SPAN_EPS
                ? t.map((value) => (value - min) / span)
                : positions.map((_position, index) => n === 1 ? 0.5 : index / (n - 1));
    }
    const dots = fracs.map((frac, index) => ({
        cx: padX + frac * drawWidth,
        cy: y,
        tip: index === tipIndex,
        selected: index === selectedIndex,
    }));
    const xs = dots.map((dot) => dot.cx);
    return {
        width,
        height,
        line: { x1: Math.min(...xs), y1: y, x2: Math.max(...xs), y2: y },
        dots,
    };
}
/** Replace the named contacts inside a set, keeping the array's (drawing) order. */
function withContacts(set, replaced) {
    const byId = new Map(replaced.map((c) => [c.id, c]));
    return {
        groups: set.groups,
        contacts: set.contacts.map((c) => byId.get(c.id) ?? c),
    };
}
/**
 * Number one electrode 1…n from the tip, **without moving anything**.
 *
 * The contact nearest the tip becomes 1, and every name becomes `<ELEC><n>` zero-padded to `pad` —
 * the width the file's own names use, which is the half Slicer got wrong (`LINS01` relabelled to
 * `LINS1`, so the next load read every contact as `added`).
 */
function renumberTipFirst(set, group, reference, pad) {
    const contacts = contactsOf$1(set, group);
    if (contacts.length === 0)
        return { set, renamed: [] };
    const spec = set.groups.find((g) => g.name === group);
    const tip = spec === undefined
        ? "low"
        : resolveTip(spec, contacts.map((c) => c.position), reference);
    const ordered = tipFirstOrder(contacts, tip);
    const renamed = [];
    const next = ordered.map((contact, index) => {
        const name = contactName$1(group, index + 1, pad);
        if (name !== contact.name)
            renamed.push({ from: contact.name, to: name });
        return { ...contact, name, ordinal: index + 1 };
    });
    return { set: withContacts(set, next), renamed };
}
/**
 * Re-fit one shaft: PCA line → project → re-space at the median gap → relabel tip-first.
 *
 * Slicer's `refitShaft`, with its two defects fixed. The **tip** is the electrode's own — pinned by
 * the user or derived by the stated heuristic — rather than an unconditional `+1`; and the relabel
 * pads to the file's width rather than dropping the leading zero.
 *
 * The contact nearest the tip keeps the tip slot, so a shaft whose contacts were already in order
 * stays in order and only moves onto the ideal grid. Its `original` is untouched: the point of
 * re-fitting is that the *file's* positions were noisy, and `status` has to keep saying so.
 */
function refitShaft(set, group, reference, pad) {
    const contacts = contactsOf$1(set, group);
    if (contacts.length < 2)
        return null;
    const spec = set.groups.find((g) => g.name === group);
    const tip = spec === undefined
        ? "low"
        : resolveTip(spec, contacts.map((c) => c.position), reference);
    const positions = contacts.map((c) => c.position);
    const spaced = respaceEven(positions);
    if (spaced === null)
        return null;
    // `respaceEven` answers in ascending-`t` order; the tip decides which end of that is contact 1.
    const slots = tip === "low" ? spaced : [...spaced].reverse();
    const ordered = tipFirstOrder(contacts, tip);
    const renamed = [];
    const next = ordered.map((contact, index) => {
        const name = contactName$1(group, index + 1, pad);
        if (name !== contact.name)
            renamed.push({ from: contact.name, to: name });
        return {
            ...contact,
            name,
            ordinal: index + 1,
            position: slots[index],
        };
    });
    const after = withContacts(set, next);
    return { set: after, stats: shaftStats(after, group), renamed };
}

/**
 * The module's scene block — `ViewSpec.extensions['tetravox.seeg']` (ARCHITECTURE.md §13.2).
 *
 * **What the layer cannot carry.** The contacts themselves are ordinary `PointsLayer` points, so a
 * build without this module still draws them and still round-trips them. What a `points[]` entry has
 * no field for is *provenance*: which file the contact came from, where that file put it, what its
 * `status` cell said, and every other cell of its row. Without those, reopening a scene and pressing
 * Save would write a table in which every contact was `added` and every original column was gone.
 *
 * **Three rules make the block portable**, and each is checked here rather than assumed:
 *
 *  * it holds **no `LayerId` and no `DatasetId`** — both are reassigned on load, so it is keyed by
 *    `points[].id` and finds its layer by `LayerBase.module` instead;
 *  * it is **≤ 256 KiB of JSON**, enforced by the host. A 103-contact table is about 20 kB; a
 *    5 000-row one with seventeen columns is not, so {@link shrinkBlock} drops the per-row `extra`
 *    first and the whole `rows` map second, in that order, because losing the original columns is
 *    worse than losing nothing and better than losing the block;
 *  * a block **this build cannot read is not this build's to break** — `fromBlock` validates the
 *    shape of everything it uses and ignores everything it does not, so a newer module's extra keys
 *    survive a round trip through an older one only in the sense that they are dropped, never
 *    misread.
 */
const { CONTACT_DOT_RADIUS_PX: CONTACT_DOT_RADIUS_PX$1, paletteColor: paletteColor$1 } = contacts;
function rowOf(contact) {
    return {
        original: contact.original === null
            ? null
            : [contact.original[0], contact.original[1], contact.original[2]],
        name: contact.originalName,
        status: contact.loadedStatus,
        extra: contact.extra,
    };
}
/** Everything the module needs to resume, and nothing the scene already holds. */
function toBlock(input) {
    const rows = {};
    for (const contact of input.set.contacts)
        rows[contact.id] = rowOf(contact);
    return {
        source: input.source,
        rows,
        electrodes: input.set.groups.map((g) => ({ name: g.name, color: g.color, tip: g.tip })),
        deleted: input.deleted.map((contact) => ({
            id: contact.id,
            name: contact.name,
            group: contact.group,
            ordinal: contact.ordinal,
            position: [contact.position[0], contact.position[1], contact.position[2]],
            row: rowOf(contact),
        })),
        snapRadiusMm: input.snapRadiusMm,
        namePad: input.namePad,
        ghost: input.ghost,
        wire: input.wire,
        dotRadiusPx: input.dotRadiusPx,
    };
}
/**
 * The same block with less in it, for a set too large for §13.2's 256 KiB.
 *
 * `level` 1 drops the original columns — the table can still be saved, with its own four columns
 * plus the three this module appends. `level` 2 drops the row map entirely, which loses `original`
 * and turns every contact into an `added` one; the module says so rather than pretending.
 */
function shrinkBlock(block, level) {
    const trim = (row) => ({
        original: row.original,
        name: row.name,
        status: row.status,
        extra: {},
    });
    if (level === 1) {
        const rows = {};
        for (const [id, row] of Object.entries(block.rows))
            rows[id] = trim(row);
        return {
            ...block,
            rows,
            deleted: block.deleted.map((gone) => ({ ...gone, row: trim(gone.row) })),
        };
    }
    // Level 2 loses `original` for every contact, so the deletion records go with it: an editlog
    // entry for a contact whose position is unknown would be worse than the missing entry.
    return { ...block, rows: {}, deleted: [] };
}
function isFiniteTriple(value) {
    return (Array.isArray(value) &&
        value.length === 3 &&
        value.every((v) => typeof v === 'number' && Number.isFinite(v)));
}
function stringRecord(value) {
    if (typeof value !== 'object' || value === null)
        return {};
    const out = {};
    for (const [key, cell] of Object.entries(value)) {
        if (typeof cell === 'string')
            out[key] = cell;
    }
    return out;
}
function columnMapOf(value) {
    const raw = (typeof value === 'object' && value !== null ? value : {});
    const pick = (key) => typeof raw[key] === 'string' ? raw[key] : null;
    return {
        name: pick('name'),
        x: pick('x'),
        y: pick('y'),
        z: pick('z'),
        electrode: pick('electrode'),
        contact: pick('contact'),
        status: pick('status'),
    };
}
const DELIMITERS = ['tab', 'comma', 'semicolon', 'whitespace'];
function sourceOf(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const raw = value;
    const delimiter = DELIMITERS.find((d) => d === raw['delimiter']) ?? 'tab';
    return {
        tsv: typeof raw['tsv'] === 'string' ? raw['tsv'] : null,
        coordsystem: typeof raw['coordsystem'] === 'string' ? raw['coordsystem'] : null,
        // A block from before this field, or one written with no T1, reads back as `null` — the same
        // "there isn't one" the module started from.
        t1: typeof raw['t1'] === 'string' ? raw['t1'] : null,
        fieldnames: Array.isArray(raw['fieldnames'])
            ? raw['fieldnames'].filter((f) => typeof f === 'string')
            : [],
        columns: columnMapOf(raw['columns']),
        delimiter,
    };
}
/** One row of the block, read tolerantly: every field defaults rather than throwing. */
function rowFrom(value) {
    const row = (typeof value === 'object' && value !== null ? value : {});
    return {
        original: isFiniteTriple(row['original']) ? row['original'] : null,
        name: typeof row['name'] === 'string' ? row['name'] : null,
        status: typeof row['status'] === 'string' ? row['status'] : null,
        extra: stringRecord(row['extra']),
    };
}
const TIPS = ['auto', 'low', 'high'];
/**
 * Read a block written by this module, tolerantly.
 *
 * `null` only when `data` is not an object at all. Everything else is defaulted, because §13.2 says
 * the *envelope* is validated strictly and `data` is not inspected by the host — so a block whose
 * `snapRadiusMm` arrived as a string is a bad field, not a module crash on file open.
 */
function fromBlock(data) {
    if (typeof data !== 'object' || data === null)
        return null;
    const raw = data;
    const rows = {};
    const rawRows = typeof raw['rows'] === 'object' && raw['rows'] !== null ? raw['rows'] : {};
    for (const [id, value] of Object.entries(rawRows)) {
        if (typeof value !== 'object' || value === null)
            continue;
        rows[id] = rowFrom(value);
    }
    // A block written before deletions were carried has no `deleted` key and reads back as none,
    // which is the state this build used to restore to.
    const deleted = [];
    if (Array.isArray(raw['deleted'])) {
        for (const value of raw['deleted']) {
            if (typeof value !== 'object' || value === null)
                continue;
            const entry = value;
            const position = entry['position'];
            if (typeof entry['id'] !== 'string' || entry['id'] === '')
                continue;
            if (typeof entry['name'] !== 'string' || !isFiniteTriple(position))
                continue;
            const ordinal = entry['ordinal'];
            deleted.push({
                id: entry['id'],
                name: entry['name'],
                group: typeof entry['group'] === 'string' ? entry['group'] : entry['name'],
                ordinal: typeof ordinal === 'number' && Number.isFinite(ordinal) ? Math.trunc(ordinal) : 1,
                position,
                row: rowFrom(entry['row']),
            });
        }
    }
    const electrodes = [];
    if (Array.isArray(raw['electrodes'])) {
        raw['electrodes'].forEach((value, index) => {
            if (typeof value !== 'object' || value === null)
                return;
            const entry = value;
            if (typeof entry['name'] !== 'string' || entry['name'] === '')
                return;
            const color = entry['color'];
            electrodes.push({
                name: entry['name'],
                color: Array.isArray(color) && color.length === 4 && color.every((c) => typeof c === 'number')
                    ? [color[0], color[1], color[2], color[3]]
                    : paletteColor$1(index),
                tip: TIPS.find((t) => t === entry['tip']) ?? 'auto',
            });
        });
    }
    const snapRadiusMm = raw['snapRadiusMm'];
    const namePad = raw['namePad'];
    const dotRadiusPx = raw['dotRadiusPx'];
    return {
        source: sourceOf(raw['source']),
        rows,
        electrodes,
        deleted,
        snapRadiusMm: typeof snapRadiusMm === 'number' && Number.isFinite(snapRadiusMm) ? snapRadiusMm : 1.5,
        namePad: typeof namePad === 'number' && Number.isFinite(namePad) ? Math.trunc(namePad) : 2,
        ghost: raw['ghost'] !== false,
        // `!== false` for the same reason `ghost` uses it: absent means "on", which is what a block
        // written before these keys existed meant. The size is clamped by the caller, which owns the
        // panel's bounds; here it only has to be a number.
        wire: raw['wire'] !== false,
        dotRadiusPx: typeof dotRadiusPx === 'number' && Number.isFinite(dotRadiusPx)
            ? dotRadiusPx
            : CONTACT_DOT_RADIUS_PX$1,
    };
}
/** A deletion record, back as the contact it was — the module's `deleted` list after a restore. */
function contactFromDeleted(gone) {
    return {
        id: gone.id,
        name: gone.name,
        group: gone.group,
        ordinal: gone.ordinal,
        position: [...gone.position],
        original: gone.row.original === null ? null : [...gone.row.original],
        originalName: gone.row.name,
        loadedStatus: gone.row.status,
        extra: { ...gone.row.extra },
    };
}
/**
 * Put a block's provenance back onto a set rebuilt from the layer.
 *
 * The layer supplies the positions, the names, the electrodes and the numbering; the block supplies
 * `original`, the loaded `status`, the original row cells, the group colours and the pinned tip. A
 * contact the block does not know — one placed after the scene was written, or a block shrunk under
 * the size cap — keeps its `original: null`, which is the honest answer: nothing says where it was.
 */
function mergeBlockIntoSet(set, block) {
    const byName = new Map(block.electrodes.map((e) => [e.name, e]));
    return {
        contacts: set.contacts.map((contact) => {
            const row = block.rows[contact.id];
            if (row === undefined)
                return contact;
            return {
                ...contact,
                original: row.original === null ? null : [row.original[0], row.original[1], row.original[2]],
                originalName: row.name,
                loadedStatus: row.status,
                extra: row.extra,
            };
        }),
        groups: set.groups.map((group) => {
            const known = byName.get(group.name);
            return known === undefined ? group : { ...group, color: known.color, tip: known.tip };
        }),
    };
}

/**
 * The BIDS derivative layout a `seegprep` subject has, and what it means for this module.
 *
 * `seegprep` writes a fixed shape (`seegprep/io/layout.py`, and Slicer's `_resolveInputs`):
 *
 * ```text
 * <bids>/derivatives/seegprep/sub-<id>/ct/sub-<id>_acq-bone_space-T1w_ct.nii.gz
 * <bids>/derivatives/seegprep/sub-<id>/ieeg/sub-<id>_space-T1w_electrodes.tsv
 * <bids>/derivatives/seegprep/sub-<id>/ieeg/sub-<id>_space-T1w_coordsystem.json
 * <bids>/derivatives/SimNIBS/sub-<id>/m2m_<id>/T1.nii.gz
 * ```
 *
 * so opening either of the first two is enough to find the other, and the manifest declares the
 * patterns that say so (`src/manifest.ts`). This file is the module's half
 * of that: the template strings the manifest and the module have to agree on, and what a resolved
 * candidate *means*.
 *
 * **The templates are duplicated on purpose, and a test pins the duplication.** A manifest is
 * data-only TypeScript that main imports before a window exists (§13.1), so it cannot import a
 * renderer file; and this file cannot be the manifest, because a manifest is data. So the strings
 * appear twice and `test/bids.test.ts` asserts they are the same strings — which is the only
 * arrangement in which a typo fails a test rather than silently disabling a sibling.
 *
 * **`{stem}` is not duplicated, though.** The templates are strings a test can compare; the token's
 * *meaning* is a function, and two copies of it disagreed about a dotted table name — main admitted
 * one editlog name and this module wrote another. It comes from the module contract, which is
 * data-only and main-safe and therefore the one file both sides of that write may import.
 */
/** Templates the CT anchors. Keys of the `Record` `host.files.siblings` and `onSibling` hand over. */
const FROM_CT_TSV = '../ieeg/{sub}_space-{space}_electrodes.tsv';
const FROM_CT_COORDSYSTEM = '../ieeg/{sub}_space-{space}_coordsystem.json';
const FROM_CT_EDITLOG = '../ieeg/{sub}_space-{space}_electrodes_editlog.json';
const FROM_CT_T1 = '../../../SimNIBS/{sub}/m2m_{id}/T1.nii.gz';
/** Templates the electrodes table anchors. */
const FROM_TSV_CT = '../ct/{sub}_acq-bone_space-{space}_ct.nii.gz';
const FROM_TSV_COORDSYSTEM = '{sub}_space-{space}_coordsystem.json';
const FROM_TSV_EDITLOG = '{stem}_editlog.json';
/**
 * Read a `host.files.siblings` result — keyed by the manifest's own templates — as a bundle.
 *
 * A template that is not in the record, or whose value is `null`, is "not there"; the two are the
 * same answer to this module and different only to the host, which distinguishes "no rule for this
 * anchor" from "declared, probed, missing".
 */
function bundleOf(found) {
    const at = (...templates) => {
        for (const template of templates) {
            const path = found[template];
            if (typeof path === 'string' && path !== '')
                return path;
        }
        return null;
    };
    return {
        tsv: at(FROM_CT_TSV),
        ct: at(FROM_TSV_CT),
        t1: at(FROM_CT_T1),
        coordsystem: at(FROM_CT_COORDSYSTEM, FROM_TSV_COORDSYSTEM),
        editlog: at(FROM_CT_EDITLOG, FROM_TSV_EDITLOG),
    };
}
/** The basename of a path, on either platform's separator. */
function baseNameOf(path) {
    return path.split(/[/\\]/).pop() ?? '';
}
/**
 * `<stem>_editlog.json` beside `tsvPath`.
 *
 * The name is the contract: `seegprep`'s CLI globs `*_electrodes_editlog.json` and refuses to
 * overwrite a hand-edited subject unless `--force`, so an editlog whose stem does not end in
 * `_electrodes` is a file nothing will ever look at.
 */
function editlogNameFor(tsvName) {
    return `${stemOf(tsvName)}_editlog.json`;
}
/**
 * Whether saving under this name will produce an editlog `seegprep` finds.
 *
 * Two things have to be true, and the warning names whichever is not: the stem ends in
 * `_electrodes`, and the file sits in an `ieeg/` directory. Both come straight from
 * `seegprep/cli.py::_editlog_files`, which looks in `<deriv>/sub-<id>/ieeg` for that glob.
 */
function seegprepWarning(path) {
    const name = baseNameOf(path);
    const stem = stemOf(name);
    const directory = /(?:^|[/\\])ieeg[/\\][^/\\]+$/.test(path);
    if (!stem.endsWith('_electrodes')) {
        return (`“${name}” does not end in _electrodes.tsv, so seegprep’s --force guard will not see its ` +
            `editlog (it globs *_electrodes_editlog.json).`);
    }
    if (!directory) {
        return (`“${name}” is not in an ieeg/ directory, so seegprep will not find its editlog ` +
            `(it looks in <derivatives>/sub-<id>/ieeg).`);
    }
    return null;
}
/** `sub-P076` out of a path, for the panel's source line. `null` when there is none. */
function subjectOf(path) {
    const match = /(?:^|[/\\])(sub-[A-Za-z0-9]+)(?=[/\\_])/.exec(path);
    return match === null ? null : match[1];
}

/**
 * The sEEG editor's own state and every one of its commands (ARCHITECTURE.md §13).
 *
 * `index.ts` is the thin `ModuleInstance` around this; `Panel.tsx` is chrome that reads
 * {@link SeegView} and calls one method per control. **Every command is a method here and every
 * operation calls the same method**, which is what makes §13.6's "there is no automation-only code
 * path" true of this module rather than merely intended.
 *
 * Four mechanics are worth reading before the code:
 *
 *  * **Undo is a pair, because the host's history is a stack of states.** `ModuleHistory.undo()`
 *    pops the last thing pushed and pushes it onto the redo side, which is exactly right for
 *    "restore the snapshot" and cannot express "redo" on its own — after an undo, `redo()` would
 *    hand back the state that was just restored. So what is pushed is `{ before, after }`: undo
 *    applies `before`, redo applies `after`, and one `host.history` is the whole stack (§13.1).
 *  * **A drag is coalesced by comparing positions.** A plain select-mode click emits `selected` and
 *    then one zero-length `dragEnd`, so a commit on every `dragEnd` would push an undo step for
 *    every click. The snapshot taken at `selected` is compared with the state at `dragEnd`, and an
 *    unchanged one commits nothing.
 *  * **The layer is the truth about positions during a drag.** The engine writes each move straight
 *    into `points[]`, so the `layers` subscription adopts positions the module did not make and
 *    rewrites only the shaft lines. It is loop-free without a flag: after the module writes the
 *    layer, the next `layers` event finds nothing different and stops.
 *  * **Nothing renumbers implicitly.** Loading, placing, dragging, snapping and deleting leave every
 *    number and name alone; only Re-fit and Renumber relabel (see `shaft.ts`).
 */
const { CANONICAL_FIELDNAMES, CONTACT_DOT_RADIUS_MAX_PX, CONTACT_DOT_RADIUS_MIN_PX, CONTACT_DOT_RADIUS_PX, CONTACT_DOT_RADIUS_STEP_PX, CONTACT_LAYER_STYLE, ContactTableError, SNAP_RADIUS_DEFAULT_MM, applySnap, buildEditlog, clampDotRadius, clampSnapRadius, cloneSet, contactLayerName, contactName, contactSetFrom, contactSetFromLayer, contactsOf, cssColor, ctDisplayPreset, dirtyCount, editlogDate, emptySet, formatEditlog, hasMoved, layerPatch, namePadOf, namePadOfLayer, newContact, paletteColor, parseTable, resolveColumns, snapContacts, statusOf, t1DisplayPreset, writeTable, } = contacts;
const EDITLOG_TEMPLATE = '{stem}_editlog.json';
/** `manifest.version`, quoted into the editlog's `tool` field. */
const TOOL = 'Tetravox sEEG contacts 0.1.0';
const CT_NAME = /(^|[^a-z])ct([^a-z]|$)|_ct\./i;
function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
/** The canonical source a set with no file of its own is written against. */
function canonicalSource() {
    return {
        tsv: null,
        coordsystem: null,
        t1: null,
        fieldnames: [...CANONICAL_FIELDNAMES],
        columns: resolveColumns(CANONICAL_FIELDNAMES),
        delimiter: 'tab',
    };
}
function createModel(host) {
    // ---- state -----------------------------------------------------------------------------------
    let set = emptySet();
    let deleted = [];
    let namePad = 2;
    let snapRadiusMm = SNAP_RADIUS_DEFAULT_MM;
    let ghost = true;
    let wire = true;
    let dotRadiusPx = CONTACT_DOT_RADIUS_PX;
    let electrode = null;
    let selectedId = null;
    let source = null;
    let savePath = null;
    let saveSiblings = {};
    let banner = null;
    let warning = null;
    let message = null;
    let busy = false;
    let layerId = null;
    let datasetId = null;
    let ctName = null;
    let tsvPath = null;
    /** The T1 a `load` operation named and found open, for the block's `source` (§13.6). */
    let t1Path = null;
    let pendingTsv = null;
    let isDirty = false;
    /** Whether the module wants the point tool on its layer at all. */
    let armed = false;
    /** The mode {@link ensureArmed} restores. The **engine** owns which mode is live; this is intent. */
    let wantMode = 'select';
    /** Set while this module is the one taking the tool away, so its own `cleared` is not a surprise. */
    let selfCleared = false;
    let dragBase = null;
    const operations = {
        refit: new Set(),
        renumbered: new Set(),
        snapped: new Set(),
    };
    /**
     * Forget which electrodes this session's operations touched — **per table, not per window**.
     *
     * The three sets are keyed by electrode *name*, and anatomical naming means sub-02's shafts are
     * usually called what sub-01's were. So a snap-all on one subject followed by opening the next
     * subject's table would write `snapped: true` beside every same-named electrode of a table the
     * snap never ran on, in the sidecar the module's own header calls "a contract with another
     * program". The editlog's per-contact diff was always per table (`set` and `deleted` are replaced
     * on load); this is what makes the per-electrode flags agree with it.
     */
    const forgetOperations = () => {
        operations.refit.clear();
        operations.renumbered.clear();
        operations.snapped.clear();
    };
    const listeners = new Set();
    const history = host.history(50);
    let cached = null;
    const notify = () => {
        cached = null;
        for (const listener of listeners)
            listener();
    };
    // ---- snapshots and history -------------------------------------------------------------------
    const snapshot = () => ({
        set: cloneSet(set),
        deleted: deleted.map((c) => ({ ...c, position: [...c.position] })),
        namePad,
    });
    const restore = (state) => {
        set = cloneSet(state.set);
        deleted = state.deleted.map((c) => ({ ...c, position: [...c.position] }));
        namePad = state.namePad;
        writeLayer();
        writeBlock();
        markDirty(true);
    };
    const markDirty = (dirty) => {
        isDirty = dirty;
        host.ui.setDirty(dirty);
        syncStatus();
        notify();
    };
    /** Commit an edit: one history entry, one dirty mark, one layer write, one block write. */
    const commit = (before) => {
        history.push({ before, after: snapshot() });
        writeLayer();
        writeBlock();
        markDirty(true);
    };
    // ---- the scene ---------------------------------------------------------------------------------
    const layerOf = () => {
        if (layerId === null)
            return null;
        const found = host.scene.layers().find((l) => l.id === layerId);
        return found !== undefined && found.kind === 'points' ? found : null;
    };
    /** This module's layer, found by `LayerBase.module` — how a module finds itself after a load. */
    const ownedLayer = () => {
        const found = host.scene
            .layers()
            .find((l) => l.kind === 'points' && l.module === host.id);
        return found ?? null;
    };
    const volumes = () => host.scene.datasets().filter((d) => d.kind === 'volume');
    /** The CT: a volume whose name says so, else the first volume there is. */
    const chooseVolume = () => {
        const all = volumes();
        return all.find((d) => CT_NAME.test(d.name)) ?? all[0] ?? null;
    };
    const boundsOfVolume = () => {
        const dataset = host.scene.datasets().find((d) => d.id === datasetId);
        return dataset === undefined ? null : dataset.bounds;
    };
    const reference = () => tipReference(boundsOfVolume(), set);
    /** The three display switches as one value — what the layer and the block both read. */
    const look = () => ({ ghost, wire, dotRadiusPx });
    const writeLayer = () => {
        if (layerId === null)
            return;
        host.scene.updateLayer(layerId, layerPatch(set, look()));
    };
    /**
     * Write the module's block, shrinking it rather than losing it when a very large table would blow
     * §13.2's 256 KiB cap. The host throws for an oversized block; two fallbacks, then a warning.
     */
    const writeBlock = () => {
        const input = { set, deleted, source, snapRadiusMm, namePad, ghost, wire, dotRadiusPx };
        const attempts = [
            toBlock(input),
            shrinkBlock(toBlock(input), 1),
            shrinkBlock(toBlock(input), 2),
        ];
        for (const [level, block] of attempts.entries()) {
            try {
                host.scene.setBlock(block);
                if (level > 0) {
                    host.ui.toast('warn', level === 1
                        ? 'This table is too large for a scene block to carry its original columns; positions are still recorded.'
                        : 'This table is too large for a scene block; reopening this scene will not know where the contacts came from.');
                }
                return;
            }
            catch (error) {
                if (!(error instanceof ModuleHostError))
                    throw error;
            }
        }
    };
    const syncStatus = () => {
        if (set.contacts.length === 0) {
            host.ui.status(null);
            return;
        }
        const changed = dirtyCount(set, deleted.length);
        const parts = [`sEEG ${set.contacts.length}`];
        if (changed > 0)
            parts.push(`${changed} edited`);
        if (placingNow())
            parts.push('place');
        host.ui.status(parts.join(' · ').slice(0, 40));
    };
    // ---- the point tool ----------------------------------------------------------------------------
    /**
     * Whether the **engine** is in place mode — the only honest answer to "is the Add button pressed?".
     *
     * The engine's Esc grammar is place → select → off (§4.7) and the first step emits no event, so a
     * module flag mirroring it goes stale the moment a user presses Escape once: the button would read
     * pressed while every click selected instead of placed. Reading the engine cannot go stale; what
     * it costs is that the panel re-renders on the next event rather than on the key press itself,
     * because there is no event to render on.
     */
    const placingNow = () => host.tool.pointTool()?.mode === 'place';
    const arm = (mode) => {
        const layer = layerOf();
        if (layer === null)
            return;
        armed = true;
        wantMode = mode;
        const current = host.tool.pointTool();
        if (current?.layerId === layer.id && current.mode === mode)
            return;
        const group = electrode ?? set.groups[0]?.name ?? 'E';
        const color = set.groups.find((g) => g.name === group)?.color ?? paletteColor(0);
        host.tool.setPointTool({
            layerId: layer.id,
            mode,
            template: { group, color, radiusMm: CONTACT_LAYER_STYLE.radiusMm },
        });
    };
    /** Stop wanting the tool. The `cleared` this provokes is the module's own, not the user's. */
    const disarm = () => {
        armed = false;
        wantMode = 'select';
        if (host.tool.pointTool() === null)
            return;
        selfCleared = true;
        try {
            host.tool.setPointTool(null);
        }
        finally {
            selfCleared = false;
        }
    };
    /**
     * Put the tool back on whatever layer this module owns now, once the store agrees it exists.
     *
     * Run from the `layers` subscription, because that is the first moment the store agrees with the
     * engine about which layers exist — which is exactly the window a scene load's disarm opens.
     * Until 2026-08-30 this also had to *guess why* the tool had been cleared, by comparing the layer
     * it was armed against with the one that came back; §4.7's `PointToolEvent.reason` says so
     * outright now, so all that is left here is "if the module wants the tool, make sure it has it".
     */
    const reconcileTool = () => {
        if (armed)
            ensureArmed();
    };
    /** Re-arm after the engine cleared the tool — `Engine.load` does, and so does removing the layer. */
    const ensureArmed = () => {
        if (!armed)
            return;
        const layer = layerOf() ?? ownedLayer();
        if (layer === null)
            return;
        layerId = layer.id;
        if (host.tool.pointTool()?.layerId === layer.id)
            return;
        arm(wantMode);
    };
    // ---- building the layer -------------------------------------------------------------------------
    const applyDisplayPreset = () => {
        if (datasetId === null)
            return;
        const layers = host.scene.layers();
        const ct = layers.find((l) => l.kind === 'volume' && l.datasetId === datasetId);
        if (ct === undefined)
            return;
        host.scene.updateLayer(ct.id, ctDisplayPreset());
        // "CT above T1" is the other half of Slicer's preset and the one this host cannot do: there is
        // no `reorderLayers` on `ModuleHost`, and adding one for a display nicety is not worth a frozen
        // change. Say so instead of leaving the CT invisible under an opaque T1.
        const above = layers.filter((l) => l.kind === 'volume' && l.datasetId !== datasetId && l.visible);
        const ctIndex = layers.indexOf(ct);
        if (above.some((l) => layers.indexOf(l) > ctIndex)) {
            host.ui.toast('info', 'Another volume is drawn above the CT — raise the CT in the layer panel so the 150 HU floor shows the anatomy underneath.');
        }
    };
    /**
     * The `load` operation's optional `t1` (§13.6), resolved honestly.
     *
     * A module has no `addDataset`, so it cannot open the file: the T1 is the job's to open, the same
     * way the CT is (`scene.files`, or an `open` action, before this one). All this can do is find the
     * dataset that is already there and give its layer the T1 half of Slicer's preset — grey, opaque
     * and **visible**, since an open-but-hidden T1 shows nothing through the CT's 150 HU floor — and
     * record which file it was in the block's `source`.
     *
     * Matched on the resolved path, with the basename as the fallback, exactly as the CT is: main
     * `${VAR}`-expands, resolves and allow-lists a `path?` before the window exists, so the string
     * here and the dataset's `path` are the same string unless the build opened it under a symlink.
     *
     * `'not-open'` is the answer when it is not there, and it is an answer rather than a throw: the
     * contacts loaded, the table is editable and every other number the operation reports is true.
     * Only the anatomy underneath is missing, and the job author is the one who can fix it.
     */
    const showT1 = (candidate) => {
        const name = baseNameOf(candidate);
        const dataset = host.scene
            .datasets()
            .find((d) => d.kind === 'volume' &&
            d.id !== datasetId &&
            (d.path === candidate || baseNameOf(d.path ?? '') === name));
        if (dataset === undefined)
            return 'not-open';
        const layer = host.scene
            .layers()
            .find((l) => l.kind === 'volume' && l.datasetId === dataset.id);
        if (layer !== undefined)
            host.scene.updateLayer(layer.id, t1DisplayPreset());
        t1Path = dataset.path ?? candidate;
        if (source !== null) {
            source = { ...source, t1: t1Path };
            writeBlock();
        }
        return 'shown';
    };
    const buildLayer = () => {
        const dataset = host.scene.datasets().find((d) => d.id === datasetId);
        if (dataset === undefined)
            return;
        const stem = tsvPath === null ? (subjectOf(dataset.name) ?? '') : stemOf(baseNameOf(tsvPath));
        let existing = layerOf() ?? ownedLayer();
        // A layer hanging off a *different* volume than the one now bound — a job's `load` naming a
        // second CT after an interactive session bound the first — is rebuilt rather than patched:
        // `LayerBase.datasetId` is the carrier the renderable was built for, so the contacts would be
        // drawn against one volume and snapped against another. Removing it disarms the point tool;
        // the `armed`/`ensureArmed` pair at the end of this function is what puts it back.
        if (existing !== null && existing.datasetId !== dataset.id) {
            selfCleared = true;
            try {
                host.scene.removeLayer(existing.id);
            }
            finally {
                selfCleared = false;
            }
            layerId = null;
            existing = null;
        }
        if (existing !== null) {
            layerId = existing.id;
            host.scene.updateLayer(existing.id, {
                ...layerPatch(set, look()),
                name: contactLayerName(stem),
            });
        }
        else {
            const created = host.scene.addLayer({
                datasetId: dataset.id,
                ...CONTACT_LAYER_STYLE,
                name: contactLayerName(stem),
                color: paletteColor(0),
                ...layerPatch(set, look()),
            });
            layerId = created.id;
        }
        applyDisplayPreset();
        armed = true;
        ensureArmed();
    };
    // ---- loading ------------------------------------------------------------------------------------
    const bindVolume = () => {
        const dataset = chooseVolume();
        if (dataset === null)
            return false;
        datasetId = dataset.id;
        ctName = dataset.name;
        return true;
    };
    /** Whether {@link datasetId} still names a dataset the scene has. */
    const stillBound = () => datasetId !== null && host.scene.datasets().some((d) => d.id === datasetId);
    const applyTable = (path, text) => {
        let parsed;
        try {
            parsed = parseTable(text);
        }
        catch (error) {
            const why = error instanceof ContactTableError ? error.message : String(error);
            host.ui.toast('error', `${baseNameOf(path)}: ${why}`);
            return false;
        }
        const result = contactSetFrom(parsed);
        if (result.set.contacts.length === 0) {
            host.ui.toast('warn', `${baseNameOf(path)} has no usable rows.`);
            return false;
        }
        set = result.set;
        namePad = result.namePad;
        deleted = [];
        history.clear();
        tsvPath = path;
        savePath = null;
        saveSiblings = {};
        electrode = set.groups[0]?.name ?? null;
        selectedId = null;
        // Everything the *previous* table's session recorded goes with it: the per-electrode operation
        // flags (see {@link forgetOperations}), the "hand-edited on …" banner, which belongs to the
        // editlog beside the table that was open, and the T1 — the block's `source.t1` is provenance
        // for *this* table, and a `load` operation that names one calls `showT1` right after this.
        forgetOperations();
        banner = null;
        t1Path = null;
        source = {
            tsv: path,
            coordsystem: null,
            t1: t1Path,
            fieldnames: parsed.fieldnames,
            columns: parsed.columns,
            delimiter: parsed.delimiter,
        };
        warning = seegprepWarning(path);
        for (const note of result.warnings.slice(0, 3))
            host.ui.toast('warn', note);
        // **A CT that was named beats a CT that was guessed.** `runOperation('load')` resolves the job's
        // `ct` argument to a dataset before calling this; re-running the name heuristic here would throw
        // that away and bind whichever volume matches `/ct/` first, which in the ordinary sEEG scene —
        // a pre-op CT and a post-implant one — is the wrong volume, and everything downstream (the
        // layer's carrier, the 150 HU preset, every `peakCentroid` a snap takes) would be computed on
        // it while the result still reported `bound: true`. Only re-bind when nothing is bound, or when
        // what was bound has since been closed.
        if (!stillBound() && !bindVolume()) {
            pendingTsv = path;
            message = 'Open the CT this table was localised on to edit it.';
            markDirty(false);
            return true;
        }
        pendingTsv = null;
        message = null;
        buildLayer();
        writeBlock();
        markDirty(false);
        host.ui.toast('info', `${set.contacts.length} contacts on ${set.groups.length} electrodes from ${baseNameOf(path)}.`);
        return true;
    };
    const readEditlogBanner = async (path) => {
        const text = await host.files.readText(path);
        if (text === null)
            return;
        const when = editlogDate(text);
        banner =
            when === null
                ? 'This table has been hand-edited before.'
                : `Hand-edited on ${when.slice(0, 10)}.`;
        notify();
    };
    // ---- the view -------------------------------------------------------------------------------
    const rowsOf = () => {
        if (electrode === null)
            return [];
        const contacts = contactsOf(set, electrode);
        const plane = host.scene.activePlane();
        const group = set.groups.find((g) => g.name === electrode);
        const tip = group === undefined || contacts.length === 0
            ? null
            : (tipFirstOrder(contacts, resolveTip(group, contacts.map((c) => c.position), reference()))[0]?.id ?? null);
        return contacts.map((contact) => ({
            id: contact.id,
            name: contact.name,
            status: statusOf(contact),
            offPlaneMm: plane === null
                ? null
                : Math.abs(dot([
                    contact.position[0] - plane.point[0],
                    contact.position[1] - plane.point[1],
                    contact.position[2] - plane.point[2],
                ], plane.normal)),
            selected: contact.id === selectedId,
            tip: contact.id === tip,
        }));
    };
    const view = () => {
        // `placing` is read off the engine, which changes it without an event (Esc's place → select
        // step), so the cache is invalidated by comparing rather than only by `notify`. It still returns
        // the same object until something really changed, which is what `useSyncExternalStore` needs.
        const placing = placingNow();
        if (cached !== null && cached.placing === placing)
            return cached;
        const rows = rowsOf();
        cached = {
            ready: layerId !== null && set.contacts.length > 0,
            subject: tsvPath === null ? null : subjectOf(tsvPath),
            ctName,
            tsvName: tsvPath === null ? null : baseNameOf(tsvPath),
            banner,
            warning,
            provenance: source?.tsv === null || source === null ? 'unknown' : 'file',
            electrodes: set.groups.map((group) => ({
                name: group.name,
                count: set.contacts.filter((c) => c.group === group.name).length,
                color: cssColor(group.color),
            })),
            electrode,
            snapRadiusMm,
            ghost,
            wire,
            dotRadiusPx,
            sizeBounds: {
                min: CONTACT_DOT_RADIUS_MIN_PX,
                max: CONTACT_DOT_RADIUS_MAX_PX,
                step: CONTACT_DOT_RADIUS_STEP_PX,
            },
            placing,
            stats: electrode === null ? null : shaftStats(set, electrode),
            tipName: rows.find((r) => r.tip)?.name ?? null,
            diagram: electrode === null
                ? null
                : shaftDiagram(contactsOf(set, electrode).map((c) => c.position), rows.findIndex((r) => r.tip), rows.findIndex((r) => r.selected)),
            rows,
            selectedId,
            dirty: isDirty,
            changed: dirtyCount(set, deleted.length),
            canUndo: history.canUndo(),
            canRedo: history.canRedo(),
            busy,
            message,
        };
        return cached;
    };
    // ---- commands ---------------------------------------------------------------------------------
    const selectContact = (id, moveCursor) => {
        selectedId = id;
        const layer = layerOf();
        if (layer !== null)
            host.tool.select(layer.id, id);
        if (id !== null) {
            const contact = set.contacts.find((c) => c.id === id);
            if (contact !== undefined) {
                electrode = contact.group;
                host.scene.setCursor([...contact.position]);
            }
        }
        notify();
    };
    const step = (delta) => {
        if (electrode === null)
            return;
        const contacts = contactsOf(set, electrode);
        if (contacts.length === 0)
            return;
        const at = contacts.findIndex((c) => c.id === selectedId);
        const next = at < 0 ? (delta > 0 ? 0 : contacts.length - 1) : at + delta;
        const wrapped = ((next % contacts.length) + contacts.length) % contacts.length;
        selectContact(contacts[wrapped].id);
    };
    const idsForScope = (scope) => {
        if (scope === 'all')
            return set.contacts.map((c) => c.id);
        if (scope === 'electrode') {
            return electrode === null ? [] : contactsOf(set, electrode).map((c) => c.id);
        }
        return selectedId === null ? [] : [selectedId];
    };
    const doSnap = (scope, radiusMm) => {
        if (datasetId === null)
            throw new ModuleHostError('no CT is loaded to snap against');
        const ids = idsForScope(scope);
        if (ids.length === 0)
            return { moved: 0, meanShiftMm: 0 };
        const dataset = datasetId;
        const before = snapshot();
        const result = snapContacts(set, ids, radiusMm, (world, r) => host.scene.peakCentroid(dataset, world, r));
        if (result.moved === 0)
            return { moved: 0, meanShiftMm: 0 };
        set = applySnap(set, result);
        for (const id of ids) {
            const contact = set.contacts.find((c) => c.id === id);
            if (contact !== undefined)
                operations.snapped.add(contact.group);
        }
        commit(before);
        return { moved: result.moved, meanShiftMm: result.meanShiftMm };
    };
    const doRefit = (group) => {
        const before = snapshot();
        const result = refitShaft(set, group, reference(), namePad);
        if (result === null)
            return null;
        set = result.set;
        operations.refit.add(group);
        commit(before);
        return result.stats;
    };
    const doRenumber = (group) => {
        const before = snapshot();
        const result = renumberTipFirst(set, group, reference(), namePad);
        if (result.renamed.length === 0)
            return 0;
        set = result.set;
        operations.renumbered.add(group);
        commit(before);
        return result.renamed.length;
    };
    const doGhost = (on) => {
        ghost = on;
        writeLayer();
        writeBlock();
        notify();
    };
    /**
     * Show or hide the shaft lines — §4.4's `lineSegments`, patched to an empty array and back.
     *
     * Module-side entirely: the segments are rebuilt from the set on every write anyway, so "hidden"
     * is simply not building them. It is a **display** switch and not an edit, so it pushes no history
     * entry and marks nothing dirty; what it does do is write the block, because §4.6 does not
     * serialise `lineSegments` and a scene reopened without the record would put every shaft back.
     */
    const doWire = (on) => {
        wire = on;
        writeLayer();
        writeBlock();
        notify();
    };
    /** §4.4's `dotRadiusPx`. Like the wire, a display switch: no history, no dirty mark, one block. */
    const doSize = (px) => {
        const next = clampDotRadius(px);
        if (next === dotRadiusPx)
            return;
        dotRadiusPx = next;
        writeLayer();
        writeBlock();
        notify();
    };
    /** The contact a job named, by the name in the table or by the id the block keys on. */
    const findContact = (wanted) => set.contacts.find((c) => c.name === wanted || c.id === wanted) ?? null;
    const doDelete = (id) => {
        const contact = set.contacts.find((c) => c.id === id);
        if (contact === undefined)
            return null;
        const before = snapshot();
        set = { groups: set.groups, contacts: set.contacts.filter((c) => c.id !== id) };
        if (contact.original !== null)
            deleted = [...deleted, contact];
        if (selectedId === id)
            selectedId = null;
        commit(before);
        return contact;
    };
    /** Pin the other end of one electrode as contact 1. Answers the end that is now the tip. */
    const doFlipTip = (group) => {
        const spec = set.groups.find((g) => g.name === group);
        if (spec === undefined)
            return null;
        const contacts = contactsOf(set, group);
        if (contacts.length === 0)
            return null;
        const tip = flippedTip(spec, contacts.map((c) => c.position), reference());
        set = {
            contacts: set.contacts,
            groups: set.groups.map((g) => (g.name === group ? { ...g, tip } : g)),
        };
        writeBlock();
        markDirty(true);
        // `tip` is only ever `'low'` or `'high'` here: `flippedTip` resolves `'auto'` before flipping it.
        return tip === 'auto' ? null : tip;
    };
    const doRevert = () => {
        const before = snapshot();
        const restored = deleted;
        set = {
            groups: set.groups,
            contacts: [
                ...set.contacts
                    .filter((c) => c.original !== null)
                    .map((c) => ({ ...c, position: [...c.original] })),
                ...restored.map((c) => ({ ...c, position: [...(c.original ?? c.position)] })),
            ],
        };
        deleted = [];
        selectedId = null;
        commit(before);
        return { contacts: set.contacts.length, restored: restored.length };
    };
    const doUndo = () => {
        const entry = history.undo();
        if (entry === null) {
            host.ui.toast('info', 'Nothing to undo.');
            return;
        }
        restore(entry.before);
    };
    const doRedo = () => {
        const entry = history.redo();
        if (entry === null) {
            host.ui.toast('info', 'Nothing to redo.');
            return;
        }
        restore(entry.after);
    };
    // ---- saving -------------------------------------------------------------------------------------
    const deletedRecords = () => deleted.map((c) => ({
        name: c.name,
        group: c.group,
        ordinal: c.ordinal,
        position: (c.original ?? c.position),
    }));
    const writeFiles = async (path, siblings) => {
        const columns = source?.columns ?? canonicalSource().columns;
        const fieldnames = source?.fieldnames ?? canonicalSource().fieldnames;
        const text = writeTable(set, { fieldnames, columns });
        const written = await host.files.writeText(path, text, { backup: true });
        if (!written.ok) {
            host.ui.toast('error', `Could not write ${baseNameOf(path)}: ${written.error}`);
            return null;
        }
        const editlogPath = siblings[EDITLOG_TEMPLATE] ?? null;
        let editlog = null;
        if (editlogPath !== null) {
            const log = buildEditlog({
                set,
                deleted: deletedRecords(),
                sourceTsv: source?.tsv ?? null,
                outputTsv: path,
                backup: written.backupPath,
                snapRadiusMm,
                tool: TOOL,
                operations,
            });
            const result = await host.files.writeText(editlogPath, formatEditlog(log), { backup: false });
            if (result.ok)
                editlog = editlogPath;
            else
                host.ui.toast('warn', `The table was saved; its editlog was not: ${result.error}`);
        }
        markDirty(false);
        host.ui.toast('info', `Saved ${set.contacts.length} contacts to ${baseNameOf(path)}` +
            (written.backupPath === null ? '.' : `, backing up the previous table.`));
        return { path, editlog };
    };
    const doSaveAs = async () => {
        const target = await host.files.saveDialog('electrodes', tsvPath);
        if (target === null)
            return null;
        savePath = target.path;
        saveSiblings = target.siblings;
        warning = seegprepWarning(target.path);
        if (warning !== null)
            host.ui.toast('warn', warning);
        return writeFiles(target.path, target.siblings);
    };
    const doSave = async () => {
        if (savePath === null)
            return doSaveAs();
        return writeFiles(savePath, saveSiblings);
    };
    /**
     * §13.3's discard guard, asked by the module for the one destructive route the shell cannot see.
     *
     * `openThroughModule` guards the reader route, but the panel's own Open… sheet never leaves the
     * module, and `applyTable` replaces the set and clears the history. Same three buttons and the
     * same order as `confirmDiscardModuleEdits`, because a user who has answered one of these should
     * not have to read the other: Save… first, then Discard, and Cancel last.
     */
    const confirmDiscard = async (what) => {
        if (!isDirty)
            return true;
        const answer = await host.ui.confirm(`Discard unsaved sEEG contacts edits?`, `${what}.`, [
            'Save…',
            'Discard',
            'Cancel',
        ]);
        if (answer === 0) {
            await doSave();
            // A save that did not clear the flag has not saved; do not proceed on its behalf.
            return !isDirty;
        }
        return answer === 1;
    };
    const doLoadDialog = async () => {
        if (!(await confirmDiscard('Opening another table will close them without saving')))
            return;
        const paths = await host.files.openDialog('electrodes');
        const path = paths?.[0];
        if (path === undefined)
            return;
        const text = await host.files.readText(path);
        if (text === null) {
            host.ui.toast('error', `Could not read ${baseNameOf(path)}.`);
            return;
        }
        applyTable(path, text);
    };
    // ---- events ---------------------------------------------------------------------------------
    const adoptLayerPositions = () => {
        const layer = layerOf();
        if (layer === null)
            return;
        const byId = new Map((layer.points ?? []).map((p, i) => [p.id ?? `p${i}`, p.position]));
        let changed = false;
        const contacts = set.contacts.map((contact) => {
            const position = byId.get(contact.id);
            if (position === undefined)
                return contact;
            if (position[0] === contact.position[0] &&
                position[1] === contact.position[1] &&
                position[2] === contact.position[2]) {
                return contact;
            }
            changed = true;
            return { ...contact, position: [...position] };
        });
        if (!changed)
            return;
        set = { groups: set.groups, contacts };
        // Only the shaft lines: rewriting `points` from the set would fight the drag the engine is in
        // the middle of. The next `layers` event finds nothing different, so this cannot loop.
        host.scene.updateLayer(layer.id, layerPatch(set, look()));
        notify();
    };
    const onPointTool = (event) => {
        if (layerId !== null && event.layerId !== layerId && event.kind !== 'cleared')
            return;
        switch (event.kind) {
            case 'placed': {
                const before = snapshot();
                const group = electrode ?? set.groups[0]?.name ?? 'E';
                const existing = contactsOf(set, group);
                const ordinal = existing.reduce((max, c) => Math.max(max, c.ordinal), 0) + 1;
                const id = event.pointId ?? `p${set.contacts.length}`;
                const world = event.world ?? [0, 0, 0];
                if (!set.groups.some((g) => g.name === group)) {
                    set = {
                        contacts: set.contacts,
                        groups: [
                            ...set.groups,
                            { name: group, color: paletteColor(set.groups.length), tip: 'auto' },
                        ],
                    };
                }
                set = {
                    groups: set.groups,
                    contacts: [...set.contacts, newContact(id, group, ordinal, [...world], namePad)],
                };
                selectedId = id;
                commit(before);
                return;
            }
            case 'selected': {
                dragBase = snapshot();
                selectedId = event.pointId;
                const contact = set.contacts.find((c) => c.id === event.pointId);
                if (contact !== undefined) {
                    electrode = contact.group;
                    host.scene.setCursor([...contact.position]);
                }
                notify();
                return;
            }
            case 'dragEnd': {
                adoptLayerPositions();
                const base = dragBase;
                dragBase = null;
                if (base === null)
                    return;
                const moved = base.set.contacts.some((was) => {
                    const now = set.contacts.find((c) => c.id === was.id);
                    return (now !== undefined &&
                        (now.position[0] !== was.position[0] ||
                            now.position[1] !== was.position[1] ||
                            now.position[2] !== was.position[2]));
                });
                // A plain click emits `selected` and then a zero-length `dragEnd`; comparing positions is
                // what keeps that from becoming an undo step and a dirty mark.
                if (moved)
                    commit(base);
                return;
            }
            case 'cleared': {
                // **Why the tool was cleared decides what to do about it** — §4.7's `reason` (2026-08-30).
                // Absent is `'host'`, which is what every clear meant before the field existed.
                const reason = event.reason ?? 'host';
                // A selection-only clear leaves the tool armed: `setPointSelection(null)`, and a `points`
                // replacement that lost the selected id — which is every delete of the selected contact.
                // Treating it as a disarm used to leave `armed` false while the engine was still armed, so
                // the module stopped re-arming after the next scene load for no reason a user could see.
                selectedId = null;
                dragBase = null;
                if (reason === 'selection') {
                    notify();
                    return;
                }
                if (selfCleared) {
                    notify();
                    return;
                }
                if (reason === 'measure') {
                    // §7.5 lets one click-consuming mode be armed, and the user just picked the other one.
                    // Arming again here would turn measure mode straight back off — the point tool's own
                    // `setPointTool` disarms it — so a click would go to a mode the user did not choose.
                    armed = false;
                    wantMode = 'select';
                    syncStatus();
                    notify();
                    return;
                }
                // `'esc'`, `'load'`, `'layer'`, `'host'`: **select is this module's resting state**
                // (§13.3, 2026-08-30). A contact editor whose panel is open is an editor the user is about
                // to click contacts in, and an unarmed left click is §7.5's R1 cursor-set that never hit
                // tests — so the dropdown, the crosshair and the ring all stop following the clicks. Esc
                // still means what it meant, because the step that matters is `place` → `select`: what it
                // no longer does is leave the module needing two presses of Add to answer a click again.
                armed = true;
                wantMode = 'select';
                // Only Esc (and a host's own disarm) can be answered at once: the layer is untouched, so
                // the store's list is current. A load or a removal is asking about a layer that is on its
                // way out, and `reconcileTool` answers those from the `layers` event that follows.
                if (reason === 'esc' || reason === 'host')
                    ensureArmed();
                syncStatus();
                notify();
                return;
            }
            default:
                return;
        }
    };
    // ---- subscriptions ------------------------------------------------------------------------------
    host.subscribe(host.scene.on('pointTool', onPointTool));
    host.subscribe(host.scene.on('layers', () => {
        adoptLayerPositions();
        reconcileTool();
    }));
    host.subscribe(host.scene.on('datasets', () => {
        if (pendingTsv === null)
            return;
        if (!bindVolume())
            return;
        const path = pendingTsv;
        pendingTsv = null;
        message = null;
        buildLayer();
        writeBlock();
        notify();
        host.ui.toast('info', `Contacts bound to ${ctName ?? 'the volume'} (${baseNameOf(path)}).`);
    }));
    // The off-plane column is measured against the plane through the cursor (§13.1's `activePlane`),
    // so the list is re-read whenever the crosshair moves. The rows are plain spans and there are a
    // few hundred of them at most; the info panel above already re-renders on the same edge.
    host.subscribe(host.scene.on('cursor', () => notify()));
    host.subscribe(host.scene.on('sceneCleared', () => {
        set = emptySet();
        deleted = [];
        history.clear();
        forgetOperations();
        layerId = null;
        datasetId = null;
        tsvPath = null;
        t1Path = null;
        source = null;
        savePath = null;
        saveSiblings = {};
        banner = null;
        warning = null;
        message = null;
        electrode = null;
        selectedId = null;
        ghost = true;
        wire = true;
        dotRadiusPx = CONTACT_DOT_RADIUS_PX;
        armed = false;
        wantMode = 'select';
        markDirty(false);
    }));
    // ---- the public surface ------------------------------------------------------------------------
    const run = async (command) => {
        switch (command) {
            case 'add': {
                // The engine's mode is the truth about what a click does, so the toggle asks it rather than
                // a flag of its own: after an Escape the button and the engine cannot disagree about which
                // way this press goes.
                arm(placingNow() ? 'select' : 'place');
                syncStatus();
                notify();
                return;
            }
            case 'snap': {
                const { moved, meanShiftMm } = doSnap('contact', snapRadiusMm);
                host.ui.toast('info', moved === 0
                    ? 'No metal within the snap radius.'
                    : `Snapped 1 contact, ${meanShiftMm.toFixed(2)} mm.`);
                return;
            }
            case 'snap-electrode': {
                const { moved, meanShiftMm } = doSnap('electrode', snapRadiusMm);
                host.ui.toast('info', moved === 0
                    ? 'No metal within the snap radius.'
                    : `Snapped ${moved} contacts, mean ${meanShiftMm.toFixed(2)} mm.`);
                return;
            }
            case 'snap-all': {
                const answer = await host.ui.confirm('Snap every contact?', `${set.contacts.length} contacts across ${set.groups.length} electrodes will move to the ` +
                    `local CT peak within ${snapRadiusMm} mm. Undo puts them back.`, ['Snap all', 'Cancel']);
                if (answer !== 0)
                    return;
                const { moved, meanShiftMm } = doSnap('all', snapRadiusMm);
                host.ui.toast('info', moved === 0
                    ? 'No metal within the snap radius.'
                    : `Snapped ${moved} contacts, mean ${meanShiftMm.toFixed(2)} mm.`);
                return;
            }
            case 'next':
                return step(1);
            case 'prev':
                return step(-1);
            case 'refit': {
                if (electrode === null)
                    return;
                const stats = doRefit(electrode);
                host.ui.toast('info', stats === null
                    ? 'An electrode needs two contacts to re-fit.'
                    : `Re-fitted ${electrode}: RMS ${(stats.rmsMm ?? 0).toFixed(2)} mm, pitch ${(stats.pitchMm ?? 0).toFixed(2)} mm.`);
                return;
            }
            case 'renumber': {
                if (electrode === null)
                    return;
                const renamed = doRenumber(electrode);
                host.ui.toast('info', renamed === 0
                    ? `${electrode} was already numbered tip-first.`
                    : `Renumbered ${renamed} contacts.`);
                return;
            }
            case 'flip-tip': {
                if (electrode === null)
                    return;
                if (doFlipTip(electrode) === null)
                    return;
                host.ui.toast('info', `The other end of ${electrode} is now the tip. Renumber to apply it to the names.`);
                return;
            }
            case 'ghost':
                return doGhost(!ghost);
            case 'wire':
                return doWire(!wire);
            case 'delete': {
                if (selectedId === null)
                    return;
                doDelete(selectedId);
                return;
            }
            case 'undo':
                return doUndo();
            case 'redo':
                return doRedo();
            case 'load':
                return doLoadDialog();
            case 'save': {
                busy = true;
                notify();
                try {
                    await doSave();
                }
                finally {
                    busy = false;
                    notify();
                }
                return;
            }
            case 'save-as': {
                busy = true;
                notify();
                try {
                    await doSaveAs();
                }
                finally {
                    busy = false;
                    notify();
                }
                return;
            }
            case 'revert': {
                doRevert();
                host.ui.toast('info', 'Every contact is back where the table put it.');
                return;
            }
            default:
                host.ui.toast('warn', `sEEG has no command "${command}"`);
        }
    };
    const runOperation = async (op, args) => {
        switch (op) {
            case 'load': {
                const tsv = String(args['tsv'] ?? '');
                const ct = String(args['ct'] ?? '');
                // A module cannot open a dataset — `ModuleHost` has no `addDataset` — so the CT is expected
                // to be open already: in a job file that means `scene.files` (or an `open` action) naming
                // the CT before this action. `ct`, `tsv` and `t1` are `path` arguments, so all three are
                // `${VAR}`-expanded, resolved and allow-listed by main before the window exists (§13.6) —
                // which is why the dataset can be matched on its resolved path here, with the basename as
                // the fallback for a build that opened it under a symlinked name.
                const dataset = host.scene
                    .datasets()
                    .find((d) => d.kind === 'volume' && (d.path === ct || baseNameOf(d.path ?? '') === baseNameOf(ct)));
                if (dataset !== undefined) {
                    datasetId = dataset.id;
                    ctName = dataset.name;
                }
                const text = await host.files.readText(tsv);
                if (text === null)
                    throw new ModuleHostError(`could not read ${tsv}`);
                const ok = applyTable(tsv, text);
                if (!ok)
                    throw new ModuleHostError(`${baseNameOf(tsv)} is not a usable electrodes table`);
                // After the CT binds, because {@link showT1} writes the block and `applyTable` is what
                // creates the `source` it writes into. Absent `t1` reports nothing at all, which is what
                // makes the field additive for every job written before it did anything.
                const wanted = args['t1'];
                const t1 = typeof wanted === 'string' && wanted !== '' ? showT1(wanted) : null;
                if (t1 === 'not-open') {
                    host.ui.toast('warn', `${baseNameOf(String(wanted))} is not open, so the contacts have no anatomy under them. Add it to the job's scene files.`);
                }
                return {
                    contacts: set.contacts.length,
                    electrodes: set.groups.length,
                    bound: layerId !== null,
                    ...(t1 === null ? {} : { t1 }),
                };
            }
            case 'snap': {
                const scope = String(args['scope'] ?? 'all');
                if (scope !== 'contact' && scope !== 'electrode' && scope !== 'all') {
                    throw new ModuleHostError(`snap scope must be contact, electrode or all (got "${scope}")`);
                }
                const wantedElectrode = args['electrode'];
                if (typeof wantedElectrode === 'string')
                    electrode = wantedElectrode;
                const wantedContact = args['contact'];
                if (typeof wantedContact === 'string') {
                    const found = set.contacts.find((c) => c.name === wantedContact || c.id === wantedContact);
                    selectedId = found?.id ?? null;
                    if (found !== undefined)
                        electrode = found.group;
                }
                const radius = args['radiusMm'];
                const radiusMm = typeof radius === 'number' ? clampSnapRadius(radius) : snapRadiusMm;
                return doSnap(scope, radiusMm);
            }
            case 'refit': {
                const wanted = args['electrode'];
                const groups = typeof wanted === 'string' ? [wanted] : set.groups.map((g) => g.name);
                const results = groups
                    .map((group) => doRefit(group))
                    .filter((s) => s !== null)
                    .map((s) => ({ electrode: s.electrode, rmsMm: s.rmsMm, spacingCv: s.spacingCv }));
                // Wrapped in an object because `ModuleInstance.runOperation` answers a `Record`, and
                // `host.ts` is frozen: an array is not one.
                return { electrodes: results };
            }
            case 'renumber': {
                const wanted = args['electrode'];
                const groups = typeof wanted === 'string' ? [wanted] : set.groups.map((g) => g.name);
                const results = groups.map((group) => ({ electrode: group, renamed: doRenumber(group) }));
                return { electrodes: results };
            }
            case 'ghost': {
                doGhost(args['on'] === true);
                return { ghost };
            }
            case 'wire': {
                doWire(args['on'] === true);
                return { wire };
            }
            // The third display switch (2026-08-30). `doSize` is the panel stepper's own function, so the
            // 2–12 clamp, the layer write and the scene block are one code path — a job that asks for 40
            // gets 12 and is told so by the `dotRadiusPx` this answers with, rather than getting a
            // marker the panel could never have made.
            case 'size': {
                doSize(Number(args['px']));
                return { dotRadiusPx };
            }
            case 'stats':
                return { electrodes: allShaftStats(set) };
            // The three appended 2026-08-30. Each is a deterministic edit to a **named** electrode or
            // contact — no pointer, no dialog, no confirmation — so §13.6's "every panel action is also an
            // operation" is true of them and a headless run has the remedies a person has. The motivating
            // one is `flip-tip`: `tip: 'auto'` is a heuristic this module's own DECISIONS entry concedes
            // an occipital shaft can defeat, and without it a job could only renumber tip-last and live
            // with it.
            case 'flip-tip': {
                const wanted = args['electrode'];
                // Every electrode when none is named — the shape `refit` and `renumber` already read.
                const groups = typeof wanted === 'string' ? [wanted] : set.groups.map((g) => g.name);
                const electrodes = groups
                    .map((group) => ({ electrode: group, tip: doFlipTip(group) }))
                    .filter((r) => r.tip !== null);
                return { electrodes };
            }
            case 'revert':
                return doRevert();
            case 'delete': {
                const wanted = String(args['contact'] ?? '');
                if (wanted === '')
                    throw new ModuleHostError('delete needs a `contact` name');
                const found = findContact(wanted);
                if (found === null)
                    throw new ModuleHostError(`no contact called "${wanted}"`);
                doDelete(found.id);
                return { deleted: found.name, contacts: set.contacts.length };
            }
            case 'save': {
                const out = String(args['out'] ?? '');
                if (out === '')
                    throw new ModuleHostError('save needs an `out` name');
                // A `--job` window's Save sheet never opens, so nothing here comes from a dialog: `run.ts`
                // hands `out` over as an absolute path under `--out`, and `job-runner.ts` has already put
                // that path — and this writer's `{stem}_editlog.json` beside it — on this module's write
                // list (§13.6). A relative `out` is a harness calling the operation directly, and then it
                // means "beside the table that was loaded", which is the only other directory in play.
                const directory = tsvPath === null ? '' : tsvPath.slice(0, Math.max(0, tsvPath.lastIndexOf('/') + 1));
                const path = out.startsWith('/') ? out : `${directory}${out}`;
                // The editlog is a sibling of the file being **written**, never of the table that was read:
                // main admitted `{stem}_editlog.json` in the resolved path's own directory, so anywhere else
                // is both the wrong place and a write `module-write-text` refuses.
                const writtenIn = path.slice(0, Math.max(0, path.lastIndexOf('/') + 1));
                const siblings = { [EDITLOG_TEMPLATE]: `${writtenIn}${editlogNameFor(baseNameOf(path))}` };
                const result = await writeFiles(path, siblings);
                if (result === null)
                    throw new ModuleHostError(`could not write ${path}`);
                return { path: result.path, editlog: result.editlog };
            }
            default:
                throw new ModuleHostError(`sEEG has no operation "${op}"`);
        }
    };
    /**
     * A scene that carries this module's layer but **no block** — §13.2's degradation contract, in the
     * case `restoreBlock` never runs because there is nothing to restore.
     *
     * `activateModule` only calls `restoreBlock` when the scene had a block, so a scene re-saved by a
     * build without this module would otherwise open the module empty over a layer full of contacts.
     */
    const adoptOrphanLayer = () => {
        if (host.scene.block() !== null)
            return;
        const layer = ownedLayer();
        if (layer === null || (layer.points ?? []).length === 0)
            return;
        layerId = layer.id;
        datasetId = layer.datasetId;
        ctName = host.scene.datasets().find((d) => d.id === layer.datasetId)?.name ?? null;
        set = contactSetFromLayer(layer);
        namePad = namePadOfLayer(layer);
        source = null;
        tsvPath = null;
        t1Path = null;
        electrode = set.groups[0]?.name ?? null;
        ghost = (layer.offPlaneOpacity ?? 0) > 0;
        message =
            'This scene was saved without the module’s record, so where these contacts came from is unknown. Save as… to write a table.';
        host.ui.toast('warn', 'sEEG: provenance lost — the contacts are here, the table they came from is not.');
        armed = true;
        ensureArmed();
        markDirty(false);
    };
    adoptOrphanLayer();
    return {
        state: view,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        run,
        runOperation,
        async openPath(readerId, path) {
            if (readerId !== 'electrodes')
                return false;
            const text = await host.files.readText(path);
            if (text === null) {
                host.ui.toast('error', `Could not read ${baseNameOf(path)}.`);
                // Claimed and unreadable: `true`, so the app does not then try to open a table as a volume.
                return true;
            }
            applyTable(path, text);
            const found = await host.files.siblings(path);
            const bundle = bundleOf(found);
            if (bundle.editlog !== null)
                await readEditlogBanner(bundle.editlog);
            if (bundle.ct !== null && datasetId === null) {
                message = `Open ${baseNameOf(bundle.ct)} beside this table to edit the contacts on it.`;
                notify();
            }
            return true;
        },
        async onSibling(anchor, found) {
            const bundle = bundleOf(found);
            if (bundle.tsv !== null && tsvPath === null) {
                const text = await host.files.readText(bundle.tsv);
                if (text !== null)
                    applyTable(bundle.tsv, text);
            }
            else if (datasetId === null || pendingTsv !== null) {
                // The CT arrived after the table: bind and build.
                if (bindVolume() && pendingTsv !== null) {
                    pendingTsv = null;
                    message = null;
                    buildLayer();
                    writeBlock();
                    notify();
                }
            }
            if (bundle.editlog !== null)
                await readEditlogBanner(bundle.editlog);
        },
        async restoreBlock(block) {
            const data = fromBlock(block.data);
            const layer = ownedLayer();
            if (layer === null) {
                // The scene carried a block but no layer of ours — nothing to restore onto.
                if (data !== null) {
                    snapRadiusMm = clampSnapRadius(data.snapRadiusMm);
                    ghost = data.ghost;
                    wire = data.wire;
                    dotRadiusPx = clampDotRadius(data.dotRadiusPx);
                    namePad = data.namePad;
                }
                notify();
                return;
            }
            layerId = layer.id;
            datasetId = layer.datasetId;
            ctName = host.scene.datasets().find((d) => d.id === layer.datasetId)?.name ?? null;
            const rebuilt = contactSetFromLayer(layer);
            namePad = data?.namePad ?? namePadOfLayer(layer);
            set = data === null ? rebuilt : mergeBlockIntoSet(rebuilt, data);
            source = data?.source ?? null;
            tsvPath = source?.tsv ?? null;
            // Provenance only: the T1 is not reopened from here, because a module cannot open a dataset.
            t1Path = source?.t1 ?? null;
            savePath = null;
            saveSiblings = {};
            snapRadiusMm = clampSnapRadius(data?.snapRadiusMm ?? SNAP_RADIUS_DEFAULT_MM);
            ghost = data?.ghost ?? true;
            wire = data?.wire ?? true;
            dotRadiusPx = clampDotRadius(data?.dotRadiusPx ?? CONTACT_DOT_RADIUS_PX);
            electrode = set.groups[0]?.name ?? null;
            selectedId = null;
            // The deletions come back with the block: the layer cannot carry them — a deleted contact is
            // simply not a point any more — so without this the editlog written after a scene round trip
            // would report `deleted: 0` beside a table that is missing the rows, and Revert would quietly
            // stop being able to put them back.
            deleted = (data?.deleted ?? []).map(contactFromDeleted);
            history.clear();
            // The operations that ran before this scene was written are the file's history, not this
            // session's: what a save writes now is what happened to *this* restored table.
            forgetOperations();
            warning = tsvPath === null ? null : seegprepWarning(tsvPath);
            if (namePad === 0)
                namePad = namePadOf(set.contacts.map((c) => c.name));
            if (source === null || source.tsv === null) {
                // §13.2's degradation contract, said out loud rather than guessed at.
                message =
                    'This scene was saved without the module’s record, so where these contacts came from is unknown. Save as… to write a table.';
                host.ui.toast('warn', 'sEEG: provenance lost — the contacts are here, the table they came from is not.');
            }
            else {
                message = null;
            }
            armed = true;
            writeLayer();
            ensureArmed();
            markDirty(false);
        },
        dirty: () => isDirty,
        dispose() {
            disarm();
            host.ui.status(null);
            listeners.clear();
        },
        setElectrode(name) {
            electrode = name;
            if (placingNow())
                arm('place');
            notify();
        },
        setSnapRadius(mm) {
            snapRadiusMm = clampSnapRadius(mm);
            writeBlock();
            notify();
        },
        setSize(px) {
            doSize(px);
        },
        jumpTo(id) {
            selectContact(id);
        },
        deleteContact(id) {
            doDelete(id);
        },
    };
}

/**
 * The sEEG panel — what the module slot renders (ARCHITECTURE.md §13.3).
 *
 * Chrome only, exactly like every §8 panel: it reads `SeegView` through `useSyncExternalStore` and
 * every control is one `model` call, which is one command, which is also one job operation. There is
 * no `useController`, no `useUi` and no `Engine` here, and there cannot be — the module wall forbids
 * the imports that would make it possible.
 *
 * The layout is the design's, top to bottom: the source line, the electrode row (dropdown, count,
 * swatch, snap radius), two rows of buttons, the live shaft numbers, the contact list, and a footer
 * with Undo / Redo / Save / Save as… and the changed count. The whole thing lives inside the slot's
 * `max-h-[55%]` scroller, so the list is what scrolls and the footer is what stays.
 *
 * **Buttons blur on click**, which is not a style choice: the engine's Space-drag pan modifier is a
 * window keydown, so a focused button left focused turns the next Space into a button press
 * (`input/pointer.ts`). Every control here does it, including the ones in the list.
 */
const CHORDS = {
    add: "a",
    snap: "s",
    "snap-electrode": "⇧S",
    refit: "f",
    "flip-tip": "t",
    ghost: "g",
    wire: "d",
    next: "n",
    prev: "p",
    undo: "z",
    redo: "⇧Z",
};
function blur(event) {
    event.currentTarget.blur();
}
function millimetres(value) {
    return value === null ? "—" : `${value.toFixed(1)} mm`;
}
function ratio(value) {
    return value === null ? "—" : `${(value * 100).toFixed(0)} %`;
}
function StatusChip({ status }) {
    const tone = status === "added"
        ? "text-tvx-accent"
        : status === "edited"
            ? "text-tvx-warn"
            : "text-tvx-dim";
    return createElement("span", { className: `w-12 shrink-0 truncate ${tone}` }, status);
}
function ContactRow({ row, model, }) {
    return (createElement("li", { "data-testid": `seeg-row-${row.name}`, "data-selected": row.selected, "data-status": row.status, className: `flex items-center gap-1 text-[11px] ${row.selected ? "text-tvx-text" : ""}`, 
        /*
          The selected row is marked with an inline style, not a utility class: the panel ships as a
          downloadable bundle and Tailwind only compiles the classes it finds in the *app's* sources,
          so a class this file is the sole user of would resolve to nothing in a packaged build. The
          two theme variables are the app's own, so it re-themes with everything else.
        */
        style: row.selected
            ? {
                backgroundColor: "var(--color-tvx-accent-surface)",
                boxShadow: "inset 2px 0 0 0 var(--color-tvx-accent)",
                borderRadius: "2px",
            }
            : undefined },
        createElement("button", { type: "button", "data-testid": `seeg-select-${row.name}`, className: `w-16 shrink-0 truncate text-left tabular-nums hover:text-tvx-accent ${row.selected ? "font-semibold text-tvx-accent-strong" : ""}`, title: row.selected
                ? `${row.name} — the selected contact`
                : row.tip
                    ? `${row.name} — this electrode is numbered from here`
                    : row.name, onClick: (event) => {
                blur(event);
                model.jumpTo(row.id);
            } },
            row.tip ? "▸" : " ",
            row.name),
        createElement(StatusChip, { status: row.status }),
        createElement("span", { className: "flex-1 text-right tabular-nums text-tvx-dim", title: "from the active pane's plane" }, millimetres(row.offPlaneMm)),
        createElement("button", { type: "button", "data-testid": `seeg-jump-${row.name}`, className: "tvx-btn tvx-btn-sm", title: "Put the crosshair on this contact", onClick: (event) => {
                blur(event);
                model.jumpTo(row.id);
            } }, "\u2197"),
        createElement("button", { type: "button", "data-testid": `seeg-delete-${row.name}`, className: "tvx-btn tvx-btn-sm", title: "Delete this contact", onClick: (event) => {
                blur(event);
                model.deleteContact(row.id);
            } }, "\u2715")));
}
function SeegPanel({ model }) {
    const view = useSyncExternalStore(model.subscribe, model.state, model.state);
    const command = (id) => (event) => {
        blur(event);
        void model.run(id);
    };
    const label = (id, text) => {
        const chord = CHORDS[id];
        return chord === undefined ? text : `${text} (${chord})`;
    };
    // The sketch is drawn in the electrode's own colour — the same one the swatch shows — so it reads
    // as this shaft and not a generic diagram. `currentColor` is the fallback for a set with no colour.
    const shaftColor = view.electrodes.find((e) => e.name === view.electrode)?.color ??
        "currentColor";
    return (createElement("div", { "data-testid": "seeg-panel", className: "flex flex-col gap-1.5 text-[11px]" },
        createElement("div", { className: "flex items-center gap-1.5" },
            createElement("p", { "data-testid": "seeg-source", className: "min-w-0 flex-1 truncate text-tvx-dim", title: "the files this is editing" }, view.ctName === null && view.tsvName === null ? ("Open a CT and its electrodes table.") : (createElement(react.Fragment, null,
                view.subject !== null && (createElement("span", { className: "text-tvx-text" },
                    view.subject,
                    " \u00B7 ")),
                view.ctName ?? "no CT",
                " \u00B7 ",
                view.tsvName ?? "no table"))),
            createElement("button", { type: "button", "data-testid": "seeg-open", className: "tvx-btn tvx-btn-sm shrink-0", title: "Open an electrodes table this module did not claim by name", onClick: command("load") }, "Open\u2026")),
        view.banner !== null && (createElement("p", { "data-testid": "seeg-banner", className: "text-tvx-warn" }, view.banner)),
        view.warning !== null && (createElement("p", { "data-testid": "seeg-warning", className: "text-tvx-warn" }, view.warning)),
        view.message !== null && (createElement("p", { "data-testid": "seeg-message", className: "text-tvx-dim" }, view.message)),
        createElement("div", { className: "flex items-center gap-1.5" },
            createElement("select", { "data-testid": "seeg-electrode", className: "tvx-input min-w-0 flex-1", value: view.electrode ?? "", disabled: view.electrodes.length === 0, onChange: (event) => model.setElectrode(event.target.value) },
                view.electrodes.length === 0 && (createElement("option", { value: "" }, "no electrodes")),
                view.electrodes.map((option) => (createElement("option", { key: option.name, value: option.name },
                    option.name,
                    " (",
                    option.count,
                    ")")))),
            createElement("span", { "data-testid": "seeg-swatch", className: "h-3 w-3 shrink-0 rounded-sm border border-tvx-line", style: {
                    backgroundColor: view.electrodes.find((e) => e.name === view.electrode)?.color ??
                        "transparent",
                } }),
            createElement("label", { className: "flex shrink-0 items-center gap-1 text-tvx-dim", title: "snap radius" },
                "r",
                createElement("input", { "data-testid": "seeg-radius", type: "number", className: "tvx-input w-14 tabular-nums", min: 0.5, max: 5, step: 0.25, value: view.snapRadiusMm, onChange: (event) => model.setSnapRadius(Number(event.target.value)) }))),
        createElement("div", { className: "flex flex-wrap items-center gap-1" },
            createElement("button", { type: "button", "data-testid": "seeg-add", "aria-pressed": view.placing, className: `tvx-btn ${view.placing ? "tvx-btn-on" : ""}`, title: label("add", "Every click in a pane drops a contact on this electrode"), onClick: command("add") }, "Add"),
            createElement("button", { type: "button", "data-testid": "seeg-snap", className: "tvx-btn", disabled: view.selectedId === null, title: label("snap", "Snap the selected contact to the local CT peak"), onClick: command("snap") }, "Snap"),
            createElement("button", { type: "button", "data-testid": "seeg-snap-electrode", className: "tvx-btn", title: label("snap-electrode", "Snap every contact of this electrode"), onClick: command("snap-electrode") }, "Snap elec"),
            createElement("button", { type: "button", "data-testid": "seeg-snap-all", className: "tvx-btn", title: "Snap every contact of every electrode (asks first)", onClick: command("snap-all") }, "Snap all\u2026")),
        createElement("div", { className: "flex flex-wrap items-center gap-1" },
            createElement("button", { type: "button", "data-testid": "seeg-refit", className: "tvx-btn", title: label("refit", "Fit a line, re-space evenly at the median gap, relabel tip-first"), onClick: command("refit") }, "Re-fit"),
            createElement("button", { type: "button", "data-testid": "seeg-renumber", className: "tvx-btn", title: "Number this electrode 1\u2026n from the tip, without moving anything", onClick: command("renumber") }, "Renumber"),
            createElement("button", { type: "button", "data-testid": "seeg-flip-tip", className: "tvx-btn", title: label("flip-tip", "Use the other end of this electrode as contact 1"), onClick: command("flip-tip") }, "Flip tip"),
            createElement("button", { type: "button", "data-testid": "seeg-ghost", "aria-pressed": view.ghost, className: `tvx-btn ${view.ghost ? "tvx-btn-on" : ""}`, title: label("ghost", "Draw off-slice contacts, so a shaft reads as a shaft"), onClick: command("ghost") }, "Ghost"),
            createElement("button", { type: "button", "data-testid": "seeg-wire", "aria-pressed": view.wire, className: `tvx-btn ${view.wire ? "tvx-btn-on" : ""}`, title: label("wire", "Draw the shaft line between consecutive contacts"), onClick: command("wire") }, "Wire"),
            createElement("button", { type: "button", "data-testid": "seeg-revert", className: "tvx-btn", title: "Put every contact back where the table had it", onClick: command("revert") }, "Revert"),
            createElement("span", { className: "ml-auto flex shrink-0 items-center gap-1 text-tvx-dim" },
                createElement("span", { title: "how big a contact is drawn, in pixels" }, "size"),
                createElement("button", { type: "button", "data-testid": "seeg-size-down", className: "tvx-btn tvx-btn-sm", disabled: view.dotRadiusPx <= view.sizeBounds.min, title: "Smaller contacts", onClick: (event) => {
                        blur(event);
                        model.setSize(view.dotRadiusPx - view.sizeBounds.step);
                    } }, "\u2212"),
                createElement("span", { "data-testid": "seeg-size", className: "w-4 text-center tabular-nums text-tvx-text" }, view.dotRadiusPx),
                createElement("button", { type: "button", "data-testid": "seeg-size-up", className: "tvx-btn tvx-btn-sm", disabled: view.dotRadiusPx >= view.sizeBounds.max, title: "Bigger contacts", onClick: (event) => {
                        blur(event);
                        model.setSize(view.dotRadiusPx + view.sizeBounds.step);
                    } }, "+"))),
        createElement("p", { "data-testid": "seeg-stats", className: "tabular-nums text-tvx-dim" }, view.stats === null ? ("no electrode selected") : (createElement(react.Fragment, null,
            "rms ",
            millimetres(view.stats.rmsMm),
            " \u00B7 spacing cv",
            " ",
            ratio(view.stats.spacingCv),
            " \u00B7 pitch",
            " ",
            millimetres(view.stats.pitchMm),
            view.tipName !== null && (createElement(react.Fragment, null,
                " ",
                "\u00B7 tip ",
                createElement("span", { "data-testid": "seeg-tip" }, view.tipName)))))),
        view.diagram !== null && (createElement("svg", { "data-testid": "seeg-diagram", className: "h-5 w-full", viewBox: `0 0 ${view.diagram.width} ${view.diagram.height}`, preserveAspectRatio: "none", role: "img", "aria-label": "the selected electrode, drawn as a shaft" },
            createElement("line", { x1: view.diagram.line.x1, y1: view.diagram.line.y1, x2: view.diagram.line.x2, y2: view.diagram.line.y2, stroke: shaftColor, strokeWidth: 1, strokeOpacity: 0.5 }),
            view.diagram.dots.map((dot, index) => (createElement("g", { key: index },
                dot.selected && (createElement("circle", { "data-testid": "seeg-diagram-selected", cx: dot.cx, cy: dot.cy, r: dot.tip ? 6 : 5, fill: "none", stroke: "var(--color-tvx-accent)", strokeWidth: 1.5 })),
                createElement("circle", { cx: dot.cx, cy: dot.cy, r: dot.tip ? 3 : 2, fill: shaftColor })))))),
        createElement("ul", { "data-testid": "seeg-list", className: "flex flex-col gap-0.5" }, view.rows.map((row) => (createElement(ContactRow, { key: row.id, row: row, model: model })))),
        createElement("div", { className: "flex items-center gap-1 border-t border-tvx-line pt-1" },
            createElement("button", { type: "button", "data-testid": "seeg-undo", className: "tvx-btn", disabled: !view.canUndo, title: label("undo", "Undo the last edit"), onClick: command("undo") }, "Undo"),
            createElement("button", { type: "button", "data-testid": "seeg-redo", className: "tvx-btn", disabled: !view.canRedo, title: label("redo", "Redo"), onClick: command("redo") }, "Redo"),
            createElement("button", { type: "button", "data-testid": "seeg-save", className: "tvx-btn", disabled: view.busy, title: "Write the table, its backup and its editlog", onClick: command("save") }, "Save"),
            createElement("button", { type: "button", "data-testid": "seeg-save-as", className: "tvx-btn", disabled: view.busy, title: "Choose where to write the table", onClick: command("save-as") }, "Save as\u2026"),
            createElement("span", { "data-testid": "seeg-changed", className: "ml-auto tabular-nums text-tvx-dim" },
                view.dirty && "• ",
                view.changed,
                " changed"))));
}

/**
 * `tetravox.seeg` — the sEEG contact editor's `activate` (ARCHITECTURE.md §13.1).
 *
 * Deliberately thin: `editor.ts` holds the state and every command, `Panel.tsx` is chrome, and this
 * is the `ModuleInstance` that connects them to the host. The whole of §13.6's promise is visible
 * here — `runCommand` and `runOperation` reach the same model, so a button and a job file cannot
 * drift apart.
 *
 * **Imports.** `@tetravox/module-sdk` and this directory, and nothing else — the host surface, the
 * contacts kit (through `editor.ts`) and React all arrive through the one package, because a
 * downloaded bundle resolves no bare specifier of its own. `scripts/check-bundle.mjs` re-proves it
 * by reading the built file.
 */
const activate = (host) => {
    const model = createModel(host);
    return {
        Panel: () => createElement(SeegPanel, { model }),
        runCommand(id) {
            return model.run(id);
        },
        runOperation(op, args) {
            return model.runOperation(op, args);
        },
        openPath(readerId, path) {
            return model.openPath(readerId, path);
        },
        onSibling(anchor, found) {
            return model.onSibling(anchor, found);
        },
        restoreBlock(block) {
            return model.restoreBlock(block);
        },
        dirty: () => model.dirty(),
        dispose() {
            model.dispose();
        },
    };
};

export { activate };
