/**
 * In-app updates (§12.4, 2026-08-31) — notice a published GitHub Release, tell the user, and act
 * only when they say so.
 *
 * The split is `module-store.ts`'s again: **main owns the network and the installer, the renderer
 * sees small JSON** — a phase, two version strings, progress numbers and an error message. Nothing
 * here pushes bytes over IPC, and nothing installs without `tetravox:update-install` carrying a
 * user's click.
 *
 * Two modes, decided once per launch by {@link updateMode}:
 *
 *  * `'inplace'` — electron-updater can replace this install: macOS (the signed zip beside every
 *    dmg is the update artefact), Windows NSIS, and a Linux AppImage. `downloadUpdate` streams the
 *    artefact, `quitAndInstall` applies it; `autoInstallOnAppQuit` means even "Later" installs on
 *    the next quit.
 *  * `'notify'` — a `.deb`/`.tar.gz` install is the package manager's (or the user's) to replace,
 *    so the app only checks the feed and offers the Releases page. The check reads the same
 *    `latest-linux.yml` electron-updater would, over `net.fetch`, so a catalogue answer and an
 *    updatable answer never disagree about what the newest version is.
 *
 * Everything else is refusal: a dev tree (`!app.isPackaged`) never checks, a `--job` run never
 * checks (nobody is there to answer), the automatic launch check honours the `checkForUpdates`
 * preference and stays silent about a version the user said to skip. A manual check ignores the
 * skip — asking again *is* un-skipping. (A *packaged but unsigned* local/fork build is `'inplace'`
 * and will check; on macOS Squirrel then refuses the swap at install time, surfaced as an 'error'
 * status — an edge only contributors' own `pnpm package` builds can reach.)
 *
 * electron-updater arrives by dynamic import inside {@link realImpl}, so unit tests inject an
 * `UpdaterImpl` and never load it — the same injected-seam reasoning as `module-store.ts`'s
 * `FetchLike` (its header explains why the tests must run with no network).
 */

import { app, net, shell } from 'electron';
import { compareVersions } from './module-store';
import { readSettings, writeSettings } from './settings';

/** Where a `'notify'` check reads, and where its button lands. One repo, stated once. */
const RELEASES_URL = 'https://github.com/idossha/tetravox/releases';
const FEED_LATEST_LINUX =
  'https://github.com/idossha/tetravox/releases/latest/download/latest-linux.yml';

/** Mirrored in `preload/index.ts` (which must not import main) — keep the two in step by hand. */
export type UpdatePhase =
  'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  /** `app.getVersion()` — the renderer's only version readout, so it rides along on every status. */
  current: string;
  /** The newest published version, once a check has answered. */
  available?: string;
  /** Release notes for `available`, reduced to plain text in {@link plainNotes}. */
  notes?: string;
  received?: number;
  total?: number;
  error?: string;
  /**
   * This launch's posture, so the dialog picks its buttons and its copy off the truth: `'inplace'`
   * downloads and restarts, `'notify'` (a `.deb`/`.tar.gz`) offers the Releases page, `'off'` (a
   * dev or `--job` build) says so instead of pretending to check.
   */
  mode: UpdateMode;
  /**
   * True on statuses born from the launch check, so the renderer knows this `available` was not
   * asked for and shows a toast instead of assuming a dialog is open.
   */
  auto?: boolean;
}

