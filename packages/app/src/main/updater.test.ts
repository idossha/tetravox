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
