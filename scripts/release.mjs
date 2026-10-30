#!/usr/bin/env node
// Release plugins: raise the version, commit, tag. Nothing is pushed.
//
//   npm run release -- smime 1.4.0
//   npm run release -- smime minor gravatar patch
//
// For each plugin: sets the version in manifest.json, package.json and
// package-lock.json, rebuilds the committed <plugin>.zip, runs the checks,
// turns the Unreleased section of CHANGELOG.md into the version's notes,
// commits only those files as "chore: release <plugin> <version>" and tags
// the commit <plugin>@<version>. Pushing the tag starts the publish workflow.
//
// Draft the notes first with `npm run changelog -- <plugin>` and edit them;
// they may be uncommitted. Without notes the release still goes ahead, with
// a warning, and the directory shows the version without a changelog.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newChangelog, releaseUnreleased } from './changelog-lib.mjs';
import { checkPlugin, readList } from './check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function fail(message) {
  console.error(message);
  process.exit(1);
}

function bump(current, how) {
  const [major, minor, patch] = current.split(/[-+]/)[0].split('.').map(Number);
  if (how === 'major') return `${major + 1}.0.0`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`;
  return how;
}

function newer(a, b) {
  const pa = a.split(/[-+]/)[0].split('.').map(Number);
  const pb = b.split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  // Same numbers: a release beats its pre-release.
  return !a.includes('-') && b.includes('-');
}

/**
 * Set the first `count` "version" keys of a JSON file, keeping its layout
 * and line ends: the top-level one, and in a lockfile the root package's.
 * Refuses when that would change anything else.
 */
function setVersion(file, version, count) {
  const raw = readFileSync(file, 'utf8');
  let left = count;
  const next = raw.replace(/("version"\s*:\s*)"[^"]*"/g, (m, key) => (left-- > 0 ? `${key}"${version}"` : m));
  const before = JSON.parse(raw);
  const after = JSON.parse(next);
  if (after.version !== version) throw new Error(`${path.relative(ROOT, file)}: could not set the version`);
  if (count === 2 && after.packages?.['']?.version !== version) throw new Error(`${path.relative(ROOT, file)}: the root package comes first in a lockfile`);
  before.version = version;
  if (count === 2 && before.packages?.['']) before.packages[''].version = version;
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${path.relative(ROOT, file)}: changing the version changed more than that`);
  writeFileSync(file, next);
}

const args = process.argv.slice(2).filter((a) => a !== '--');
if (!args.length || args.length % 2) {
  fail('usage: npm run release -- <plugin> <version|major|minor|patch> [<plugin> <version> ...]');
}

const { publish } = readList();
const releases = [];
for (let i = 0; i < args.length; i += 2) {
  const plugin = args[i];
  const manifestPath = path.join(ROOT, plugin, 'manifest.json');
  if (!existsSync(manifestPath)) fail(`${plugin}: there is no ${plugin}/manifest.json`);
  if (!publish.includes(plugin)) fail(`${plugin} is not in the publish list of publish.json, so a tag would not publish it`);
  const current = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
  const version = bump(current, args[i + 1]);
  if (!SEMVER.test(version)) fail(`${plugin}: "${args[i + 1]}" is not a version like 1.2.3 or major, minor or patch`);
  if (!newer(version, current)) fail(`${plugin}: ${version} is not newer than ${current}`);
  const tag = `${plugin}@${version}`;
  if (git('tag', '--list', tag)) fail(`the tag ${tag} already exists`);
  const files = ['manifest.json', 'package.json', 'package-lock.json', `${plugin}.zip`]
    .map((f) => `${plugin}/${f}`)
    .filter((f) => existsSync(path.join(ROOT, f)));
  const dirty = git('status', '--porcelain', '--', ...files);
  if (dirty) fail(`${plugin}: commit or undo these changes first:\n${dirty}`);
  // CHANGELOG.md is left out of that: its edited draft goes into this commit.
  releases.push({ plugin, version, tag, files, changelog: `${plugin}/CHANGELOG.md` });
}

const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const withoutNotes = [];
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
for (const { plugin, version, tag, files, changelog } of releases) {
  try {
    setVersion(path.join(ROOT, plugin, 'manifest.json'), version, 1);
    if (files.includes(`${plugin}/package.json`)) setVersion(path.join(ROOT, plugin, 'package.json'), version, 1);
    if (files.includes(`${plugin}/package-lock.json`)) setVersion(path.join(ROOT, plugin, 'package-lock.json'), version, 2);
    if (files.includes(`${plugin}/${plugin}.zip`)) {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs'), plugin], { cwd: ROOT, stdio: 'inherit' });
    }
    const problems = checkPlugin(plugin);
    if (problems.length) throw new Error(problems.map((p) => `${p.where}: ${p.message}`).join('\n'));
  } catch (err) {
    git('checkout', '--', ...files);
    fail(`${plugin}: ${err.message}\nNothing was committed for ${plugin}; its files are back as they were.`);
  }
  const changelogPath = path.join(ROOT, changelog);
  const notes = releaseUnreleased(existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : newChangelog(), version, today);
  writeFileSync(changelogPath, notes.text);
  if (!notes.released) {
    withoutNotes.push(plugin);
    console.warn(`warning: ${plugin} ${version} has no notes: the Unreleased section of ${changelog} is empty`);
  }
  // Only these files, whatever else is staged. A new CHANGELOG.md has to be
  // known to git before --only takes it.
  git('add', '--', changelog);
  git('commit', '--quiet', '--only', '-m', `chore: release ${plugin} ${version}`, '--', ...files, changelog);
  git('tag', '-a', tag, '-m', `${plugin} ${version}`);
  console.log(`committed and tagged ${tag}`);
}

if (withoutNotes.length) {
  console.warn(`\nReleased without notes: ${withoutNotes.join(', ')}. Next time run`);
  console.warn(`npm run changelog -- ${withoutNotes.join(' ')} first and edit the draft.`);
}
console.log('\nNothing is pushed yet. Push the commits first, then each tag on its own');
console.log('(GitHub starts no workflow for tags pushed more than three at a time):\n');
console.log(`  git push origin ${branch === 'HEAD' ? '<branch>' : branch}`);
for (const { tag } of releases) console.log(`  git push origin ${tag}`);
if (branch !== 'main') {
  console.log(`\nYou are on ${branch}. The publish workflow only takes tags on commits that are on main,`);
  console.log('so merge without squashing or rebasing, or tag again on main.');
}
