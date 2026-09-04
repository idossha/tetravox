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
import {
  COLUMN_WIDTHS_MM,
  DEFAULT_FIGURE,
  EXPORT_PRESETS,
  mmForPixels,
  pixelsForMm,
  type FigureOptions,
} from '../lib/figure';
import { readPngInfo } from '../lib/png';
import { DialogFrame } from './dialog';

/** The dialog's own target: §4.7's two, plus the app-level multi-panel figure (`lib/figure.ts`). */
type Target = ScreenshotOptions['target'] | 'figure';

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
  /**
   * Runs `Engine.screenshot` — the controller's, so the dialog never holds an `Engine` (§8). With a
   * `figure`, the controller captures every panel and assembles them (`captureFigure`).
   */
  capture(opts: ScreenshotOptions, figure: FigureOptions | null): Promise<Blob>;
  onConfirm(opts: ScreenshotOptions, figure: FigureOptions | null): void;
  onCancel(): void;
  /**
   * Opens the unified settings dialog's Capture tab (directed task: unified settings /
   * toolbar consolidation, 2026-08-28). This dialog is reached from the toolbar's `▾` beside
   * Screenshot, not a gear of its own — see `toolbar/Toolbar.tsx` — but "Defaults…" is still the
   * one click from here to where the *standing* background/dpi/autoTrim live.
   */
  onOpenDefaults(): void;
}

/** §4.7's `include` toggles, with the §8 name each one is called in the chrome. */
const INCLUDES: readonly { key: keyof ScreenshotOptions['include']; label: string }[] = [
  { key: 'colorbar', label: 'Colour bars' },
  { key: 'orientationLabels', label: 'Orientation letters' },
  { key: 'crosshair', label: 'Crosshair' },
  { key: 'cornerInfo', label: 'Corner info' },
  { key: 'scaleBar', label: 'Scale bar' },
  { key: 'orientationCube', label: 'Orientation cube' },
];

const BACKGROUNDS: readonly ScreenshotOptions['background'][] = [
  'scene',
  'white',
  'black',
  'transparent',
];

/** An optional numeric field: empty text means "leave it to the engine", not zero. */
function numberOrUndefined(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Compact, wrapping fields keep capture controls inside the smallest app window (§8). */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const wide = ['Target', 'Preset', 'Width (mm)', 'Panels'].includes(label);
  return (
    <label className={`flex min-w-0 flex-col gap-1 text-[11px] ${wide ? 'col-span-2' : ''}`}>
      <span className="text-tvx-dim" title={hint}>
        {label}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1 [&_select]:max-w-full">
        {children}
      </span>
    </label>
  );
}

