/**
 * The screenshot dialog — the whole of §4.7's `ScreenshotOptions`, in one place.
 *
 * `target: 'view' | 'grid'` with a `viewId`, `width` / `height` / `scale`, `dpi` (written into the
 * PNG **pHYs** chunk), `background`, the five `include` toggles and `autoTrim`. The engine half is
 * audit **P2-06** and is E-SCENE's; this dialog is written against the frozen option object, so the
 * two halves land in either order and the dialog is useful the moment the engine honours a knob.
 *
 * Two things make it more than a form:
 *
 *  * **Preview.** "Preview" runs the *real* `Engine.screenshot` with the options as edited and shows
 *    the Blob. That is the only way to see `autoTrim`, an `include` toggle or a background before
 *    committing to a file, and it exercises exactly the call Save will make.
 *  * **The pHYs read-back.** §11 requires the DPI to be asserted by *parsing the chunk*, not by
 *    eyeballing the image, so the preview parses it (`lib/png.ts`) and the dialog reports the DPI
 *    that is actually in the file next to the one that was asked for. A silently-dropped `dpi` is
 *    then visible in the product, not only in a test.
 *
 * §8's "no logic in React" holds: every value here is a field of the options object handed to
 * `onConfirm`, and the two engine calls (`screenshot` for the preview, and Save's) both go through
 * the controller.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ScreenshotOptions, ViewId } from '@tetravox/engine';
import { readPngInfo } from '../lib/png';
import { DialogFrame, Field } from './dialog';

export interface ScreenshotPreview {
  blob: Blob;
  /** Object URL for the preview `<img>`; the dialog revokes it when it changes or unmounts. */
  url: string;
  width: number;
  height: number;
  bytes: number;
  /** From the PNG's own `pHYs` chunk — `undefined` when the file carries none. */
  dpi?: number;
}

export interface ScreenshotDialogProps {
  /** The panes the `target: 'view'` selector offers. */
  views: readonly ViewId[];
  /** The starting options. */
  initial: ScreenshotOptions;
  /** Runs `Engine.screenshot` — the controller's, so the dialog never holds an `Engine` (§8). */
  capture(opts: ScreenshotOptions): Promise<Blob>;
  onConfirm(opts: ScreenshotOptions): void;
  onCancel(): void;
}

/** §4.7's five `include` toggles, with the §8 name each one is called in the chrome. */
const INCLUDES: readonly { key: keyof ScreenshotOptions['include']; label: string }[] = [
  { key: 'colorbar', label: 'Colour bars' },
  { key: 'orientationLabels', label: 'Orientation letters' },
  { key: 'crosshair', label: 'Crosshair' },
  { key: 'cornerInfo', label: 'Corner info' },
  { key: 'scaleBar', label: 'Scale bar' },
];

const BACKGROUNDS: readonly ScreenshotOptions['background'][] = ['scene', 'white', 'transparent'];

