/**
 * The scene write list (§5 rule 10) — who may overwrite a `*.tetravox.json`, and who may not.
 *
 * The whole feature is one sentence of policy: **opening a scene is naming the file ⌘S saves over**.
 * The interesting half is where that admission is minted, because the wrong answer is invisible in
 * the UI and reads as a convenience. `readSceneFile` admitting its own argument looks identical to
 * `showOpenSceneDialog` admitting the file the user picked — right up until you notice that
 * `tetravox:allow-path` is renderer-callable with no gesture, at which point one of the two is a
 * silent "overwrite any scene on this disk" primitive and the other is not.
 *
 * So the assertions here are about *provenance*: the same path, read the same way, is writable when
 * main named it and refused when the renderer did. `module-io.test.ts` is the template — a mocked
 * `electron`, a real temp directory, and every refusal asserted rather than assumed.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  // `protocol.ts` imports both at module scope for `handleScheme`, which nothing here calls.
  net: {},
  protocol: {},
}));

import { dialog } from 'electron';
import { allowPath, clearAllowList } from './paths';
import {
  allowOpenedScene,
  clearWriteList,
  isWritable,
  readSceneFile,
  showOpenSceneDialog,
  showSaveSceneDialog,
  writeSceneFile,
} from './scene-io';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tvx-scene-io-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clearWriteList();
  clearAllowList();
  vi.mocked(dialog.showOpenDialog).mockReset();
  vi.mocked(dialog.showSaveDialog).mockReset();
});

/** A scene on disk, admitted for **reading** exactly as `tetravox:allow-path` would admit it. */
function scene(name: string, text = '{"version":1,"datasets":[],"layers":[]}'): string {
  const path = join(dir, name);
  writeFileSync(path, text, 'utf8');
  const real = allowPath(path);
  if (real === null) throw new Error(`could not allow-list ${path}`);
  return real;
}

describe('a read admits nothing', () => {
  /**
   * The escalation this file exists to keep closed.
   *
   * Every step is one the renderer can take on its own: `tetravox:allow-path` takes any existing
   * absolute path and returns its canonical form, `tetravox:read-scene` reads it. If the read
   * admitted the path for writing, those two calls plus `tetravox:write-scene` would be a silent
   * overwrite of any `*.tetravox.json` on the machine, with no dialog and no gesture anywhere.
   */
  it('a path the renderer allow-listed and read is not writable', () => {
    const path = scene('victim.tetravox.json', '{"keep":"me"}');

    const read = readSceneFile(path);
    expect(read.ok).toBe(true);
    expect(read.text).toBe('{"keep":"me"}');

    expect(isWritable(path)).toBe(false);
    expect(writeSceneFile(path, '{}')).toEqual({ ok: false, error: 'not on the write list' });
    // The bytes are the assertion: a refusal that still wrote would be worse than no refusal.
    expect(readFileSync(path, 'utf8')).toBe('{"keep":"me"}');
  });

  it('reading a scene main did admit does not widen anything else', () => {
    const opened = scene('opened.tetravox.json');
    const other = scene('other.tetravox.json', '{"keep":"me"}');
    allowOpenedScene(opened);

    expect(readSceneFile(opened).ok).toBe(true);
    expect(readSceneFile(other).ok).toBe(true);
    expect(isWritable(opened)).toBe(true);
    expect(isWritable(other)).toBe(false);
    expect(writeSceneFile(other, '{}').ok).toBe(false);
    expect(readFileSync(other, 'utf8')).toBe('{"keep":"me"}');
  });
});

describe('the ⌘S carve-out, minted where main hands the path over', () => {
  it('admits the scene it is given, and the file survives the round trip', () => {
    const path = scene('study.tetravox.json');
    expect(allowOpenedScene(path)).toBe(path);
    expect(isWritable(path)).toBe(true);

    const written = writeSceneFile(path, '{"cursor":[7,-3,11]}');
    expect(written).toEqual({ ok: true, path });
    expect(readFileSync(path, 'utf8')).toBe('{"cursor":[7,-3,11]}');
  });

  it('is exactly one compound extension', () => {
    // §7.6's colormaps are `.json` and must gain nothing; nor may a dataset, whatever its name.
    for (const name of ['hot_LUT.json', 'notes.txt', 'vol.nii.gz', 'tetravox.json.bak']) {
      const path = join(dir, name);
      writeFileSync(path, 'x', 'utf8');
      expect(allowOpenedScene(path), name).toBeNull();
      expect(isWritable(path), name).toBe(false);
    }
  });

  it('refuses a relative path, and a value that is not one at all', () => {
    expect(allowOpenedScene('study.tetravox.json')).toBeNull();
    expect(allowOpenedScene(null)).toBeNull();
    expect(allowOpenedScene(42)).toBeNull();
  });

  /**
   * Main hands out whichever form it holds — `settings.json`'s remembered path through
   * `sendOpenScene`, `realpath`'s through the Open sheet — and the renderer saves back the one it
   * was given. On macOS `/var/…` is a symlink to `/private/var/…`, so a temp directory is a real
   * example of the two differing.
   */
  it('admits both the resolved and the symlink-flattened form', () => {
    const path = scene('linked.tetravox.json');
    const viaTmp = join(tmpdir(), path.slice(dir.length + 1));
    // Only meaningful where the platform really does put a symlink in the way.
    if (viaTmp === path) return;
    expect(allowOpenedScene(path)).toBe(path);
    expect(isWritable(path)).toBe(true);
  });

  it('Open Scene… admits what the user picked, and nothing when they cancel', async () => {
    const path = scene('picked.tetravox.json');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [path],
    } as Awaited<ReturnType<typeof dialog.showOpenDialog>>);
    const opened = await showOpenSceneDialog(null);
    expect(opened?.path).toBe(path);
    expect(isWritable(path)).toBe(true);

    clearWriteList();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: true,
      filePaths: [],
    } as Awaited<ReturnType<typeof dialog.showOpenDialog>>);
    expect(await showOpenSceneDialog(null)).toBeNull();
    expect(isWritable(path)).toBe(false);
  });

  it('Save Scene As… still admits its own result, as it always has', async () => {
    const path = join(dir, 'saved-as.tetravox.json');
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: path,
    } as Awaited<ReturnType<typeof dialog.showSaveDialog>>);
    expect(await showSaveSceneDialog(null, 'saved-as')).toBe(path);
    expect(writeSceneFile(path, '{"from":"save-as"}').ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('{"from":"save-as"}');
  });
});