/** The slice of electron-updater's `AppUpdater` this module drives. Injected whole by the tests. */
export interface UpdaterImpl {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  on(event: string, listener: (payload: never) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

/** `module-store.ts`'s seam, verbatim: how a `'notify'` check fetches with no server in the tests. */
export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface UpdaterDeps {
  /** `'inplace'` builds get electron-updater; `null` means "load the real one on first use". */
  impl?: UpdaterImpl | null;
  fetchImpl?: FetchLike;
  platform?: NodeJS.Platform;
  /** Linux only: set for an AppImage launch, absent for `.deb`/`.tar.gz` (electron-updater's own test). */
  appImage?: string | undefined;
  packaged?: boolean;
  isJob?: boolean;
  version?: string;
  onStatus?: (status: UpdateStatus) => void;
  /** The launch check's grace delay, injectable so the tests need no clock. */
  scheduleLaunchCheck?: (run: () => void) => void;
  openReleases?: () => void;
  /**
   * Asked before `quitAndInstall` (§5 rule 12's concern, not electron-updater's): on Windows and
   * the AppImage the installer runs *before* `app.quit()`, so the ordinary close guard's Cancel
   * would arrive after the swap. Resolve false to refuse the install. Absent = no unsaved state
   * to protect (the tests, and any future caller without a window).
   */
  confirmQuit?: () => Promise<boolean>;
}

export type UpdateMode = 'inplace' | 'notify' | 'off';

/** `{ ok, error? }` like every other action result on the bridge; it never throws. */
export interface UpdateActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Which of the three postures this launch takes. Decided from facts, not preference — the
 * `checkForUpdates` setting gates the *automatic* check, never the mode: a user who switched the
 * launch check off can still ask by hand from the menu.
 */
export function updateMode(opts: {
  packaged: boolean;
  isJob: boolean;
  platform: NodeJS.Platform;
  appImage: string | undefined;
}): UpdateMode {
  // A dev tree has nothing an updater could replace, and a `--job` run has nobody to answer.
  // Deliberately NOT a signing check: a packaged-but-unsigned contributor build still checks (and
  // on macOS fails honestly at install, when Squirrel refuses the swap) — see the header.
  if (!opts.packaged || opts.isJob) return 'off';
  if (opts.platform === 'linux' && (opts.appImage === undefined || opts.appImage === '')) {
    return 'notify';
  }
  return 'inplace';
}

/**
 * Release notes, reduced to plain text. The GitHub provider hands back the release body as HTML;
 * the dialog renders text (§5: small JSON, and nothing renderer-side interprets markup from the
 * network). Tags out, entities back, whitespace collapsed to the paragraph breaks that survive.
 */
export function plainNotes(raw: unknown): string | undefined {
  const text = Array.isArray(raw)
    ? raw
        .map((n) =>
          typeof n === 'object' && n !== null
            ? String((n as { note?: unknown }).note ?? '')
            : String(n)
        )
        .join('\n')
    : typeof raw === 'string'
      ? raw
      : undefined;
  if (text === undefined || text === '') return undefined;
  const out = text
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out === '' ? undefined : out.slice(0, 16 * 1024);
}

/**
 * The version a `latest-linux.yml` names. A one-key read rather than a YAML dependency: the file is
 * electron-builder's own, its `version:` line is a bare semver, and §12.3 freezes the dependency
 * list for less than this.
 */
export function feedVersion(yml: string): string | null {
  const match = /^version:\s*['"]?([0-9][^'"\s]*)/m.exec(yml);
  return match?.[1] ?? null;
}

const defaultFetch: FetchLike = (url, init) => net.fetch(url, init);

export class UpdaterService {
  private readonly deps: Required<Pick<UpdaterDeps, 'packaged' | 'isJob' | 'platform'>> &
    UpdaterDeps;
  readonly mode: UpdateMode;
  private status: UpdateStatus;
  private impl: UpdaterImpl | null;
  private implWired = false;
  private checking: Promise<UpdateStatus> | null = null;
  /** What the in-flight or last check was: the launch check stays silent about a skipped version. */
  private auto = false;

  constructor(deps: UpdaterDeps = {}) {
    this.deps = {
      packaged: deps.packaged ?? app.isPackaged,
      isJob: deps.isJob ?? false,
      platform: deps.platform ?? process.platform,
      ...deps,
    };
    this.mode = updateMode({
      packaged: this.deps.packaged,
      isJob: this.deps.isJob,
      platform: this.deps.platform,
      appImage: deps.appImage ?? process.env['APPIMAGE'],
    });
    this.impl = deps.impl ?? null;
    this.status = {
      phase: 'idle',
      current: this.deps.version ?? app.getVersion(),
      mode: this.mode,
    };
  }

  /** The renderer's pull — boot, and every open of the dialog. Never a stale promise, always now. */
  current(): UpdateStatus {
    return this.status;
  }

  /**
   * The launch check. Scheduled, not awaited: a network round trip has no business gating first
   * paint, and the renderer's listener is subscribed long before the answer could arrive.
   */
  startLaunchCheck(): void {
    if (this.mode === 'off') return;
    if (!readSettings().checkForUpdates) return;
    // Re-tested at fire time: six seconds is long enough for the user to have opened the dialog,
    // checked by hand and pressed Download, and a scheduled check must not stomp on any of that.
    const run = (): void => {
      if (this.status.phase === 'idle') void this.check({ auto: true });
    };
    (this.deps.scheduleLaunchCheck ?? ((fn) => setTimeout(fn, 6000)))(run);
  }

  /**
   * Ask the feed. `auto` is the launch check: it says nothing about a version the user skipped and
   * swallows its errors into the status rather than a toast — an offline laptop at breakfast is not
   * an error the user caused. A manual check reports everything, skip included: asking again is
   * un-skipping, and `skippedUpdateVersion` is cleared so the launch check agrees tomorrow.
   */
  async check(opts: { auto?: boolean } = {}): Promise<UpdateStatus> {
    if (this.mode === 'off') {
      return this.push({ phase: 'idle' });
    }
    // Never over a download: a 'checking' push would blank the progress the user is watching, and
    // nothing a check could learn beats the artefact already arriving. Same for 'downloaded' —
    // the sha512-verified file on disk is the answer.
    if (this.status.phase === 'downloading' || this.status.phase === 'downloaded') {
      return this.status;
    }
    if (this.checking !== null) {
      // A manual ask joining an in-flight launch check *upgrades* it: the skip must not silence
      // an answer the user just requested by hand.
      if (opts.auto !== true && this.auto) {
        this.auto = false;
        if (readSettings().skippedUpdateVersion !== '') {
          writeSettings({ skippedUpdateVersion: '' });
        }
      }
      return this.checking;
    }
    this.auto = opts.auto === true;
    if (!this.auto && readSettings().skippedUpdateVersion !== '') {
      writeSettings({ skippedUpdateVersion: '' });
    }
    this.push({ phase: 'checking', error: undefined });
    this.checking = (this.mode === 'inplace' ? this.checkInPlace() : this.checkNotify()).finally(
      () => {
        this.checking = null;
      }
    );
    return this.checking;
  }

  /** The user's click on Download. `'inplace'` only; the `'notify'` button opens the page instead. */
  async download(): Promise<UpdateActionResult> {
    if (this.mode !== 'inplace' || this.status.phase !== 'available') {
      return { ok: false, error: 'no update is ready to download' };
    }
    try {
      const impl = await this.wiredImpl();
      this.push({ phase: 'downloading', received: 0, total: this.status.total });
      await impl.downloadUpdate();
      // `update-downloaded` has already pushed 'downloaded'; belt-and-braces for an impl that
      // resolves without eventing (the tests' stub, an older electron-updater). `current()`, not
      // `this.status`: the narrowing from the guard above does not know the await mutated it.
      if (this.current().phase === 'downloading') this.push({ phase: 'downloaded' });
      return { ok: true };
    } catch (err) {
      this.push({ phase: 'error', error: errorText(err) });
      return { ok: false, error: errorText(err) };
    }
  }

  /** The user's click on Restart — or on Open Releases Page, which is what a `'notify'` build has. */
  async install(): Promise<UpdateActionResult> {
    if (this.mode === 'notify') {
      (this.deps.openReleases ?? (() => void shell.openExternal(RELEASES_URL)))();
      return { ok: true };
    }
    if (this.status.phase !== 'downloaded') {
      return { ok: false, error: 'no update has been downloaded' };
    }
    // BEFORE quitAndInstall, not instead of the close guard: on Windows and the AppImage the
    // installer runs first and `app.quit()` only after, so the guard's Cancel would arrive with
    // the swap already done. The question has to be asked while refusing still means something.
    if (this.deps.confirmQuit !== undefined && !(await this.deps.confirmQuit())) {
      return { ok: false, error: 'unsaved edits — save or discard them first' };
    }
    try {
      const impl = await this.wiredImpl();
      impl.quitAndInstall();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  /**
   * "Skip this version": the launch check stays quiet about exactly this one. A newer release
   * notifies again — a skip is an answer about a version, not about updates.
   */
  skip(version: unknown): UpdateStatus {
    if (typeof version === 'string' && version !== '') {
      writeSettings({ skippedUpdateVersion: version });
    }
    return this.push({ phase: 'idle', available: undefined, notes: undefined });
  }

  // ----------------------------------------------------------------------------------------------

  private async checkInPlace(): Promise<UpdateStatus> {
    try {
      const impl = await this.wiredImpl();
      await impl.checkForUpdates();
      // The events pushed 'available'/'none' already; a resolve with neither means the provider
      // answered with nothing newer.
      if (this.status.phase === 'checking') return this.push({ phase: 'none' });
      return this.status;
    } catch (err) {
      return this.push({ phase: 'error', error: errorText(err) });
    }
  }

  /** `.deb`/`.tar.gz`: read the release feed, compare, and only ever *say* — never install. */
  private async checkNotify(): Promise<UpdateStatus> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      let text: string;
      try {
        const response = await (this.deps.fetchImpl ?? defaultFetch)(FEED_LATEST_LINUX, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`feed answered ${response.status}`);
        // The timer stays armed across the body read: `net.fetch` resolves at the *headers*, and a
        // body that stalls after them would otherwise hang this promise — and with it `checking`,
        // which is the one flag every later check() coalesces on — for the rest of the session.
        text = await response.text();
      } finally {
        clearTimeout(timer);
      }
      const version = feedVersion(text);
      if (version === null) throw new Error('the feed carried no version');
      if (compareVersions(version, this.status.current) > 0) {
        return this.announce(version, undefined);
      }
      return this.push({ phase: 'none', available: version });
    } catch (err) {
      return this.push({ phase: 'error', error: errorText(err) });
    }
  }

  /** One gate for both feeds: the launch check drops a skipped version on the floor, silently. */
  private announce(version: string, notes: string | undefined): UpdateStatus {
    if (this.auto && readSettings().skippedUpdateVersion === version) {
      return this.push({ phase: 'idle', available: undefined, notes: undefined });
    }
    return this.push({ phase: 'available', available: version, notes });
  }

  private async wiredImpl(): Promise<UpdaterImpl> {
    const impl = this.impl ?? (this.impl = await realImpl());
    if (!this.implWired) {
      this.implWired = true;
      impl.autoDownload = false;
      // "Later" still lands the update on the next quit — the least surprising meaning of having
      // pressed Download and then gone back to work.
      impl.autoInstallOnAppQuit = true;
      impl.allowDowngrade = false;
      impl.on('update-available', (info: { version?: string; releaseNotes?: unknown }) => {
        this.announce(String(info?.version ?? ''), plainNotes(info?.releaseNotes));
      });
      impl.on('update-not-available', () => void this.push({ phase: 'none' }));
      impl.on('download-progress', (p: { transferred?: number; total?: number }) => {
        this.push({
          phase: 'downloading',
          received: typeof p?.transferred === 'number' ? p.transferred : 0,
          total: typeof p?.total === 'number' ? p.total : 0,
        });
      });
      impl.on('update-downloaded', () => void this.push({ phase: 'downloaded' }));
      impl.on('error', (err: unknown) => {
        // Download failures surface; a failure *during a check* already becomes the check's own
        // 'error' status when the promise rejects, and double-reporting would toast twice.
        if (this.status.phase === 'downloading') {
          this.push({ phase: 'error', error: errorText(err) });
        }
      });
    }
    return impl;
  }

  private push(patch: Partial<UpdateStatus>): UpdateStatus {
    this.status = { ...this.status, ...patch, auto: this.auto };
    this.deps.onStatus?.(this.status);
    return this.status;
  }
}

/** The real electron-updater, loaded only in an `'inplace'` build and only on first use. */
async function realImpl(): Promise<UpdaterImpl> {
  // CJS package: the ESM namespace puts `autoUpdater` on the default export.
  const mod = (await import('electron-updater')) as unknown as {
    default?: { autoUpdater?: UpdaterImpl };
    autoUpdater?: UpdaterImpl;
  };
  const impl = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (impl === undefined) throw new Error('electron-updater did not export autoUpdater');
  return impl;
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // The updater's network errors love a stack-shaped paragraph; the first line carries the fact.
  return text.split('\n', 1)[0] ?? text;
}
