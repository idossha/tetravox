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

import type {
  Dataset,
  Layer,
  LayerId,
  PointsLayer,
  PointToolEvent,
  VolumeLayer,
  vec3,
} from '@tetravox/engine';
import type { ExtensionBlock, ModuleHost } from '../host';
import { ModuleHostError } from '../host';
import type { Contact, ContactSet } from '../shared/contacts/model';
import {
  cloneSet,
  contactName,
  contactsOf,
  dirtyCount,
  emptySet,
  hasMoved,
  namePadOf,
  statusOf,
} from '../shared/contacts/model';
import {
  CANONICAL_FIELDNAMES,
  ContactTableError,
  contactSetFrom,
  newContact,
  parseTable,
  resolveColumns,
  writeTable,
} from '../shared/contacts/tsv';
import type { ColumnMap } from '../shared/contacts/tsv';
import { buildEditlog, editlogDate, formatEditlog } from '../shared/contacts/editlog';
import type { DeletedContact } from '../shared/contacts/editlog';
import { cssColor, paletteColor } from '../shared/contacts/palette';
import {
  CONTACT_LAYER_STYLE,
  contactLayerName,
  contactSetFromLayer,
  ctDisplayPreset,
  layerPatch,
  namePadOfLayer,
  t1DisplayPreset,
} from '../shared/contacts/layer';
import {
  applySnap,
  clampSnapRadius,
  SNAP_RADIUS_DEFAULT_MM,
  snapContacts,
} from '../shared/contacts/snap';
import type { ShaftStats } from './shaft';
import {
  allShaftStats,
  flippedTip,
  refitShaft,
  renumberTipFirst,
  resolveTip,
  shaftStats,
  tipFirstOrder,
  tipReference,
} from './shaft';
import type { SeegBlock, SeegBlockSource } from './block';
import { fromBlock, mergeBlockIntoSet, shrinkBlock, toBlock } from './block';
import {
  baseNameOf,
  bundleOf,
  editlogNameFor,
  FROM_TSV_EDITLOG,
  seegprepWarning,
  stemOf,
  subjectOf,
} from './bids';

/** The writer's sibling templates, as the manifest declares them. */
const BACKUP_TEMPLATE = '{name}.{stamp}.bak';
const EDITLOG_TEMPLATE = '{stem}_editlog.json';

/** `manifest.version`, quoted into the editlog's `tool` field. */
const TOOL = 'Tetravox sEEG contacts 0.1.0';

/** One row of the panel's contact list. */
export interface SeegRow {
  id: string;
  name: string;
  status: string;
  /** Distance from the active pane's plane, in millimetres, or `null` in the 3-D pane. */
  offPlaneMm: number | null;
  selected: boolean;
  /** True for the contact this electrode is numbered from. */
  tip: boolean;
}

export interface SeegElectrodeOption {
  name: string;
  count: number;
  /** `#rrggbb`, for the swatch. */
  color: string;
}

/** Everything `Panel.tsx` renders. A plain object, replaced on every change. */
export interface SeegView {
  ready: boolean;
  subject: string | null;
  ctName: string | null;
  tsvName: string | null;
  banner: string | null;
  warning: string | null;
  provenance: 'file' | 'unknown';
  electrodes: SeegElectrodeOption[];
  electrode: string | null;
  snapRadiusMm: number;
  ghost: boolean;
  placing: boolean;
  stats: ShaftStats | null;
  tipName: string | null;
  rows: SeegRow[];
  selectedId: string | null;
  dirty: boolean;
  changed: number;
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  message: string | null;
}

interface Snapshot {
  set: ContactSet;
  deleted: Contact[];
  namePad: number;
}

interface HistoryEntry {
  before: Snapshot;
  after: Snapshot;
}

const CT_NAME = /(^|[^a-z])ct([^a-z]|$)|_ct\./i;

