/**
 * `pnpm --filter @tetravox/embed pack:embed` → `dist-pkg/tetravox-embed-<version>.tgz`.
 *
 * What a host installs: the built page, the licence, the protocol contract in both the prose and
 * the machine-readable form, and a manifest saying which build this is.
 *
 * ```
 * tetravox-embed-<version>/
 *   manifest.json          { name, version, protocol, sha }
 *   LICENSE
 *   EMBED.md               docs/EMBED.md
 *   protocol.schema.json
 *   viewspec.schema.json
 *   dist/index.html
 *   dist/assets/*
 * ```
 *
 * One directory prefix inside the tarball, the way npm and `emit-module-sdk.mjs` do it, so
 * `tar xzf` lands one folder rather than scattering `dist/` into the current directory.
 *
 * `sha` is the git commit this was built from — `git rev-parse HEAD`, or the empty string outside a
 * checkout, which is the honest answer for a tarball built from an export. It is there so that a
 * host serving a bundle can say which one, which is the first question when a viewer misbehaves in
 * an application nobody can reproduce locally.
 *
 * `tar` is the system one. The alternative is a tar implementation as a dependency, and the
 * lockfile is frozen (§12.3); `emit-module-sdk.mjs` shells out to `npm pack` for the same reason.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(here, '../..');

const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
const { version } = pkg;
const name = `tetravox-embed-${version}`;

const dist = path.join(here, 'dist');
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('no dist/index.html — run `pnpm --filter @tetravox/embed build` first');
  process.exit(1);
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const out = path.join(here, 'dist-pkg');
const staging = path.join(out, name);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

cpSync(dist, path.join(staging, 'dist'), { recursive: true });
cpSync(path.join(repoRoot, 'LICENSE'), path.join(staging, 'LICENSE'));
cpSync(path.join(repoRoot, 'docs/EMBED.md'), path.join(staging, 'EMBED.md'));
cpSync(path.join(here, 'protocol.schema.json'), path.join(staging, 'protocol.schema.json'));
cpSync(path.join(here, 'viewspec.schema.json'), path.join(staging, 'viewspec.schema.json'));

writeFileSync(
  path.join(staging, 'manifest.json'),
  `${JSON.stringify({ name: '@tetravox/embed', version, protocol: 1, sha: gitSha() }, null, 2)}\n`
);

const tarball = path.join(out, `${name}.tgz`);
rmSync(tarball, { force: true });
// `--no-mac-metadata` is bsdtar's; GNU tar does not have it and does not need it. Tried and
// ignored rather than branched on, so the same script runs on macOS and on the Linux runner.
const args = ['-czf', tarball, '-C', out, name];
try {
  execFileSync('tar', ['--no-mac-metadata', ...args], { stdio: 'inherit' });
} catch {
  execFileSync('tar', args, { stdio: 'inherit' });
}
rmSync(staging, { recursive: true, force: true });

console.log(`packed ${path.relative(repoRoot, tarball)}`);
