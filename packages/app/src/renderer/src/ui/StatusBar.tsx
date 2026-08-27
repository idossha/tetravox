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
    <span className="flex items-baseline gap-1" title={title}>
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
      className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 border-t border-tvx-line bg-tvx-panel px-3 py-1 font-mono text-[10px]"
    >
      <Cell
        label="renderer"
        testId="status-renderer"
        value={caps === null ? '—' : caps.renderer}
        title={caps === null ? undefined : `${caps.vendor} · impl ${impl}`}
      />
      {caps?.isSoftware === true && (
        <span data-testid="status-software" className="text-tvx-warn">
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
          a gesture is live (§7.2's interacting QualityLevel — dprScale 1, msaa 0, edges off, caps
          decimated), and `reduced` is the adaptive hook saying this machine cannot hold the budget.
          One shared label would make a permanent degradation look like a transient one. */}
      {quality === 'interacting' && (
        <span
          data-testid="status-interacting"
          className="flex items-baseline gap-1 text-tvx-accent"
          title="A gesture is in flight: reduced sampling and no edges until it settles (§7.2)"
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
              ? 'The interacting QualityLevel (§7.2): dprScale 1, msaa 0, edges off, caps decimated'
              : 'Degraded to hold the frame budget (§7.2) — the drop is reported, never silent'
          }
        />
      )}

      {datasets.map((dataset) => (
        <span key={dataset.id} className="flex items-baseline gap-1">
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
        <span data-testid="status-screenshot" className="ml-auto text-tvx-dim">
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