/** An optional numeric field: empty text means "leave it to the engine", not zero. */
function numberOrUndefined(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function ScreenshotDialog({
  views,
  initial,
  capture,
  onConfirm,
  onCancel,
}: ScreenshotDialogProps): React.JSX.Element {
  const [opts, setOpts] = useState<ScreenshotOptions>(initial);
  const [widthText, setWidthText] = useState(initial.width?.toString() ?? '');
  const [heightText, setHeightText] = useState(initial.height?.toString() ?? '');
  const [scaleText, setScaleText] = useState(initial.scale?.toString() ?? '');
  const [dpiText, setDpiText] = useState(initial.dpi?.toString() ?? '144');
  const [preview, setPreview] = useState<ScreenshotPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One object URL alive at a time; a preview taken five times would otherwise pin five bitmaps.
  useEffect(() => {
    return () => {
      if (preview !== null) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  const patch = useCallback((next: Partial<ScreenshotOptions>) => {
    setOpts((current) => ({ ...current, ...next }));
  }, []);

  /** The options as the fields currently read — the single place the text inputs are interpreted. */
  const current = useCallback((): ScreenshotOptions => {
    const width = numberOrUndefined(widthText);
    const height = numberOrUndefined(heightText);
    const scale = numberOrUndefined(scaleText);
    const dpi = numberOrUndefined(dpiText);
    return {
      ...opts,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(scale === undefined ? {} : { scale }),
      ...(dpi === undefined ? {} : { dpi }),
    };
  }, [dpiText, heightText, opts, scaleText, widthText]);

  const onPreview = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await capture(current());
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const info = readPngInfo(bytes);
      if (info === null) {
        setError('the engine did not return a PNG');
        return;
      }
      setPreview((old) => {
        if (old !== null) URL.revokeObjectURL(old.url);
        return {
          blob,
          url: URL.createObjectURL(blob),
          width: info.width,
          height: info.height,
          bytes: blob.size,
          ...(info.dpi === undefined ? {} : { dpi: info.dpi }),
        };
      });
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [capture, current]);

  const requestedDpi = numberOrUndefined(dpiText);
  // §11: parse the chunk, do not eyeball the image. `null` = nothing to say yet.
  const dpiVerdict =
    preview === null || requestedDpi === undefined
      ? null
      : preview.dpi === requestedDpi
        ? `pHYs carries ${preview.dpi} dpi`
        : `pHYs carries ${preview.dpi ?? 'no'} dpi, asked for ${requestedDpi}`;

  return (
    <DialogFrame
      testId="screenshot-dialog"
      title="Screenshot"
      subtitle="§4.7 ScreenshotOptions — target, size, dpi (PNG pHYs), background, chrome, auto-trim"
      width="42rem"
      onCancel={onCancel}
      footer={
        <>
          <button
            type="button"
            data-testid="screenshot-preview"
            className="tvx-btn"
            disabled={busy}
            onClick={() => void onPreview()}
          >
            {busy ? 'Rendering…' : 'Preview'}
          </button>
          {error !== null && (
            <span data-testid="screenshot-error" className="text-[10px] text-tvx-danger">
              {error}
            </span>
          )}
          <button
            type="button"
            data-testid="screenshot-cancel"
            className="tvx-btn ml-auto"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="screenshot-save"
            className="tvx-btn tvx-btn-on"
            onClick={() => onConfirm(current())}
          >
            Save PNG
          </button>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_14rem] gap-4">
        <div>
          <Field label="Target">
            <select
              data-testid="screenshot-target"
              className="tvx-input text-[11px]"
              value={opts.target}
              onChange={(e) =>
                patch({ target: e.currentTarget.value as ScreenshotOptions['target'] })
              }
            >
              <option value="grid">Whole grid</option>
              <option value="view">One view</option>
            </select>
            {opts.target === 'view' && (
              <select
                data-testid="screenshot-view"
                aria-label="View to capture"
                className="tvx-input text-[11px]"
                value={opts.viewId ?? views[0] ?? ''}
                onChange={(e) => patch({ viewId: e.currentTarget.value })}
              >
                {views.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Width (px)" hint="Empty = the pane's own size">
            <input
              data-testid="screenshot-width"
              className="tvx-input w-24 font-mono text-[11px]"
              inputMode="numeric"
              value={widthText}
              placeholder="auto"
              onChange={(e) => setWidthText(e.currentTarget.value)}
            />
          </Field>
          <Field label="Height (px)" hint="Empty = derived from the aspect ratio">
            <input
              data-testid="screenshot-height"
              className="tvx-input w-24 font-mono text-[11px]"
              inputMode="numeric"
              value={heightText}
              placeholder="auto"
              onChange={(e) => setHeightText(e.currentTarget.value)}
            />
          </Field>
          <Field label="Scale (×)" hint="Supersample factor; §7.0.4 resolves then downsamples">
            <input
              data-testid="screenshot-scale"
              className="tvx-input w-24 font-mono text-[11px]"
              inputMode="decimal"
              value={scaleText}
              placeholder="1"
              onChange={(e) => setScaleText(e.currentTarget.value)}
            />
          </Field>
          <Field label="DPI" hint="Written to the PNG pHYs chunk (§4.7)">
            <input
              data-testid="screenshot-dpi"
              className="tvx-input w-24 font-mono text-[11px]"
              inputMode="numeric"
              value={dpiText}
              onChange={(e) => setDpiText(e.currentTarget.value)}
            />
          </Field>

          <Field label="Background">
            <select
              data-testid="screenshot-background"
              className="tvx-input text-[11px]"
              value={opts.background}
              onChange={(e) =>
                patch({ background: e.currentTarget.value as ScreenshotOptions['background'] })
              }
            >
              {BACKGROUNDS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Auto-trim" hint="Crop the empty border away after rendering">
            <input
              type="checkbox"
              data-testid="screenshot-autotrim"
              checked={opts.autoTrim}
              onChange={(e) => patch({ autoTrim: e.currentTarget.checked })}
            />
          </Field>

          <fieldset className="mt-2 border-t border-tvx-line pt-2">
            <legend className="px-1 text-[10px] uppercase tracking-wider text-tvx-dim">
              Include
            </legend>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {INCLUDES.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-1.5 text-[11px]">
                  <input
                    type="checkbox"
                    data-testid={`screenshot-include-${key}`}
                    checked={opts.include[key]}
                    onChange={(e) =>
                      patch({ include: { ...opts.include, [key]: e.currentTarget.checked } })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <aside data-testid="screenshot-preview-pane" className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-tvx-dim">Preview</span>
          <div className="grid aspect-square place-items-center overflow-hidden rounded border border-tvx-line bg-[repeating-conic-gradient(var(--color-tvx-panel)_0_25%,var(--color-tvx-bg)_0_50%)] bg-[length:12px_12px]">
            {preview === null ? (
              <span
                data-testid="screenshot-preview-empty"
                className="px-2 text-center text-[10px] text-tvx-dim"
              >
                Press Preview to render one with these options.
              </span>
            ) : (
              <img
                data-testid="screenshot-preview-image"
                src={preview.url}
                alt="Screenshot preview"
                className="max-h-full max-w-full object-contain"
              />
            )}
          </div>
          {preview !== null && (
            <dl className="font-mono text-[10px] text-tvx-dim">
              <div data-testid="screenshot-preview-size">
                {preview.width} × {preview.height} px
              </div>
              <div data-testid="screenshot-preview-bytes">{preview.bytes} B</div>
              {dpiVerdict !== null && (
                <div
                  data-testid="screenshot-preview-dpi"
                  className={preview.dpi === requestedDpi ? '' : 'text-tvx-warn'}
                >
                  {dpiVerdict}
                </div>
              )}
            </dl>
          )}
        </aside>
      </div>
    </DialogFrame>
  );
}