export function ScreenshotDialog({
  views,
  initial,
  capture,
  onConfirm,
  onCancel,
  onOpenDefaults,
}: ScreenshotDialogProps): React.JSX.Element {
  const [opts, setOpts] = useState<ScreenshotOptions>(initial);
  const [target, setTarget] = useState<Target>(initial.target);
  const [figure, setFigure] = useState<FigureOptions>({ ...DEFAULT_FIGURE, panels: [...views] });
  const [mmText, setMmText] = useState('');
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
      // A figure captures pane by pane; the controller sets `viewId` per panel.
      target: target === 'figure' ? 'view' : target,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(scale === undefined ? {} : { scale }),
      ...(dpi === undefined ? {} : { dpi }),
    };
  }, [dpiText, heightText, opts, scaleText, target, widthText]);

  /** The figure page, or `null` when the target is a single capture. */
  const currentFigure = useCallback(
    (): FigureOptions | null => (target === 'figure' ? figure : null),
    [figure, target]
  );

  /** A preset patches the options object *and* the text fields that mirror it. */
  const applyPreset = useCallback(
    (id: string) => {
      const preset = EXPORT_PRESETS.find((p) => p.id === id);
      if (preset === undefined) return;
      const next = preset.apply(current());
      setOpts(next);
      setDpiText(next.dpi === undefined ? '' : String(next.dpi));
    },
    [current]
  );

  /** A physical width: mm at the DPI in the field → the width field, in pixels. */
  const applyMm = useCallback(
    (mm: number) => {
      const dpi = numberOrUndefined(dpiText) ?? 144;
      if (!(mm > 0)) return;
      setMmText(String(mm));
      setWidthText(String(pixelsForMm(mm, dpi)));
    },
    [dpiText]
  );

  const onPreview = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await capture(current(), currentFigure());
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
  }, [capture, current, currentFigure]);

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
      subtitle="Choose views, image size and annotations, then preview or save."
      width="56rem"
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
            data-testid="screenshot-defaults"
            className="tvx-btn tvx-btn-sm"
            title="Standing defaults for background, DPI and auto-trim (§8's settings dialog)"
            onClick={onOpenDefaults}
          >
            Defaults…
          </button>
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
            onClick={() => onConfirm(current(), currentFigure())}
          >
            {target === 'figure' ? 'Save figure PNG' : 'Save PNG'}
          </button>
        </>
      }
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,16rem)] items-start gap-4">
        <div className="grid min-w-0 grid-cols-2 items-start gap-x-3 gap-y-2">
          <Field label="Target">
            <select
              data-testid="screenshot-target"
              className="tvx-input text-[11px]"
              value={target}
              onChange={(e) => {
                const next = e.currentTarget.value as Target;
                setTarget(next);
                if (next !== 'figure') patch({ target: next });
              }}
            >
              <option value="grid">Whole grid</option>
              <option value="view">One view</option>
              <option value="figure">Figure — panels with A/B/C labels</option>
            </select>
            {target === 'view' && (
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

          <Field label="Preset" hint="One click sets dpi, background, trim and chrome for the use">
            <span className="flex flex-wrap gap-1">
              {EXPORT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`screenshot-preset-${p.id}`}
                  className="tvx-btn tvx-btn-sm whitespace-nowrap"
                  title={p.hint}
                  onClick={() => applyPreset(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </span>
          </Field>

          <Field
            label="Width (mm)"
            hint="A physical width at the DPI below — sets the pixel width; journal columns as chips"
          >
            <input
              data-testid="screenshot-mm"
              className="tvx-input w-20 font-mono text-[11px]"
              inputMode="decimal"
              value={mmText}
              placeholder="—"
              onChange={(e) => {
                setMmText(e.currentTarget.value);
                const mm = numberOrUndefined(e.currentTarget.value);
                if (mm !== undefined) applyMm(mm);
              }}
            />
            {COLUMN_WIDTHS_MM.map((c) => (
              <button
                key={c.mm}
                type="button"
                data-testid={`screenshot-mm-${c.mm}`}
                className="tvx-btn tvx-btn-sm whitespace-nowrap"
                onClick={() => applyMm(c.mm)}
              >
                {c.label}
              </button>
            ))}
          </Field>

          <Field label="Width (px)" hint="Empty = the pane's own size">
            <input
              data-testid="screenshot-width"
              className="tvx-input w-24 font-mono text-[11px]"
              inputMode="numeric"
              value={widthText}
              placeholder="auto"
              onChange={(e) => {
                setWidthText(e.currentTarget.value);
                setMmText('');
              }}
            />
            {numberOrUndefined(widthText) !== undefined && (
              <span
                data-testid="screenshot-width-mm"
                className="font-mono text-[10px] text-tvx-dim"
              >
                ={' '}
                {mmForPixels(
                  numberOrUndefined(widthText) as number,
                  numberOrUndefined(dpiText) ?? 144
                ).toFixed(1)}{' '}
                mm at {numberOrUndefined(dpiText) ?? 144} dpi
              </span>
            )}
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

          <fieldset className="col-span-2 min-w-0 border-t border-tvx-line pt-2">
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

        <aside data-testid="screenshot-preview-pane" className="flex min-w-0 flex-col gap-2">
          <span className="text-[10px] uppercase tracking-wider text-tvx-dim">Preview</span>
          <div
            style={{
              height: target === 'figure' ? 'clamp(6rem,16vh,9rem)' : 'clamp(7rem,22vh,12rem)',
            }}
            className="grid min-w-0 grid-rows-[minmax(0,1fr)] place-items-center overflow-hidden rounded border border-tvx-line bg-[repeating-conic-gradient(var(--color-tvx-panel)_0_25%,var(--color-tvx-bg)_0_50%)] bg-[length:12px_12px]"
          >
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
                className="h-full min-h-0 w-full min-w-0 object-contain"
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
          {target === 'figure' && (
            <fieldset
              data-testid="screenshot-figure"
              className="grid min-w-0 grid-cols-2 gap-2 border-t border-tvx-line pt-2"
            >
              <legend className="px-1 text-[10px] uppercase tracking-wider text-tvx-dim">
                Figure
              </legend>
              <Field label="Panels" hint="Each pane is captured on its own and becomes one panel">
                <span className="flex flex-wrap gap-2">
                  {views.map((id) => (
                    <label key={id} className="flex items-center gap-1 text-[11px]">
                      <input
                        type="checkbox"
                        data-testid={`screenshot-figure-panel-${id}`}
                        checked={figure.panels.includes(id)}
                        onChange={(e) =>
                          setFigure((f) => ({
                            ...f,
                            panels: e.currentTarget.checked
                              ? views.filter((v) => v === id || f.panels.includes(v))
                              : f.panels.filter((v) => v !== id),
                          }))
                        }
                      />
                      {id}
                    </label>
                  ))}
                </span>
              </Field>
              <Field label="Columns">
                <select
                  data-testid="screenshot-figure-columns"
                  className="tvx-input text-[11px]"
                  value={figure.columns}
                  onChange={(e) =>
                    setFigure((f) => ({ ...f, columns: Number(e.currentTarget.value) }))
                  }
                >
                  <option value={0}>auto</option>
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Labels">
                <select
                  data-testid="screenshot-figure-labels"
                  className="tvx-input text-[11px]"
                  value={figure.labels}
                  onChange={(e) =>
                    setFigure((f) => ({
                      ...f,
                      labels: e.currentTarget.value as FigureOptions['labels'],
                    }))
                  }
                >
                  <option value="upper">A, B, C</option>
                  <option value="lower">a, b, c</option>
                  <option value="none">none</option>
                </select>
                <input
                  data-testid="screenshot-figure-labelpt"
                  className="tvx-input w-14 font-mono text-[11px]"
                  inputMode="decimal"
                  value={figure.labelPt}
                  title="Label size in points"
                  onChange={(e) =>
                    setFigure((f) => ({
                      ...f,
                      labelPt: numberOrUndefined(e.currentTarget.value) ?? f.labelPt,
                    }))
                  }
                />
                <span className="text-[10px] text-tvx-dim">pt</span>
              </Field>
              <Field label="Gutter (mm)" hint="Between panels and around the page">
                <input
                  data-testid="screenshot-figure-gutter"
                  className="tvx-input w-14 font-mono text-[11px]"
                  inputMode="decimal"
                  value={figure.gutterMm}
                  onChange={(e) =>
                    setFigure((f) => ({
                      ...f,
                      gutterMm: numberOrUndefined(e.currentTarget.value) ?? 0,
                    }))
                  }
                />
                <select
                  data-testid="screenshot-figure-background"
                  className="tvx-input text-[11px]"
                  value={figure.background}
                  title="The page behind the panels"
                  onChange={(e) =>
                    setFigure((f) => ({
                      ...f,
                      background: e.currentTarget.value as FigureOptions['background'],
                    }))
                  }
                >
                  <option value="white">white page</option>
                  <option value="transparent">transparent page</option>
                </select>
              </Field>
            </fieldset>
          )}
        </aside>
      </div>
    </DialogFrame>
  );
}
