// Runs the real changelog, release and check scripts in a throwaway git
// repository with one plugin, the way a release is made.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dir;
let env;

const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
const run = (script, ...args) => spawnSync(process.execPath, [path.join(dir, 'scripts', script), ...args], { cwd: dir, env, encoding: 'utf8' });
const write = (file, text) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
const commit = (subject, file = 'demo/index.js') => {
  write(file, `// ${subject}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', subject);
};
const manifest = (extra = {}) => JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', minAppVersion: '1.15.0', ...extra }, null, 2);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'plugin-release-'));
  // No user or system git config: no signing, no line-end conversion, a fixed identity.
  // Not on GitHub either, even in CI: the scripts then print annotations instead.
  writeFileSync(path.join(dir, '.gitconfig-empty'), '');
  env = {
    ...process.env, GITHUB_ACTIONS: '', GIT_CONFIG_GLOBAL: path.join(dir, '.gitconfig-empty'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org',
  };
  for (const f of ['changelog-lib.mjs', 'changelog.mjs', 'check.mjs', 'release.mjs']) {
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    copyFileSync(path.join(SCRIPTS, f), path.join(dir, 'scripts', f));
  }
  write('.gitignore', '.gitconfig-empty\n');
  write('publish.json', JSON.stringify({ publish: ['demo'], skip: {} }));
  write('demo/manifest.json', manifest());
  write('demo/CHANGELOG.md', '# Changelog\n\n## Unreleased\n');
  git('init', '-q', '-b', 'main');
  commit('feat: first version');
  git('tag', '-a', 'demo@1.0.0', '-m', 'demo 1.0.0');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('releasing a plugin', () => {
  it('drafts notes from the commits since the tag, releases them and passes the tag check', () => {
    commit('feat: show the agenda');
    commit('fix: keep the header');
    commit('test: cover the header');
    commit('fix: something elsewhere', 'other/file.js');

    const draft = run('changelog.mjs', 'demo', '--no-thanks');
    expect(draft.status).toBe(0);
    expect(readFileSync(path.join(dir, 'demo/CHANGELOG.md'), 'utf8'))
      .toBe('# Changelog\n\n## Unreleased\n\n### Added\n- Show the agenda\n\n### Fixed\n- Keep the header\n');

    const release = run('release.mjs', 'demo', 'patch');
    expect(release.stderr).not.toMatch(/no notes/);
    expect(release.status).toBe(0);
    expect(git('tag', '--list', 'demo@1.0.1')).toBe('demo@1.0.1');
    expect(git('status', '--porcelain')).toBe('');
    const committed = git('show', 'demo@1.0.1:demo/CHANGELOG.md');
    expect(committed).toMatch(/^## Unreleased\n\n## 1\.0\.1 \(\d{4}-\d\d-\d\d\)\n\n### Added\n- Show the agenda\n\n### Fixed\n- Keep the header$/m);

    const check = run('check.mjs', '--tag', 'demo@1.0.1');
    expect(check.status).toBe(0);
    expect(check.stderr).not.toMatch(/warning/);

    // Nothing new since the release.
    run('changelog.mjs', 'demo', '--no-thanks');
    expect(git('status', '--porcelain')).toBe('');
  });

  it('releases without notes, with a warning from the release and from the tag check', () => {
    commit('fix: keep the header');

    const release = run('release.mjs', 'demo', 'patch');
    expect(release.status).toBe(0);
    expect(release.stderr).toMatch(/demo 1\.0\.1 has no notes/);
    expect(git('tag', '--list', 'demo@1.0.1')).toBe('demo@1.0.1');
    expect(git('show', 'demo@1.0.1:demo/CHANGELOG.md')).not.toMatch(/1\.0\.1/);

    const check = run('check.mjs', '--tag', 'demo@1.0.1');
    expect(check.status).toBe(0);
    expect(check.stderr).toMatch(/warning: demo\/CHANGELOG\.md: 1\.0\.1 has no notes/);
  });

  it('annotates the warning for GitHub without failing the job', () => {
    const check = spawnSync(process.execPath, [path.join(dir, 'scripts', 'check.mjs'), '--tag', 'demo@1.0.0'],
      { cwd: dir, env: { ...env, GITHUB_ACTIONS: 'true' }, encoding: 'utf8' });
    expect(check.status).toBe(0);
    expect(check.stdout).toMatch(/^::warning file=demo\/CHANGELOG\.md::1\.0\.0 has no notes/m);
  });

  it('warns about a published plugin without a CHANGELOG.md', () => {
    rmSync(path.join(dir, 'demo/CHANGELOG.md'));
    const check = run('check.mjs');
    expect(check.status).toBe(0);
    expect(check.stderr).toMatch(/warning: demo\/CHANGELOG\.md: there is no CHANGELOG\.md/);
  });

  it('keeps edited notes when the release fails', () => {
    commit('fix: keep the header');
    write('demo/manifest.json', manifest({ minAppVersion: undefined }));
    git('commit', '-q', '-am', 'chore: break the manifest');
    const notes = '# Changelog\n\n## Unreleased\n\n### Fixed\n- Keep the header, edited\n';
    write('demo/CHANGELOG.md', notes);

    const release = run('release.mjs', 'demo', 'patch');
    expect(release.status).toBe(1);
    expect(git('tag', '--list', 'demo@1.0.1')).toBe('');
    expect(readFileSync(path.join(dir, 'demo/CHANGELOG.md'), 'utf8')).toBe(notes);
  });

  it('starts from the last version change in the manifest when there is no tag', () => {
    git('tag', '-d', 'demo@1.0.0');
    commit('fix: before the bump');
    write('demo/manifest.json', manifest({ version: '1.1.0' }));
    git('commit', '-q', '-am', 'chore: release demo 1.1.0');
    commit('feat: after the bump');

    run('changelog.mjs', 'demo', '--no-thanks');
    const text = readFileSync(path.join(dir, 'demo/CHANGELOG.md'), 'utf8');
    expect(text).toMatch(/- After the bump/);
    expect(text).not.toMatch(/before the bump/i);
  });
});