function dot(a: vec3, b: vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The canonical source a set with no file of its own is written against. */
function canonicalSource(): SeegBlockSource {
  return {
    tsv: null,
    coordsystem: null,
    t1: null,
    fieldnames: [...CANONICAL_FIELDNAMES],
    columns: resolveColumns(CANONICAL_FIELDNAMES),
    delimiter: 'tab',
  };
}

export interface SeegModel {
  state(): SeegView;
  subscribe(listener: () => void): () => void;
  run(command: string): void | Promise<void>;
  runOperation(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  openPath(readerId: string, path: string): Promise<boolean>;
  onSibling(anchor: string, found: Record<string, string | null>): Promise<void>;
  restoreBlock(block: ExtensionBlock): Promise<void>;
  dirty(): boolean;
  dispose(): void;
  // Panel-only entry points. Each one is a command with an argument the keyboard cannot supply.
  setElectrode(name: string): void;
  setSnapRadius(mm: number): void;
  jumpTo(id: string): void;
  deleteContact(id: string): void;
}

export function createModel(host: ModuleHost): SeegModel {
  // ---- state -----------------------------------------------------------------------------------
  let set: ContactSet = emptySet();
  let deleted: Contact[] = [];
  let namePad = 2;
  let snapRadiusMm = SNAP_RADIUS_DEFAULT_MM;
  let ghost = true;
  let electrode: string | null = null;
  let selectedId: string | null = null;
  let placing = false;
  let source: SeegBlockSource | null = null;
  let savePath: string | null = null;
  let saveSiblings: Record<string, string> = {};
  let banner: string | null = null;
  let warning: string | null = null;
  let message: string | null = null;
  let busy = false;
  let layerId: LayerId | null = null;
  let datasetId: string | null = null;
  let ctName: string | null = null;
  let tsvPath: string | null = null;
  /** The T1 a `load` operation named and found open, for the block's `source` (§13.6). */
  let t1Path: string | null = null;
  let pendingTsv: string | null = null;
  let isDirty = false;
  let armed = false;
  let dragBase: Snapshot | null = null;
  const operations = {
    refit: new Set<string>(),
    renumbered: new Set<string>(),
    snapped: new Set<string>(),
  };

  const listeners = new Set<() => void>();
  const history = host.history<HistoryEntry>(50);
  let cached: SeegView | null = null;

  const notify = (): void => {
    cached = null;
    for (const listener of listeners) listener();
  };

  // ---- snapshots and history -------------------------------------------------------------------

  const snapshot = (): Snapshot => ({
    set: cloneSet(set),
    deleted: deleted.map((c) => ({ ...c, position: [...c.position] as vec3 })),
    namePad,
  });

  const restore = (state: Snapshot): void => {
    set = cloneSet(state.set);
    deleted = state.deleted.map((c) => ({ ...c, position: [...c.position] as vec3 }));
    namePad = state.namePad;
    writeLayer();
    writeBlock();
    markDirty(true);
  };

  const markDirty = (dirty: boolean): void => {
    isDirty = dirty;
    host.ui.setDirty(dirty);
    syncStatus();
    notify();
  };

  /** Commit an edit: one history entry, one dirty mark, one layer write, one block write. */
  const commit = (before: Snapshot): void => {
    history.push({ before, after: snapshot() });
    writeLayer();
    writeBlock();
    markDirty(true);
  };

  // ---- the scene ---------------------------------------------------------------------------------

  const layerOf = (): PointsLayer | null => {
    if (layerId === null) return null;
    const found = host.scene.layers().find((l) => l.id === layerId);
    return found !== undefined && found.kind === 'points' ? found : null;
  };

  /** This module's layer, found by `LayerBase.module` — how a module finds itself after a load. */
  const ownedLayer = (): PointsLayer | null => {
    const found = host.scene
      .layers()
      .find((l): l is PointsLayer => l.kind === 'points' && l.module === host.id);
    return found ?? null;
  };

  const volumes = (): Dataset[] => host.scene.datasets().filter((d) => d.kind === 'volume');

  /** The CT: a volume whose name says so, else the first volume there is. */
  const chooseVolume = (): Dataset | null => {
    const all = volumes();
    return all.find((d) => CT_NAME.test(d.name)) ?? all[0] ?? null;
  };

  const boundsOfVolume = (): { min: vec3; max: vec3 } | null => {
    const dataset = host.scene.datasets().find((d) => d.id === datasetId);
    return dataset === undefined ? null : dataset.bounds;
  };

  const reference = (): vec3 => tipReference(boundsOfVolume(), set);

  const writeLayer = (): void => {
    if (layerId === null) return;
    host.scene.updateLayer<PointsLayer>(layerId, layerPatch(set, ghost));
  };

  /**
   * Write the module's block, shrinking it rather than losing it when a very large table would blow
   * §13.2's 256 KiB cap. The host throws for an oversized block; two fallbacks, then a warning.
   */
  const writeBlock = (): void => {
    const input = { set, source, snapRadiusMm, namePad, ghost };
    const attempts: SeegBlock[] = [
      toBlock(input),
      shrinkBlock(toBlock(input), 1),
      shrinkBlock(toBlock(input), 2),
    ];
    for (const [level, block] of attempts.entries()) {
      try {
        host.scene.setBlock<SeegBlock>(block);
        if (level > 0) {
          host.ui.toast(
            'warn',
            level === 1
              ? 'This table is too large for a scene block to carry its original columns; positions are still recorded.'
              : 'This table is too large for a scene block; reopening this scene will not know where the contacts came from.'
          );
        }
        return;
      } catch (error: unknown) {
        if (!(error instanceof ModuleHostError)) throw error;
      }
    }
  };

  const syncStatus = (): void => {
    if (set.contacts.length === 0) {
      host.ui.status(null);
      return;
    }
    const changed = dirtyCount(set, deleted.length);
    const parts = [`sEEG ${set.contacts.length}`];
    if (changed > 0) parts.push(`${changed} edited`);
    if (placing) parts.push('place');
    host.ui.status(parts.join(' · ').slice(0, 40));
  };

  // ---- the point tool ----------------------------------------------------------------------------

  const arm = (mode: 'select' | 'place'): void => {
    const layer = layerOf();
    if (layer === null) return;
    const current = host.tool.pointTool();
    if (current?.layerId === layer.id && current.mode === mode) return;
    const group = electrode ?? set.groups[0]?.name ?? 'E';
    const color = set.groups.find((g) => g.name === group)?.color ?? paletteColor(0);
    armed = true;
    host.tool.setPointTool({
      layerId: layer.id,
      mode,
      template: { group, color, radiusMm: CONTACT_LAYER_STYLE.radiusMm },
    });
  };

  const disarm = (): void => {
    armed = false;
    placing = false;
    if (host.tool.pointTool() !== null) host.tool.setPointTool(null);
  };

  /** Re-arm after the engine cleared the tool — `Engine.load` does, and so does removing the layer. */
  const ensureArmed = (): void => {
    if (!armed) return;
    const layer = layerOf() ?? ownedLayer();
    if (layer === null) return;
    layerId = layer.id;
    if (host.tool.pointTool()?.layerId === layer.id) return;
    arm(placing ? 'place' : 'select');
  };

  // ---- building the layer -------------------------------------------------------------------------

  const applyDisplayPreset = (): void => {
    if (datasetId === null) return;
    const layers = host.scene.layers();
    const ct = layers.find((l) => l.kind === 'volume' && l.datasetId === datasetId);
    if (ct === undefined) return;
    host.scene.updateLayer<VolumeLayer>(ct.id, ctDisplayPreset());
    // "CT above T1" is the other half of Slicer's preset and the one this host cannot do: there is
    // no `reorderLayers` on `ModuleHost`, and adding one for a display nicety is not worth a frozen
    // change. Say so instead of leaving the CT invisible under an opaque T1.
    const above = layers.filter(
      (l): l is Layer => l.kind === 'volume' && l.datasetId !== datasetId && l.visible
    );
    const ctIndex = layers.indexOf(ct);
    if (above.some((l) => layers.indexOf(l) > ctIndex)) {
      host.ui.toast(
        'info',
        'Another volume is drawn above the CT — raise the CT in the layer panel so the 150 HU floor shows the anatomy underneath.'
      );
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
  const showT1 = (candidate: string): 'shown' | 'not-open' => {
    const name = baseNameOf(candidate);
    const dataset = host.scene
      .datasets()
      .find(
        (d) =>
          d.kind === 'volume' &&
          d.id !== datasetId &&
          (d.path === candidate || baseNameOf(d.path ?? '') === name)
      );
    if (dataset === undefined) return 'not-open';
    const layer = host.scene
      .layers()
      .find((l) => l.kind === 'volume' && l.datasetId === dataset.id);
    if (layer !== undefined) host.scene.updateLayer<VolumeLayer>(layer.id, t1DisplayPreset());
    t1Path = dataset.path ?? candidate;
    if (source !== null) {
      source = { ...source, t1: t1Path };
      writeBlock();
    }
    return 'shown';
  };

  const buildLayer = (): void => {
    const dataset = host.scene.datasets().find((d) => d.id === datasetId);
    if (dataset === undefined) return;
    const stem = tsvPath === null ? (subjectOf(dataset.name) ?? '') : stemOf(baseNameOf(tsvPath));
    let existing = layerOf() ?? ownedLayer();
    // A layer hanging off a *different* volume than the one now bound — a job's `load` naming a
    // second CT after an interactive session bound the first — is rebuilt rather than patched:
    // `LayerBase.datasetId` is the carrier the renderable was built for, so the contacts would be
    // drawn against one volume and snapped against another. Removing it disarms the point tool;
    // the `armed`/`ensureArmed` pair at the end of this function is what puts it back.
    if (existing !== null && existing.datasetId !== dataset.id) {
      host.scene.removeLayer(existing.id);
      layerId = null;
      existing = null;
    }
    if (existing !== null) {
      layerId = existing.id;
      host.scene.updateLayer<PointsLayer>(existing.id, {
        ...layerPatch(set, ghost),
        name: contactLayerName(stem),
      });
    } else {
      const created = host.scene.addLayer({
        datasetId: dataset.id,
        ...CONTACT_LAYER_STYLE,
        name: contactLayerName(stem),
        color: paletteColor(0),
        ...layerPatch(set, ghost),
      });
      layerId = created.id;
    }
    applyDisplayPreset();
    armed = true;
    ensureArmed();
  };

  // ---- loading ------------------------------------------------------------------------------------

  const bindVolume = (): boolean => {
    const dataset = chooseVolume();
    if (dataset === null) return false;
    datasetId = dataset.id;
    ctName = dataset.name;
    return true;
  };

  /** Whether {@link datasetId} still names a dataset the scene has. */
  const stillBound = (): boolean =>
    datasetId !== null && host.scene.datasets().some((d) => d.id === datasetId);

  const applyTable = (path: string, text: string): boolean => {
    let parsed;
    try {
      parsed = parseTable(text);
    } catch (error: unknown) {
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
    source = {
      tsv: path,
      coordsystem: null,
      t1: t1Path,
      fieldnames: parsed.fieldnames,
      columns: parsed.columns,
      delimiter: parsed.delimiter,
    };
    warning = seegprepWarning(path);
    for (const note of result.warnings.slice(0, 3)) host.ui.toast('warn', note);

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
    host.ui.toast(
      'info',
      `${set.contacts.length} contacts on ${set.groups.length} electrodes from ${baseNameOf(path)}.`
    );
    return true;
  };

  const readEditlogBanner = async (path: string): Promise<void> => {
    const text = await host.files.readText(path);
    if (text === null) return;
    const when = editlogDate(text);
    banner =
      when === null
        ? 'This table has been hand-edited before.'
        : `Hand-edited on ${when.slice(0, 10)}.`;
    notify();
  };

  // ---- the view -------------------------------------------------------------------------------

  const rowsOf = (): SeegRow[] => {
    if (electrode === null) return [];
    const contacts = contactsOf(set, electrode);
    const plane = host.scene.activePlane();
    const group = set.groups.find((g) => g.name === electrode);
    const tip =
      group === undefined || contacts.length === 0
        ? null
        : (tipFirstOrder(
            contacts,
            resolveTip(
              group,
              contacts.map((c) => c.position),
              reference()
            )
          )[0]?.id ?? null);
    return contacts.map((contact) => ({
      id: contact.id,
      name: contact.name,
      status: statusOf(contact),
      offPlaneMm:
        plane === null
          ? null
          : Math.abs(
              dot(
                [
                  contact.position[0] - plane.point[0],
                  contact.position[1] - plane.point[1],
                  contact.position[2] - plane.point[2],
                ],
                plane.normal
              )
            ),
      selected: contact.id === selectedId,
      tip: contact.id === tip,
    }));
  };

  const view = (): SeegView => {
    if (cached !== null) return cached;
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
      placing,
      stats: electrode === null ? null : shaftStats(set, electrode),
      tipName: rows.find((r) => r.tip)?.name ?? null,
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

  const selectContact = (id: string | null, moveCursor: boolean): void => {
    selectedId = id;
    const layer = layerOf();
    if (layer !== null) host.tool.select(layer.id, id);
    if (id !== null) {
      const contact = set.contacts.find((c) => c.id === id);
      if (contact !== undefined) {
        electrode = contact.group;
        if (moveCursor) host.scene.setCursor([...contact.position] as vec3);
      }
    }
    notify();
  };

  const step = (delta: number): void => {
    if (electrode === null) return;
    const contacts = contactsOf(set, electrode);
    if (contacts.length === 0) return;
    const at = contacts.findIndex((c) => c.id === selectedId);
    const next = at < 0 ? (delta > 0 ? 0 : contacts.length - 1) : at + delta;
    const wrapped = ((next % contacts.length) + contacts.length) % contacts.length;
    selectContact((contacts[wrapped] as Contact).id, true);
  };

  const idsForScope = (scope: 'contact' | 'electrode' | 'all'): string[] => {
    if (scope === 'all') return set.contacts.map((c) => c.id);
    if (scope === 'electrode') {
      return electrode === null ? [] : contactsOf(set, electrode).map((c) => c.id);
    }
    return selectedId === null ? [] : [selectedId];
  };

  const doSnap = (
    scope: 'contact' | 'electrode' | 'all',
    radiusMm: number
  ): { moved: number; meanShiftMm: number } => {
    if (datasetId === null) throw new ModuleHostError('no CT is loaded to snap against');
    const ids = idsForScope(scope);
    if (ids.length === 0) return { moved: 0, meanShiftMm: 0 };
    const dataset = datasetId;
    const before = snapshot();
    const result = snapContacts(set, ids, radiusMm, (world, r) =>
      host.scene.peakCentroid(dataset, world, r)
    );
    if (result.moved === 0) return { moved: 0, meanShiftMm: 0 };
    set = applySnap(set, result);
    for (const id of ids) {
      const contact = set.contacts.find((c) => c.id === id);
      if (contact !== undefined) operations.snapped.add(contact.group);
    }
    commit(before);
    return { moved: result.moved, meanShiftMm: result.meanShiftMm };
  };

  const doRefit = (group: string): ShaftStats | null => {
    const before = snapshot();
    const result = refitShaft(set, group, reference(), namePad);
    if (result === null) return null;
    set = result.set;
    operations.refit.add(group);
    commit(before);
    return result.stats;
  };

  const doRenumber = (group: string): number => {
    const before = snapshot();
    const result = renumberTipFirst(set, group, reference(), namePad);
    if (result.renamed.length === 0) return 0;
    set = result.set;
    operations.renumbered.add(group);
    commit(before);
    return result.renamed.length;
  };

  const doGhost = (on: boolean): void => {
    ghost = on;
    writeLayer();
    writeBlock();
    notify();
  };

  const doDelete = (id: string): void => {
    const contact = set.contacts.find((c) => c.id === id);
    if (contact === undefined) return;
    const before = snapshot();
    set = { groups: set.groups, contacts: set.contacts.filter((c) => c.id !== id) };
    if (contact.original !== null) deleted = [...deleted, contact];
    if (selectedId === id) selectedId = null;
    commit(before);
  };

  const doRevert = (): void => {
    const before = snapshot();
    const restored = deleted;
    set = {
      groups: set.groups,
      contacts: [
        ...set.contacts
          .filter((c) => c.original !== null)
          .map((c) => ({ ...c, position: [...(c.original as vec3)] as vec3 })),
        ...restored.map((c) => ({ ...c, position: [...(c.original ?? c.position)] as vec3 })),
      ],
    };
    deleted = [];
    selectedId = null;
    commit(before);
    host.ui.toast('info', 'Every contact is back where the table put it.');
  };

  const doUndo = (): void => {
    const entry = history.undo();
    if (entry === null) {
      host.ui.toast('info', 'Nothing to undo.');
      return;
    }
    restore(entry.before);
  };

  const doRedo = (): void => {
    const entry = history.redo();
    if (entry === null) {
      host.ui.toast('info', 'Nothing to redo.');
      return;
    }
    restore(entry.after);
  };

  // ---- saving -------------------------------------------------------------------------------------

  const deletedRecords = (): DeletedContact[] =>
    deleted.map((c) => ({
      name: c.name,
      group: c.group,
      ordinal: c.ordinal,
      position: (c.original ?? c.position) as vec3,
    }));

  const writeFiles = async (
    path: string,
    siblings: Record<string, string>
  ): Promise<{ path: string; editlog: string | null } | null> => {
    const columns: ColumnMap = source?.columns ?? canonicalSource().columns;
    const fieldnames = source?.fieldnames ?? canonicalSource().fieldnames;
    const text = writeTable(set, { fieldnames, columns });
    const written = await host.files.writeText(path, text, { backup: true });
    if (!written.ok) {
      host.ui.toast('error', `Could not write ${baseNameOf(path)}: ${written.error}`);
      return null;
    }
    const editlogPath = siblings[EDITLOG_TEMPLATE] ?? null;
    let editlog: string | null = null;
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
      if (result.ok) editlog = editlogPath;
      else host.ui.toast('warn', `The table was saved; its editlog was not: ${result.error}`);
    }
    markDirty(false);
    host.ui.toast(
      'info',
      `Saved ${set.contacts.length} contacts to ${baseNameOf(path)}` +
        (written.backupPath === null ? '.' : `, backing up the previous table.`)
    );
    return { path, editlog };
  };

  const doSaveAs = async (): Promise<{ path: string; editlog: string | null } | null> => {
    const target = await host.files.saveDialog('electrodes', tsvPath);
    if (target === null) return null;
    savePath = target.path;
    saveSiblings = target.siblings;
    warning = seegprepWarning(target.path);
    if (warning !== null) host.ui.toast('warn', warning);
    return writeFiles(target.path, target.siblings);
  };

  const doSave = async (): Promise<{ path: string; editlog: string | null } | null> => {
    if (savePath === null) return doSaveAs();
    return writeFiles(savePath, saveSiblings);
  };

  const doLoadDialog = async (): Promise<void> => {
    const paths = await host.files.openDialog('electrodes');
    const path = paths?.[0];
    if (path === undefined) return;
    const text = await host.files.readText(path);
    if (text === null) {
      host.ui.toast('error', `Could not read ${baseNameOf(path)}.`);
      return;
    }
    applyTable(path, text);
  };

  // ---- events ---------------------------------------------------------------------------------

  const adoptLayerPositions = (): void => {
    const layer = layerOf();
    if (layer === null) return;
    const byId = new Map((layer.points ?? []).map((p, i) => [p.id ?? `p${i}`, p.position]));
    let changed = false;
    const contacts = set.contacts.map((contact) => {
      const position = byId.get(contact.id);
      if (position === undefined) return contact;
      if (
        position[0] === contact.position[0] &&
        position[1] === contact.position[1] &&
        position[2] === contact.position[2]
      ) {
        return contact;
      }
      changed = true;
      return { ...contact, position: [...position] as vec3 };
    });
    if (!changed) return;
    set = { groups: set.groups, contacts };
    // Only the shaft lines: rewriting `points` from the set would fight the drag the engine is in
    // the middle of. The next `layers` event finds nothing different, so this cannot loop.
    host.scene.updateLayer<PointsLayer>(layer.id, layerPatch(set, ghost));
    notify();
  };

  const onPointTool = (event: PointToolEvent): void => {
    if (layerId !== null && event.layerId !== layerId && event.kind !== 'cleared') return;
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
          contacts: [...set.contacts, newContact(id, group, ordinal, [...world] as vec3, namePad)],
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
          host.scene.setCursor([...contact.position] as vec3);
        }
        notify();
        return;
      }
      case 'dragEnd': {
        adoptLayerPositions();
        const base = dragBase;
        dragBase = null;
        if (base === null) return;
        const moved = base.set.contacts.some((was) => {
          const now = set.contacts.find((c) => c.id === was.id);
          return (
            now !== undefined &&
            (now.position[0] !== was.position[0] ||
              now.position[1] !== was.position[1] ||
              now.position[2] !== was.position[2])
          );
        });
        // A plain click emits `selected` and then a zero-length `dragEnd`; comparing positions is
        // what keeps that from becoming an undo step and a dirty mark.
        if (moved) commit(base);
        return;
      }
      case 'cleared': {
        selectedId = null;
        dragBase = null;
        // The engine disarms at the start of `Engine.load` and when the layer goes; re-arm against
        // whatever layer this module owns once one exists again.
        ensureArmed();
        notify();
        return;
      }
      default:
        return;
    }
  };

  // ---- subscriptions ------------------------------------------------------------------------------

  host.subscribe(host.scene.on('pointTool', onPointTool));
  host.subscribe(
    host.scene.on('layers', () => {
      adoptLayerPositions();
      ensureArmed();
    })
  );
  host.subscribe(
    host.scene.on('datasets', () => {
      if (pendingTsv === null) return;
      if (!bindVolume()) return;
      const path = pendingTsv;
      pendingTsv = null;
      message = null;
      buildLayer();
      writeBlock();
      notify();
      host.ui.toast('info', `Contacts bound to ${ctName ?? 'the volume'} (${baseNameOf(path)}).`);
    })
  );
  // The off-plane column is measured against the plane through the cursor (§13.1's `activePlane`),
  // so the list is re-read whenever the crosshair moves. The rows are plain spans and there are a
  // few hundred of them at most; the info panel above already re-renders on the same edge.
  host.subscribe(host.scene.on('cursor', () => notify()));
  host.subscribe(
    host.scene.on('sceneCleared', () => {
      set = emptySet();
      deleted = [];
      history.clear();
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
      armed = false;
      placing = false;
      markDirty(false);
    })
  );

  // ---- the public surface ------------------------------------------------------------------------

  const run = async (command: string): Promise<void> => {
    switch (command) {
      case 'add': {
        placing = !placing;
        if (placing) arm('place');
        else arm('select');
        syncStatus();
        notify();
        return;
      }
      case 'snap': {
        const { moved, meanShiftMm } = doSnap('contact', snapRadiusMm);
        host.ui.toast(
          'info',
          moved === 0
            ? 'No metal within the snap radius.'
            : `Snapped 1 contact, ${meanShiftMm.toFixed(2)} mm.`
        );
        return;
      }
      case 'snap-electrode': {
        const { moved, meanShiftMm } = doSnap('electrode', snapRadiusMm);
        host.ui.toast(
          'info',
          moved === 0
            ? 'No metal within the snap radius.'
            : `Snapped ${moved} contacts, mean ${meanShiftMm.toFixed(2)} mm.`
        );
        return;
      }
      case 'snap-all': {
        const answer = await host.ui.confirm(
          'Snap every contact?',
          `${set.contacts.length} contacts across ${set.groups.length} electrodes will move to the ` +
            `local CT peak within ${snapRadiusMm} mm. Undo puts them back.`,
          ['Snap all', 'Cancel']
        );
        if (answer !== 0) return;
        const { moved, meanShiftMm } = doSnap('all', snapRadiusMm);
        host.ui.toast(
          'info',
          moved === 0
            ? 'No metal within the snap radius.'
            : `Snapped ${moved} contacts, mean ${meanShiftMm.toFixed(2)} mm.`
        );
        return;
      }
      case 'next':
        return step(1);
      case 'prev':
        return step(-1);
      case 'refit': {
        if (electrode === null) return;
        const stats = doRefit(electrode);
        host.ui.toast(
          'info',
          stats === null
            ? 'An electrode needs two contacts to re-fit.'
            : `Re-fitted ${electrode}: RMS ${(stats.rmsMm ?? 0).toFixed(2)} mm, pitch ${(stats.pitchMm ?? 0).toFixed(2)} mm.`
        );
        return;
      }
      case 'renumber': {
        if (electrode === null) return;
        const renamed = doRenumber(electrode);
        host.ui.toast(
          'info',
          renamed === 0
            ? `${electrode} was already numbered tip-first.`
            : `Renumbered ${renamed} contacts.`
        );
        return;
      }
      case 'flip-tip': {
        if (electrode === null) return;
        const group = set.groups.find((g) => g.name === electrode);
        if (group === undefined) return;
        const contacts = contactsOf(set, electrode);
        const tip = flippedTip(
          group,
          contacts.map((c) => c.position),
          reference()
        );
        set = {
          contacts: set.contacts,
          groups: set.groups.map((g) => (g.name === electrode ? { ...g, tip } : g)),
        };
        writeBlock();
        notify();
        host.ui.toast(
          'info',
          `The other end of ${electrode} is now the tip. Renumber to apply it to the names.`
        );
        return;
      }
      case 'ghost':
        return doGhost(!ghost);
      case 'delete': {
        if (selectedId === null) return;
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
        } finally {
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
        } finally {
          busy = false;
          notify();
        }
        return;
      }
      case 'revert':
        return doRevert();
      default:
        host.ui.toast('warn', `sEEG has no command "${command}"`);
    }
  };

  const runOperation = async (
    op: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
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
          .find(
            (d) =>
              d.kind === 'volume' && (d.path === ct || baseNameOf(d.path ?? '') === baseNameOf(ct))
          );
        if (dataset !== undefined) {
          datasetId = dataset.id;
          ctName = dataset.name;
        }
        const text = await host.files.readText(tsv);
        if (text === null) throw new ModuleHostError(`could not read ${tsv}`);
        const ok = applyTable(tsv, text);
        if (!ok) throw new ModuleHostError(`${baseNameOf(tsv)} is not a usable electrodes table`);
        // After the CT binds, because {@link showT1} writes the block and `applyTable` is what
        // creates the `source` it writes into. Absent `t1` reports nothing at all, which is what
        // makes the field additive for every job written before it did anything.
        const wanted = args['t1'];
        const t1 = typeof wanted === 'string' && wanted !== '' ? showT1(wanted) : null;
        if (t1 === 'not-open') {
          host.ui.toast(
            'warn',
            `${baseNameOf(String(wanted))} is not open, so the contacts have no anatomy under them. Add it to the job's scene files.`
          );
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
          throw new ModuleHostError(
            `snap scope must be contact, electrode or all (got "${scope}")`
          );
        }
        const wantedElectrode = args['electrode'];
        if (typeof wantedElectrode === 'string') electrode = wantedElectrode;
        const wantedContact = args['contact'];
        if (typeof wantedContact === 'string') {
          const found = set.contacts.find(
            (c) => c.name === wantedContact || c.id === wantedContact
          );
          selectedId = found?.id ?? null;
          if (found !== undefined) electrode = found.group;
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
          .filter((s): s is ShaftStats => s !== null)
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
      case 'stats':
        return { electrodes: allShaftStats(set) };
      case 'save': {
        const out = String(args['out'] ?? '');
        if (out === '') throw new ModuleHostError('save needs an `out` name');
        // A `--job` window's Save sheet never opens, so nothing here comes from a dialog: `run.ts`
        // hands `out` over as an absolute path under `--out`, and `job-runner.ts` has already put
        // that path — and this writer's `{stem}_editlog.json` beside it — on this module's write
        // list (§13.6). A relative `out` is a harness calling the operation directly, and then it
        // means "beside the table that was loaded", which is the only other directory in play.
        const directory =
          tsvPath === null ? '' : tsvPath.slice(0, Math.max(0, tsvPath.lastIndexOf('/') + 1));
        const path = out.startsWith('/') ? out : `${directory}${out}`;
        // The editlog is a sibling of the file being **written**, never of the table that was read:
        // main admitted `{stem}_editlog.json` in the resolved path's own directory, so anywhere else
        // is both the wrong place and a write `module-write-text` refuses.
        const writtenIn = path.slice(0, Math.max(0, path.lastIndexOf('/') + 1));
        const siblings = { [EDITLOG_TEMPLATE]: `${writtenIn}${editlogNameFor(baseNameOf(path))}` };
        const result = await writeFiles(path, siblings);
        if (result === null) throw new ModuleHostError(`could not write ${path}`);
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
  const adoptOrphanLayer = (): void => {
    if (host.scene.block<SeegBlock>() !== null) return;
    const layer = ownedLayer();
    if (layer === null || (layer.points ?? []).length === 0) return;
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
    host.ui.toast(
      'warn',
      'sEEG: provenance lost — the contacts are here, the table they came from is not.'
    );
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
      if (readerId !== 'electrodes') return false;
      const text = await host.files.readText(path);
      if (text === null) {
        host.ui.toast('error', `Could not read ${baseNameOf(path)}.`);
        // Claimed and unreadable: `true`, so the app does not then try to open a table as a volume.
        return true;
      }
      applyTable(path, text);
      const found = await host.files.siblings(path);
      const bundle = bundleOf(found);
      if (bundle.editlog !== null) await readEditlogBanner(bundle.editlog);
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
        if (text !== null) applyTable(bundle.tsv, text);
      } else if (datasetId === null || pendingTsv !== null) {
        // The CT arrived after the table: bind and build.
        if (bindVolume() && pendingTsv !== null) {
          pendingTsv = null;
          message = null;
          buildLayer();
          writeBlock();
          notify();
        }
      }
      if (bundle.editlog !== null) await readEditlogBanner(bundle.editlog);
      void anchor;
    },

    async restoreBlock(block) {
      const data = fromBlock(block.data);
      const layer = ownedLayer();
      if (layer === null) {
        // The scene carried a block but no layer of ours — nothing to restore onto.
        if (data !== null) {
          snapRadiusMm = clampSnapRadius(data.snapRadiusMm);
          ghost = data.ghost;
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
      electrode = set.groups[0]?.name ?? null;
      selectedId = null;
      deleted = [];
      history.clear();
      warning = tsvPath === null ? null : seegprepWarning(tsvPath);
      if (namePad === 0) namePad = namePadOf(set.contacts.map((c) => c.name));

      if (source === null || source.tsv === null) {
        // §13.2's degradation contract, said out loud rather than guessed at.
        message =
          'This scene was saved without the module’s record, so where these contacts came from is unknown. Save as… to write a table.';
        host.ui.toast(
          'warn',
          'sEEG: provenance lost — the contacts are here, the table they came from is not.'
        );
      } else {
        message = null;
      }
      armed = true;
      writeLayer();
      ensureArmed();
      markDirty(false);
    },

    dirty: () => isDirty,

    dispose(): void {
      disarm();
      host.ui.status(null);
      listeners.clear();
    },

    setElectrode(name) {
      electrode = name;
      if (placing) arm('place');
      notify();
    },

    setSnapRadius(mm) {
      snapRadiusMm = clampSnapRadius(mm);
      writeBlock();
      notify();
    },

    jumpTo(id) {
      selectContact(id, true);
    },

    deleteContact(id) {
      doDelete(id);
    },
  };
}

/** Exported for the harness: the names a save writes, given a chosen path. */
export function saveSiblingTemplates(): { backup: string; editlog: string } {
  return { backup: BACKUP_TEMPLATE, editlog: EDITLOG_TEMPLATE };
}

/** Exported for the harness and the panel: what a contact's name would be at this ordinal. */
export { contactName, FROM_TSV_EDITLOG, hasMoved };
