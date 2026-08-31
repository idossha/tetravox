/**
 * In-app updates (§12.4): the policy, not the plumbing.
 *
 * `module-store.test.ts`'s doctrine again — every assertion is a **refusal or an admission**,
 * because that is the feature: a dev build never checks, a `--job` run never checks, the launch
 * check honours the preference and the skipped version, a manual check un-skips, nothing downloads
 * before the user asks and nothing installs before a download has landed. electron-updater itself
 * is never loaded: every test injects an `UpdaterImpl` stub (the constructor's seam exists for
 * exactly this), and the `'notify'` feed goes through the injected `fetchImpl` with no network,
 * exactly as `sample-data.test.ts` does.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ home: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (): string => dirs.home,
    getVersion: (): string => '0.3.0',
    isPackaged: false,
  },
  net: {
    fetch: async (): Promise<Response> => new Response(null, { status: 404 }),
  },
  shell: { openExternal: async (): Promise<void> => {} },
}));

import { readSettings, writeSettings } from './settings';
import type { UpdateStatus, UpdaterImpl } from './updater';
import { UpdaterService, feedVersion, plainNotes, updateMode } from './updater';

/** A controllable stand-in for electron-updater: the tests fire its events by hand. */
function stubImpl(overrides: Partial<UpdaterImpl> = {}): UpdaterImpl & {
  fire(event: string, payload?: unknown): void;
  calls: string[];
} {
  const listeners = new Map<string, ((payload: never) => void)[]>();
  const calls: string[] = [];
  return {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    calls,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return this;
    },
    fire(event, payload) {
      for (const listener of listeners.get(event) ?? []) {
        (listener as (p: unknown) => void)(payload);
      }
    },
    checkForUpdates: async (): Promise<unknown> => {
      calls.push('check');
      return null;
    },
    downloadUpdate: async (): Promise<unknown> => {
      calls.push('download');
      return null;
    },
    quitAndInstall: (): void => {
      calls.push('install');
    },
    ...overrides,
  };
}

const INPLACE = { packaged: true, isJob: false, platform: 'darwin' as const, version: '0.3.0' };

function service(
  deps: ConstructorParameters<typeof UpdaterService>[0] = {}
): [UpdaterService, UpdateStatus[]] {
  const pushed: UpdateStatus[] = [];
  const svc = new UpdaterService({ ...deps, onStatus: (s) => pushed.push(s) });
  return [svc, pushed];
}

beforeEach(() => {
  dirs.home = mkdtempSync(join(tmpdir(), 'tvx-updater-'));
});

