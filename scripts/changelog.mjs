#!/usr/bin/env node
// Draft the Unreleased section of a plugin's CHANGELOG.md from its commits.
//
//   npm run changelog -- smime
//   npm run changelog -- smime gravatar
//   npm run changelog -- smime --no-thanks   no GitHub lookups
//
// Takes the commits under <plugin>/ since its last release (the newest
// <plugin>@<version> tag, or the commit that last changed the manifest's
// version), leaves out merges and chore, test, ci, docs, style and build
// commits, and sorts the rest under Breaking, Security, Added, Changed and
// Fixed. With the GitHub CLI signed in, a commit from a pull request gets its
// number, and one from outside the team thanks its author. Entries already in the
// section are not added again, so it can run again after more commits.
// Nothing is committed: edit the draft, then `npm run release`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addToUnreleased, groupCommits, sectionBody } from './changelog-lib.mjs';
import { compareVersions } from './check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

function manifestVersion(rev, plugin) {
  try {
    const text = execFileSync('git', ['show', `${rev}:${plugin}/manifest.json`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(text).version ?? null;
  } catch {
    return null;
  }
}

/** Where the plugin's last release is: a tag, a commit, or null for "from the start". */
function lastRelease(plugin) {
  const tags = git('tag', '--list', `${plugin}@*`, '--merged', 'HEAD').split('\n').filter(Boolean);
  const versionOf = (t) => t.slice(plugin.length + 1);
  tags.sort((a, b) => compareVersions(versionOf(b), versionOf(a))
    || Number(versionOf(a).includes('-')) - Number(versionOf(b).includes('-')));
  if (tags.length) return tags[0];
  // Versions from before the tags: the newest commit that changed "version".
  const shas = git('log', '--format=%H', '-G', '"version"', '--', `${plugin}/manifest.json`).split('\n').filter(Boolean);
  for (const sha of shas) {
    const after = manifestVersion(sha, plugin);
    if (after && after !== manifestVersion(`${sha}^`, plugin)) return sha;
  }
  return null;
}

function commitsSince(base, plugin) {
  const out = git('log', '--no-merges', '--reverse', '--format=%H%x1f%s%x1f%b%x1e', ...(base ? [`${base}..HEAD`] : ['HEAD']), '--', `${plugin}/`);
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, subject, body = ''] = r.split('\x1f');
    return { sha, subject, body };
  });
}

function githubRepo() {
  try {
    const url = git('remote', 'get-url', 'origin');
    return url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The merged pull request a commit came in with: its number, and its author when they are not on the team. */
function pullRequest(repo, sha) {
  try {
    const prs = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/commits/${sha}/pulls`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const pr = prs.find((p) => p.merged_at);
    if (!pr) return {};
    const outside = !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pr.author_association);
    const login = pr.user?.login;
    return { pr: pr.number, thanks: outside && login && !login.endsWith('[bot]') ? login : undefined };
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const thanks = !args.includes('--no-thanks');
  const plugins = args.filter((a) => !a.startsWith('--'));
  if (!plugins.length) {
    console.error('usage: npm run changelog -- <plugin> [<plugin> ...] [--no-thanks]');
    process.exit(1);
  }
  const repo = thanks ? githubRepo() : null;
  let lookups = !!repo;

  for (const plugin of plugins) {
    if (!existsSync(path.join(ROOT, plugin, 'manifest.json'))) {
      console.error(`${plugin}: there is no ${plugin}/manifest.json`);
      process.exitCode = 1;
      continue;
    }
    const base = lastRelease(plugin);
    const commits = commitsSince(base, plugin);
    if (lookups) {
      for (const c of commits) {
        const found = pullRequest(repo, c.sha);
        // gh missing or not signed in: don't try again for every commit.
        if (found === null) { lookups = false; break; }
        Object.assign(c, found);
      }
    }
    const groups = groupCommits(commits);
    const file = path.join(ROOT, plugin, 'CHANGELOG.md');
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const after = addToUnreleased(before, groups);
    const since = base ? (base.includes('@') ? base : `commit ${base.slice(0, 9)}`) : 'the first commit';
    if (after === before) {
      console.log(`${plugin}: nothing new since ${since}`);
      continue;
    }
    writeFileSync(file, after);
    const bullets = (t) => (sectionBody(t, 'unreleased') ?? '').split('\n').filter((l) => /^\s*[-*]\s/.test(l)).length;
    const count = bullets(after) - bullets(before);
    console.log(`${plugin}: ${count} entr${count === 1 ? 'y' : 'ies'} from ${commits.length} commit${commits.length === 1 ? '' : 's'} since ${since} in ${plugin}/CHANGELOG.md`);
  }
  console.log('\nEdit the drafts, then run npm run release.');
}

main();
