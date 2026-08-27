/**
 * The webgl2-null screen (§1, §8).
 *
 * Chromium M137 removed the *automatic* SwiftShader WebGL fallback, so on a blocklisted driver
 * `getContext('webgl2')` returns `null` and there is no viewport to show. The app launches with
 * `--enable-unsafe-swiftshader` (§5), which is what usually prevents this — so when it happens
 * anyway, the actionable thing is `chrome://gpu`, not a retry button.
 */

export function Webgl2Error({ detail }: { detail?: string | null }): React.JSX.Element {
  return (
    <div
      data-testid="webgl2-error"
      role="alert"
      className="grid h-full place-items-center bg-tvx-bg p-8"
    >
      <div className="max-w-xl rounded border border-tvx-danger/50 bg-tvx-danger/10 p-6 text-sm">
        <h1 className="mb-2 text-base font-semibold text-tvx-danger">No WebGL2 context</h1>
        <p className="mb-2 text-tvx-dim">
          <code>getContext(&apos;webgl2&apos;)</code> returned <code>null</code>. Chromium M137
          removed the automatic SwiftShader fallback, so a blocklisted GPU driver disables WebGL2
          outright — Tetravox cannot render volumes or meshes without it.
        </p>
        <p className="mb-2 text-tvx-dim">
          Open <code>chrome://gpu</code> in this window&apos;s DevTools to see which feature is
          blocklisted and why. On Linux, an AppImage launched without <code>--no-sandbox</code> and
          without a correctly-owned <code>chrome-sandbox</code> presents the same way.
        </p>
        {detail != null && detail !== '' && (
          <pre
            data-testid="webgl2-error-detail"
            className="mt-3 overflow-x-auto rounded bg-tvx-bg/60 p-2 font-mono text-[10px] text-tvx-dim"
          >
            {detail}
          </pre>
        )}
      </div>
    </div>
  );
}
