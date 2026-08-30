/**
 * §8 status bar: "`Capabilities.renderer`; **fps** = frames drawn in the last second (0 when idle is
 * correct under render-on-demand); **frame ms** = median CPU frame time over the last 30 rendered
 * frames; **GPU ms** separately when `caps.timerQuery`; the current `QualityLevel` when below full;
 * … last load time and wasm `heapBytes` per dataset."
 *
 * Every number comes from `lib/metrics.ts`, which is pure and tested. `caps.isSoftware` is surfaced
 * because §12.2 requires the app to say so rather than silently running at 2 fps.
 */

import {
  fps,
  fpsSaturated,
  formatBytes,
  formatDuration,
  medianFrameMs,
  medianGpuMs,
} from '../lib/metrics';
import { ModuleStatusCells } from '../modules/ModuleStatusCells';
import { useUi } from './context';

function Cell({
  label,
  value,
  testId,
  title,
}: {
  label: string;
  value: string;
  testId: string;
  title?: string;
}): React.JSX.Element {
  return (
    <span className="flex shrink-0 items-baseline gap-1" title={title}>
      <span className="text-tvx-dim">{label}</span>
      <span data-testid={testId} className="text-tvx-text">
        {value}
      </span>
    </span>
  );
}

export function StatusBar(): React.JSX.Element {
  const caps = useUi((s) => s.caps);
  const metrics = useUi((s) => s.metrics);
  const quality = useUi((s) => s.quality);
  const datasets = useUi((s) => s.datasets);
  const heapBytes = useUi((s) => s.heapBytes);
  const lastLoadMs = useUi((s) => s.lastLoadMs);
  const impl = useUi((s) => s.impl);
  const lastScreenshot = useUi((s) => s.lastScreenshot);
  // The 1 Hz heartbeat: without it, fps would freeze at its last value once rendering stops.
  const tick = useUi((s) => s.tick);
  void tick;

  const now = performance.now();
  const frames = fps(metrics, now);
  const frameMs = medianFrameMs(metrics);
  const gpuMs = medianGpuMs(metrics);

  return (
    <footer
      data-testid="status-bar"
      className="tvx-strip flex items-center gap-x-4 border-t border-tvx-line bg-tvx-panel px-3 font-mono text-[10px]"
    >
      <Cell
        label="renderer"
        testId="status-renderer"
        value={caps === null ? '—' : caps.renderer}
        title={caps === null ? undefined : `${caps.vendor} · impl ${impl}`}
      />
      {caps?.isSoftware === true && (
        <span data-testid="status-software" className="shrink-0 text-tvx-warn">
          software rasteriser
        </span>
      )}
      <Cell
        label="fps"
        testId="status-fps"
        value={`${fpsSaturated(metrics, now) ? '≥' : ''}${frames}`}
        title="Frames drawn in the last second; 0 when idle is correct under render-on-demand (§8)"
      />
      <Cell
        label="frame"
        testId="status-frame-ms"
        value={frameMs === null ? '—' : `${frameMs.toFixed(1)} ms`}
        title="Median CPU frame time over the last 30 rendered frames (§8)"
      />
      {caps?.timerQuery === true && (
        <Cell
          label="gpu"
          testId="status-gpu-ms"
          value={gpuMs === null ? '—' : `${gpuMs.toFixed(1)} ms`}
        />
      )}
      {/* §7.2: "never degrade silently" is only true if the bar says so. Two readouts, because the
          two states mean different things to the reader: `interacting` is the *expected* drop while
          a gesture is live, and `reduced` is the adaptive hook saying this machine cannot hold the
          budget. One shared label would make a permanent degradation look like a transient one.

          **The tooltips name what the level actually does, not what §7.2 lists.** The fallback set
          is `dprScale 1`, `msaa 0`, `capDecimation`; `dprScale` is 1 at every level so there is
          nothing to say, and `msaa` / `capDecimation` have no consumer yet (docs/DECISIONS.md,
          2026-08-28 — an MSAA resolve target and a decimating cut are Phase 3). `edges` was the one
          live knob and is gone: element edges the user switched on now survive the gesture
          (DECISIONS, 2026-08-28). So `interacting` currently reports a gesture in flight and NOT a
          degradation, and the tooltips say exactly that. A bar that announced a degradation the
          renderer does not perform would invert "never degrade silently" into "claim a degradation
          that never happened", which is exactly the failure §7.2 is guarding against. */}
      {quality === 'interacting' && (
        <span
          data-testid="status-interacting"
          className="flex shrink-0 items-baseline gap-1 text-tvx-accent"
          title="A gesture is in flight (§7.2). Nothing is dropped: element edges stay on."
        >
          <span aria-hidden="true">●</span>
          interacting
        </span>
      )}
      {quality !== 'full' && (
        <Cell
          label="quality"
          testId="status-quality"
          value={quality}
          title={
            quality === 'interacting'
              ? 'The interacting QualityLevel (§7.2). No knob it names is live today, so nothing is degraded'
              : 'Degraded to hold the frame budget (§7.2) — the drop is reported, never silent'
          }
        />
      )}

      {/* §13.3: the active module's cell, **before** the dataset cells. Two BIDS-named datasets
          already overflow this strip and it does not scroll, so a cell after them would not be on
          screen in the case a module is most likely to be used in. */}
      <ModuleStatusCells />

      {datasets.map((dataset) => (
        <span key={dataset.id} className="flex shrink-0 items-baseline gap-1">
          <span className="text-tvx-dim">{dataset.name}</span>
          <span data-testid={`status-heap-${dataset.id}`} className="text-tvx-text">
            {heapBytes[dataset.id] === undefined
              ? 'heap —'
              : `heap ${formatBytes(heapBytes[dataset.id] as number)}`}
          </span>
          <span data-testid={`status-lastload-${dataset.id}`} className="text-tvx-dim">
            {lastLoadMs[dataset.id] === undefined
              ? ''
              : `in ${formatDuration(lastLoadMs[dataset.id] as number)}`}
          </span>
        </span>
      ))}

      {lastScreenshot !== null && (
        <span data-testid="status-screenshot" className="ml-auto shrink-0 text-tvx-dim">
          screenshot {lastScreenshot.isPng ? 'PNG' : lastScreenshot.type} ·{' '}
          {lastScreenshot.width === undefined
            ? ''
            : `${lastScreenshot.width}×${lastScreenshot.height} · `}
          {formatBytes(lastScreenshot.bytes)}
          {/* §11: the DPI is read out of the file's own pHYs chunk, never assumed. A mismatch with
              what was asked for is shown rather than swallowed. */}
          {lastScreenshot.dpi !== undefined && (
            <span
              data-testid="status-screenshot-dpi"
              className={
                lastScreenshot.requestedDpi !== undefined &&
                lastScreenshot.requestedDpi !== lastScreenshot.dpi
                  ? ' text-tvx-warn'
                  : ''
              }
            >
              {' · '}
              {lastScreenshot.dpi} dpi
            </span>
          )}
        </span>
      )}
    </footer>
  );
}