afterEach(() => {
  rmSync(dirs.home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('updateMode', () => {
  it('is off for a dev build, whatever the platform', () => {
    expect(
      updateMode({ packaged: false, isJob: false, platform: 'darwin', appImage: undefined })
    ).toBe('off');
  });

  it('is off for a --job run: nobody is there to answer', () => {
    expect(
      updateMode({ packaged: true, isJob: true, platform: 'darwin', appImage: undefined })
    ).toBe('off');
  });

  it('is inplace on macOS and Windows, and for a Linux AppImage launch', () => {
    expect(
      updateMode({ packaged: true, isJob: false, platform: 'darwin', appImage: undefined })
    ).toBe('inplace');
    expect(
      updateMode({ packaged: true, isJob: false, platform: 'win32', appImage: undefined })
    ).toBe('inplace');
    expect(
      updateMode({
        packaged: true,
        isJob: false,
        platform: 'linux',
        appImage: '/x/Tetravox.AppImage',
      })
    ).toBe('inplace');
  });

  it('is notify for a Linux install that is not an AppImage (.deb / .tar.gz)', () => {
    expect(
      updateMode({ packaged: true, isJob: false, platform: 'linux', appImage: undefined })
    ).toBe('notify');
    expect(updateMode({ packaged: true, isJob: false, platform: 'linux', appImage: '' })).toBe(
      'notify'
    );
  });
});

describe('the off mode refuses everything, quietly', () => {
  it('a check answers idle and never touches the impl', async () => {
    const impl = stubImpl();
    const [svc] = service({ packaged: false, impl, version: '0.3.0' });
    const status = await svc.check();
    expect(status.phase).toBe('idle');
    expect(status.mode).toBe('off');
    expect(impl.calls).toEqual([]);
  });

  it('the launch check schedules nothing', () => {
    let scheduled = 0;
    const [svc] = service({
      packaged: false,
      version: '0.3.0',
      scheduleLaunchCheck: () => {
        scheduled += 1;
      },
    });
    svc.startLaunchCheck();
    expect(scheduled).toBe(0);
  });
});

describe('the launch check', () => {
  it('honours checkForUpdates: false', () => {
    writeSettings({ checkForUpdates: false });
    let scheduled = 0;
    const [svc] = service({
      ...INPLACE,
      impl: stubImpl(),
      scheduleLaunchCheck: () => {
        scheduled += 1;
      },
    });
    svc.startLaunchCheck();
    expect(scheduled).toBe(0);
  });

  it('runs when the preference is on (the default), and configures the impl safely', async () => {
    const impl = stubImpl();
    const [svc] = service({ ...INPLACE, impl, scheduleLaunchCheck: (run) => run() });
    svc.startLaunchCheck();
    await vi.waitFor(() => expect(impl.calls).toEqual(['check']));
    // The three lines that make "notify, then the user chooses" true.
    expect(impl.autoDownload).toBe(false);
    expect(impl.autoInstallOnAppQuit).toBe(true);
    expect(impl.allowDowngrade).toBe(false);
  });

  it('stays silent about the skipped version', async () => {
    writeSettings({ skippedUpdateVersion: '0.4.0' });
    const impl = stubImpl();
    impl.checkForUpdates = async (): Promise<unknown> => {
      impl.fire('update-available', { version: '0.4.0', releaseNotes: 'notes' });
      return null;
    };
    const [svc, pushed] = service({ ...INPLACE, impl });
    await svc.check({ auto: true });
    expect(pushed.every((s) => s.phase !== 'available')).toBe(true);
    expect(svc.current().phase).toBe('idle');
  });

  it("the scheduled run bails when the user's own actions moved the phase off idle first", async () => {
    const impl = stubImpl();
    impl.checkForUpdates = async (): Promise<unknown> => {
      impl.calls.push('check');
      impl.fire('update-available', { version: '0.4.0' });
      return null;
    };
    let fire = (): void => {};
    const [svc] = service({
      ...INPLACE,
      impl,
      scheduleLaunchCheck: (run) => {
        fire = run;
      },
    });
    svc.startLaunchCheck();
    await svc.check(); // the user beat the timer with a manual check
    fire(); // the +6s timer lands on phase 'available' and must do nothing
    expect(impl.calls).toEqual(['check']);
    expect(svc.current().auto).toBe(false);
  });

  it('announces a version newer than the skipped one', async () => {
    writeSettings({ skippedUpdateVersion: '0.4.0' });
    const impl = stubImpl();
    impl.checkForUpdates = async (): Promise<unknown> => {
      impl.fire('update-available', { version: '0.5.0' });
      return null;
    };
    const [svc] = service({ ...INPLACE, impl });
    await svc.check({ auto: true });
    expect(svc.current().phase).toBe('available');
    expect(svc.current().available).toBe('0.5.0');
    expect(svc.current().auto).toBe(true);
  });
});

describe('a manual check', () => {
  it('reports the skipped version anyway, and clears the skip', async () => {
    writeSettings({ skippedUpdateVersion: '0.4.0' });
    const impl = stubImpl();
    impl.checkForUpdates = async (): Promise<unknown> => {
      impl.fire('update-available', { version: '0.4.0' });
      return null;
    };
    const [svc] = service({ ...INPLACE, impl });
    const status = await svc.check();
    expect(status.phase).toBe('available');
    expect(status.auto).toBe(false);
    expect(readSettings().skippedUpdateVersion).toBe('');
  });

  it('maps "nothing newer" to none', async () => {
    const impl = stubImpl();
    impl.checkForUpdates = async (): Promise<unknown> => {
      impl.fire('update-not-available');
      return null;
    };
    const [svc] = service({ ...INPLACE, impl });
    expect((await svc.check()).phase).toBe('none');
  });

  it('maps a rejected check to an error status instead of throwing', async () => {
    const impl = stubImpl({
      checkForUpdates: async (): Promise<unknown> => {
        throw new Error('ENOTFOUND github.com\nlong stack');
      },
    });
    const [svc] = service({ ...INPLACE, impl });
    const status = await svc.check();
    expect(status.phase).toBe('error');
    // Only the first line: the updater's network errors love a stack-shaped paragraph.
    expect(status.error).toBe('ENOTFOUND github.com');
  });

  it('never runs over a download — the progress on screen outranks anything a check could learn', async () => {
    const impl = stubImpl();
    impl.checkForUpdates = async (): Promise<unknown> => {
      impl.calls.push('check');
      impl.fire('update-available', { version: '0.4.0' });
      return null;
    };
    let release = (): void => {};
    impl.downloadUpdate = async (): Promise<unknown> => {
      impl.fire('download-progress', { transferred: 1, total: 2 });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      impl.fire('update-downloaded');
      return null;
    };
    const [svc] = service({ ...INPLACE, impl });
    await svc.check();
    const downloading = svc.download();
    await vi.waitFor(() => expect(svc.current().phase).toBe('downloading'));
    const status = await svc.check({ auto: true });
    expect(status.phase).toBe('downloading');
    expect(impl.calls).toEqual(['check']);
    release();
    await downloading;
    expect((await svc.check()).phase).toBe('downloaded');
  });

  it('a manual ask joining the in-flight launch check upgrades it: the skip is cleared and reported', async () => {
    writeSettings({ skippedUpdateVersion: '0.4.0' });
    const impl = stubImpl();
    let answer = (): void => {};
    let started = (): void => {};
    const checkStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    impl.checkForUpdates = async (): Promise<unknown> => {
      started();
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      impl.fire('update-available', { version: '0.4.0' });
      return null;
    };
    const [svc] = service({ ...INPLACE, impl });
    const auto = svc.check({ auto: true });
    await checkStarted;
    const manual = svc.check();
    answer();
    const [a, m] = await Promise.all([auto, manual]);
    expect(m.phase).toBe('available');
    expect(a.phase).toBe('available');
    expect(readSettings().skippedUpdateVersion).toBe('');
  });

  it('coalesces concurrent checks into one', async () => {
    const impl = stubImpl();
    impl.checkForUpdates = async (): Promise<unknown> => {
      impl.calls.push('check');
      impl.fire('update-not-available');
      return null;
    };
    const [svc] = service({ ...INPLACE, impl });
    await Promise.all([svc.check(), svc.check()]);
    expect(impl.calls).toEqual(['check']);
  });
});

describe('download and install are gated on the user having something to say yes to', () => {
  it('refuses to download before a check has announced anything', async () => {
    const impl = stubImpl();
    const [svc] = service({ ...INPLACE, impl });
    const result = await svc.download();
    expect(result.ok).toBe(false);
    expect(impl.calls).toEqual([]);
  });

  it('downloads after available, and the progress events become statuses', async () => {
    const impl = stubImpl();
    impl.checkForUpdates = async (): Promise<unknown> => {
      impl.fire('update-available', { version: '0.4.0' });
      return null;
    };
    impl.downloadUpdate = async (): Promise<unknown> => {
      impl.fire('download-progress', { transferred: 50, total: 100 });
      impl.fire('update-downloaded');
      return null;
    };
    const [svc, pushed] = service({ ...INPLACE, impl });
    await svc.check();
    expect((await svc.download()).ok).toBe(true);
    const progress = pushed.find((s) => s.phase === 'downloading' && s.received === 50);
    expect(progress?.total).toBe(100);
    expect(svc.current().phase).toBe('downloaded');
  });

  it('refuses to install before a download has landed', async () => {
    const impl = stubImpl();
    const [svc] = service({ ...INPLACE, impl });
    const result = await svc.install();
    expect(result.ok).toBe(false);
    expect(impl.calls).toEqual([]);
  });

  it('installs once downloaded', async () => {
    const impl = stubImpl();
    impl.checkForUpdates = async (): Promise<unknown> => {
      impl.fire('update-available', { version: '0.4.0' });
      return null;
    };
    impl.downloadUpdate = async (): Promise<unknown> => {
      impl.fire('update-downloaded');
      return null;
    };
    const [svc] = service({ ...INPLACE, impl });
    await svc.check();
    await svc.download();
    expect((await svc.install()).ok).toBe(true);
    expect(impl.calls).toContain('install');
  });

  it('refuses to install while confirmQuit says the unsaved edits are worth more', async () => {
    const impl = stubImpl();
    impl.checkForUpdates = async (): Promise<unknown> => {
      impl.fire('update-available', { version: '0.4.0' });
      return null;
    };
    impl.downloadUpdate = async (): Promise<unknown> => {
      impl.fire('update-downloaded');
      return null;
    };
    let allow = false;
    const [svc] = service({ ...INPLACE, impl, confirmQuit: async () => allow });
    await svc.check();
    await svc.download();
    const refused = await svc.install();
    expect(refused.ok).toBe(false);
    expect(impl.calls).not.toContain('install');
    allow = true;
    expect((await svc.install()).ok).toBe(true);
    expect(impl.calls).toContain('install');
  });

  it('a failed download becomes an error status, not a throw', async () => {
    const impl = stubImpl({
      downloadUpdate: async (): Promise<unknown> => {
        throw new Error('read ECONNRESET');
      },
    });
    impl.checkForUpdates = async (): Promise<unknown> => {
      impl.fire('update-available', { version: '0.4.0' });
      return null;
    };
    const [svc] = service({ ...INPLACE, impl });
    await svc.check();
    const result = await svc.download();
    expect(result.ok).toBe(false);
    expect(svc.current().phase).toBe('error');
  });
});

describe('skip', () => {
  it('records the version and returns to idle', async () => {
    const impl = stubImpl();
    impl.checkForUpdates = async (): Promise<unknown> => {
      impl.fire('update-available', { version: '0.4.0' });
      return null;
    };
    const [svc] = service({ ...INPLACE, impl });
    await svc.check();
    const status = svc.skip('0.4.0');
    expect(status.phase).toBe('idle');
    expect(readSettings().skippedUpdateVersion).toBe('0.4.0');
  });

  it('drops a non-string on the floor rather than persisting it', () => {
    const [svc] = service({ ...INPLACE, impl: stubImpl() });
    svc.skip({ version: '0.4.0' });
    expect(readSettings().skippedUpdateVersion).toBe('');
  });
});

describe('the notify mode (.deb / .tar.gz): says, never installs', () => {
  const NOTIFY = { packaged: true, isJob: false, platform: 'linux' as const, version: '0.3.0' };

  it('announces a newer feed version', async () => {
    const [svc] = service({
      ...NOTIFY,
      fetchImpl: async () => new Response('version: 0.4.0\nfiles:\n'),
    });
    const status = await svc.check();
    expect(status.phase).toBe('available');
    expect(status.available).toBe('0.4.0');
    expect(status.mode).toBe('notify');
  });

  it('answers none when the feed is not newer', async () => {
    const [svc] = service({
      ...NOTIFY,
      fetchImpl: async () => new Response('version: 0.3.0\n'),
    });
    expect((await svc.check()).phase).toBe('none');
  });

  it('maps a dead feed to an error status', async () => {
    const [svc] = service({
      ...NOTIFY,
      fetchImpl: async () => new Response(null, { status: 500 }),
    });
    const status = await svc.check();
    expect(status.phase).toBe('error');
    expect(status.error).toContain('500');
  });

  it('the 30s bound covers the body read, so a stalled feed cannot wedge every later check', async () => {
    vi.useFakeTimers();
    try {
      let fetches = 0;
      const [svc] = service({
        ...NOTIFY,
        fetchImpl: async (_url, init) => (
          (fetches += 1),
          {
            ok: true,
            status: 200,
            // A body that never arrives: text() settles only on abort — which is what Electron's
            // net.fetch does when the signal aborts mid-body. The already-aborted branch matters:
            // under fake timers the abort can fire before text() subscribes.
            text: () =>
              new Promise<string>((_resolve, reject) => {
                const fail = (): void => reject(new Error('aborted'));
                if (init.signal.aborted) fail();
                else init.signal.addEventListener('abort', fail);
              }),
          } as unknown as Response
        ),
      });
      const checking = svc.check();
      await vi.advanceTimersByTimeAsync(30_001);
      const status = await checking;
      expect(status.phase).toBe('error');
      // The wedge this guards against: the next check must actually RUN (a second fetch), not
      // return a promise hung on the first body forever.
      const again = svc.check();
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await again).phase).toBe('error');
      expect(fetches).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('install opens the Releases page instead of touching the machine', async () => {
    let opened = 0;
    const [svc] = service({
      ...NOTIFY,
      fetchImpl: async () => new Response('version: 0.4.0\n'),
      openReleases: () => {
        opened += 1;
      },
    });
    await svc.check();
    expect((await svc.install()).ok).toBe(true);
    expect(opened).toBe(1);
  });
});

describe('the two small parsers', () => {
  it('feedVersion reads the one line it needs', () => {
    expect(feedVersion('version: 0.4.0\nfiles:\n  - url: x.AppImage\n')).toBe('0.4.0');
    expect(feedVersion("version: '0.4.0-rc.1'\n")).toBe('0.4.0-rc.1');
    expect(feedVersion('files:\n')).toBeNull();
  });

  it('plainNotes strips the HTML the GitHub provider hands back', () => {
    expect(plainNotes('<h2>0.4.0</h2><p>One fix &amp; one feature</p>')).toBe(
      '0.4.0\nOne fix & one feature'
    );
    expect(plainNotes(undefined)).toBeUndefined();
    expect(plainNotes('')).toBeUndefined();
    expect(plainNotes([{ version: 'x', note: '<p>a</p>' }, { note: 'b' }])).toBe('a\n\nb');
  });
});
