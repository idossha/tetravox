// A Windows build that sees a certificate records its publisher in app-update.yml, and every copy
// installed from it then refuses all updates (docs/RELEASING.md §5). These run the real script against
// a stub electron-builder and report what the stub was handed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(args, { host, env = {} }) {
  const tree = mkdtempSync(join(tmpdir(), 'tvx-builder-'));
  try {
    const bin = join(tree, 'packages/app/node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(tree, 'scripts'));
    mkdirSync(join(tree, 'stub'));
    copyFileSync(
      join(ROOT, 'scripts/electron-builder.sh'),
      join(tree, 'scripts/electron-builder.sh')
    );
    writeFileSync(
      join(bin, 'electron-builder'),
      '#!/usr/bin/env bash\necho "CSC_LINK=${CSC_LINK-unset} WIN_CSC_LINK=${WIN_CSC_LINK-unset} ARGS=$*"\n'
    );
    writeFileSync(join(tree, 'stub/uname'), `#!/usr/bin/env bash\necho ${host}\n`);
    chmodSync(join(bin, 'electron-builder'), 0o755);
    chmodSync(join(tree, 'stub/uname'), 0o755);
    const out = spawnSync('bash', [join(tree, 'scripts/electron-builder.sh'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(tree, 'stub')}:${process.env.PATH}`, ...env },
    });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout;
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

const CERT = { CSC_LINK: 'apple.p12', CSC_KEY_PASSWORD: 'x', WIN_CSC_LINK: 'win.p12' };

for (const flag of ['--win', '--windows', '-w']) {
  for (const host of ['Darwin', 'Linux']) {
    test(`${flag} on ${host} never sees a certificate`, () => {
      assert.match(run([flag, '--x64'], { host, env: CERT }), /CSC_LINK=unset WIN_CSC_LINK=unset/);
    });
  }
}

test('a bare build on a Windows host never sees a certificate', () => {
  const out = run(['--x64'], { host: 'MINGW64_NT-10.0-20348', env: CERT });
  assert.match(out, /CSC_LINK=unset WIN_CSC_LINK=unset/);
});

test('a mac build keeps its certificate and its signed config', () => {
  const out = run(['--mac'], { host: 'Darwin', env: CERT });
  assert.match(out, /CSC_LINK=apple\.p12/);
  assert.doesNotMatch(out, /hardenedRuntime=false/);
});

test('electron-builder.yml does not name a Windows publisher', () => {
  const config = readFileSync(join(ROOT, 'packages/app/electron-builder.yml'), 'utf8');
  assert.doesNotMatch(config, /^\s*publisherName\s*:/m);
});

test('release.yml checks the Windows build before it publishes', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const check = workflow.indexOf('name: The Windows build must not name a publisher');
  assert.notEqual(check, -1);
  assert.ok(check < workflow.indexOf('name: Publish the Release'));
});
