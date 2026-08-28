/**
 * `CutSource` — the narrow contract E-DERIVED consumes a cut through.
 *
 * **The contract (agreed with E-MESH, `docs/PHASE2-OWNERSHIP.md` R4).** A cut is asked for by
 * `(datasetId, key)`, latest-wins **per key**, so the three 2D panes and the 3D clip planes never
 * starve each other:
 *
 * * `'3d-clip'` — the mesh layer's own `clip.planes`, whose caps §7.4 draws in 3D.
 * * `` `pane:${viewId}` `` — one per 2D pane, at that pane's derived cursor plane (§4.5: "the plane
 *   is DERIVED, never stored"). Sweeping the cursor re-requests the same key, so a sweep replaces
 *   its own pending request instead of queueing one cut per step — which is what makes R4's
 *   "sweeping never queues" true rather than aspirational.
 *
 * Snapshots are **immutable**: a consumer may hold one for the frame it was handed and compare
 * `generation` to decide whether to re-upload. A stale generation is never delivered.
 *
 * **This file used to carry an implementation, and no longer does.** Phase 2's integration order
 * lands E-MESH (stage 3) before E-DERIVED (stage 4), so E-DERIVED's branch shipped `PaneCutSource`,
 * a stand-in against the `cut` op with the same latest-wins and the same immutability, and said the
 * integrator would "swap the one construction site in `engine.ts`; nothing else moves, because
 * nothing else names the implementation". That swap is done: `compute/cut-manager.ts`'s
 * `CutManager` — the single owner §7.4 requires, with the per-key arenas §7.4's cap uploader needs
 * and the newest-**applied**-ticket rule a drag depends on — is the implementation, and the
 * stand-in is gone rather than left behind as a second source of truth for the same four methods.
 *
 * What remains here is the *consumer's* view of it: the types `derived/store.ts` names, and the
 * structural interface that says which four of `CutManager`'s methods E-DERIVED may reach.
 * `derived/cut-source.test.ts` pins that the real manager satisfies it, behaviourally and by type.
 */

import type { CutManager, CutRequestOptions, CutSnapshot } from '../compute/cut-manager';
import type { DatasetId } from '../scene/types';
import type { PlaneT } from '@tetravox/protocol';

export type {
  CutFieldRef,
  CutPlaneRange,
  CutRequestOptions,
  CutSnapshot,
} from '../compute/cut-manager';
export { MAX_CUT_PLANES } from '../compute/cut-manager';

/**
 * The four methods a derived consumer may call on the engine's one cut owner.
 *
 * Deliberately narrower than `CutManager`: the arenas, `capPolygons`, `requiredCounts` and the
 * recycle state belong to §7.4's cap path, which is E-MESH's, and a 2D consumer reaching for them
 * would be doing the 3D pass's job.
 */
export interface CutSource {
  requestCut(
    datasetId: DatasetId,
    key: string,
    planes: readonly PlaneT[],
    opts: CutRequestOptions
  ): void;
  getCut(datasetId: DatasetId, key: string): CutSnapshot | null;
  onCut(datasetId: DatasetId, key: string, cb: (snap: CutSnapshot | null) => void): () => void;
  releaseCut(datasetId: DatasetId, key: string): void;
}

/**
 * A compile-time proof that the seam is wired: `CutManager` **is** a `CutSource`.
 *
 * If E-MESH ever narrows one of the four, this goes red in `pnpm typecheck` rather than in a
 * Playwright run three stages later.
 */
export type CutManagerIsACutSource = CutManager extends CutSource ? true : never;
