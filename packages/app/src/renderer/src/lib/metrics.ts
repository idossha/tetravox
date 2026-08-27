/**
 * The §8 status-bar numbers, as a pure reducer over `EngineEvents.frame`.
 *
 * §8, verbatim: "**fps** = frames drawn in the last second (0 when idle is correct under
 * render-on-demand); **frame ms** = median CPU frame time over the last 30 rendered frames".
 *
 * Both are computed here rather than in a component, so "0 when idle" is a tested property and not an
 * accident of when React last re-rendered. `now` is always passed in; nothing here reads the clock.
 */

/** How many frames the median is taken over (§8). */
export const FRAME_WINDOW = 30;
/** The fps window (§8). */
export const FPS_WINDOW_MS = 1000;

export interface FrameSample {
  /** `performance.now()` when the `frame` event arrived. */
  at: number;
  cpuMs: number;
  gpuMs?: number;
}

export interface MetricsState {
  /** Newest last, capped at `FRAME_WINDOW`. */
  samples: FrameSample[];
}

export const EMPTY_METRICS: MetricsState = { samples: [] };

export function pushFrame(state: MetricsState, sample: FrameSample): MetricsState {
  const samples = [...state.samples, sample];
  return { samples: samples.slice(-FRAME_WINDOW) };
}

/**
 * Frames drawn in the last second.
 *
 * Capped at `FRAME_WINDOW` by construction: the sample buffer only holds 30, so a genuine 120 fps
 * reads as 30. That is a deliberate consequence of §8 defining the median over the last 30 frames and
 * the rate over the last second with one buffer — the status bar says "≥" for a saturated window.
 */
export function fps(state: MetricsState, now: number): number {
  return state.samples.filter((s) => now - s.at <= FPS_WINDOW_MS).length;
}

export function fpsSaturated(state: MetricsState, now: number): boolean {
  return fps(state, now) >= FRAME_WINDOW;
}

/** Median CPU frame time over the buffer, or null when nothing has been drawn yet. */
export function medianFrameMs(state: MetricsState): number | null {
  if (state.samples.length === 0) return null;
  const sorted = state.samples.map((s) => s.cpuMs).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Median GPU frame time, or null when `caps.timerQuery` is false and no sample carried one (§8). */
export function medianGpuMs(state: MetricsState): number | null {
  const values = state.samples
    .map((s) => s.gpuMs)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const mid = values.length >> 1;
  return values.length % 2 === 1
    ? (values[mid] as number)
    : ((values[mid - 1] as number) + (values[mid] as number)) / 2;
}

/** `27,262,976` → `26.0 MB`. Used for the per-dataset wasm heap row (§8, §9.2). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** `1543` → `1.54 s`; `320` → `320 ms`. Used for elapsed load time and the last-load row. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
