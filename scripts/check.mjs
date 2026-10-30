#!/usr/bin/env node
// Check the plugins before they go to the extension directory.
//
//   node scripts/check.mjs                  every plugin folder
//   node scripts/check.mjs smime gravatar   some plugins
//   node scripts/check.mjs --tag smime@1.3.1
//                                           a release tag: the plugin must be
//                                           in publish.json and its manifest
//                                           must have that version
//
// A published plugin without a CHANGELOG.md, and a tag whose version has no
// notes in it, get a warning; warnings never fail the check.
//
// publish.json lists the plugins the publish workflow sends to the
// directory ("publish") and the ones it never sends ("skip", with the
// reason). Every plugin folder has to be in one of the two.
//
// The directory builds a plugin from its folder alone: it runs
// `npm ci --ignore-scripts` (npm install without a lockfile) and
// `npm run build`, and takes the entrypoint from dist/, build/ or the folder.
// Without a build script it packs the folder as it is, and refuses a plugin
// whose entrypoint is only in dist/, build/ or a prebuilt <id>.zip.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasNotes, sectionBody } from './changelog-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const APP_VERSION = /^\d+\.\d+\.\d+$/;

// Webmail 1.15.0 brought the UI kit, the composer API and most slots and
// permissions; an older webmail installs such a plugin and then breaks.
const KIT_VERSION = '1.15.0';
const KIT_PERMISSIONS = ['compose:open', 'compose:read', 'compose:write', 'http:proxy', 'ui:app-page',
  'ui:commands', 'ui:contacts', 'ui:files', 'ui:message-list', 'ui:notifications', 'ui:tasks'];
const KIT_CODE = [
  [/['"]@plugin-host\/ui['"]/, 'imports @plugin-host/ui'],
  [/\bcomposer\s*\.\s*(getBody|getSelection|replaceSelection|replaceBody|attach)\b/, 'uses api.composer'],
  [/\bui\s*\.\s*(setActions|setPages|setSectionTitle|setDayLabels|refreshRowBadges)\b/, 'uses api.ui.$1'],
  [/\bproxy\s*\.\s*(fetch|connect|accounts|disconnect)\b/, 'uses api.proxy'],
  [/\bnotifications\s*\.\s*show\b/, 'uses api.notifications'],
];

export function readList() {
  const list = JSON.parse(readFileSync(path.join(ROOT, 'publish.json'), 'utf8'));
  return { publish: list.publish ?? [], skip: list.skip ?? {} };
}

export function compareVersions(a, b) {
  const pa = a.split(/[-+]/)[0].split('.').map(Number);
  const pb = b.split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function pluginFolders() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(ROOT, d.name, 'manifest.json')))
    .map((d) => d.name)
    .sort();
}

/** Files git would put in the source archive (tracked and new, not ignored), relative to the plugin. */
function sourceFiles(dir) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', dir],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').filter(Boolean)
      .filter((f) => existsSync(path.join(ROOT, f)))
      .map((f) => f.slice(dir.length + 1));
  } catch {
    const files = [];
    const walk = (rel) => {
      for (const e of readdirSync(path.join(ROOT, dir, rel), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else files.push(r);
      }
    };
    walk('');
    return files;
  }
}

function readJson(file, add, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    add(label, `${label} is not valid JSON: ${err.message}`);
    return null;
  }
}

function sameDeps(a = {}, b = {}) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** Problems with one publishable plugin as { where, message }; empty when it is fine. */
export function checkPlugin(dir) {
  const errors = [];
  const add = (file, message) => errors.push({ where: file ? `${dir}/${file}` : dir, message });
  const base = path.join(ROOT, dir);
  const manifest = readJson(path.join(base, 'manifest.json'), add, 'manifest.json');
  if (!manifest) return errors;

  if (manifest.id !== dir) add('manifest.json', `manifest.json id is "${manifest.id}", but the folder is "${dir}"; the directory matches the two`);
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    add('manifest.json', `manifest.json version "${manifest.version}" is not a semver version like 1.2.3`);
  }
  if (typeof manifest.minAppVersion !== 'string' || !manifest.minAppVersion) {
    add('manifest.json', 'manifest.json has no minAppVersion; set the oldest webmail the plugin works with');
  } else if (!APP_VERSION.test(manifest.minAppVersion)) {
    add('manifest.json', `manifest.json minAppVersion "${manifest.minAppVersion}" must look like 1.2.3`);
  }

  const files = sourceFiles(dir);
  const pkgPath = path.join(base, 'package.json');
  const pkg = existsSync(pkgPath) ? readJson(pkgPath, add, 'package.json') : null;
  const build = typeof pkg?.scripts?.build === 'string' && pkg.scripts.build.trim() ? pkg.scripts.build : null;

  if (pkg) {
    if (pkg.version !== undefined && pkg.version !== manifest.version) {
      add('package.json', `package.json version ${pkg.version} differs from manifest.json version ${manifest.version}`);
    }
    if (build && /(^|[\s"'=:(])\.\.[\\/]/.test(build)) {
      add('package.json', `the build script reaches outside the plugin folder ("${build}"); the directory only has the folder`);
    }
    const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
    const lockPath = path.join(base, 'package-lock.json');
    if (hasDeps && !existsSync(lockPath)) {
      add('package.json', 'package.json has dependencies but there is no package-lock.json; the directory would install whatever is newest');
    } else if (existsSync(lockPath)) {
      const lock = readJson(lockPath, add, 'package-lock.json');
      const root = lock?.packages?.[''];
      if (lock && !root) add('package-lock.json', 'package-lock.json has no root package; run npm install');
      if (root && (!sameDeps(root.dependencies, pkg.dependencies) || !sameDeps(root.devDependencies, pkg.devDependencies))) {
        add('package-lock.json', 'package-lock.json does not match the dependencies in package.json; npm ci would fail, run npm install');
      }
      if (root && pkg.version !== undefined && (lock.version !== pkg.version || root.version !== pkg.version)) {
        add('package-lock.json', `package-lock.json says version ${lock.version}, package.json ${pkg.version}; run npm install`);
      }
      // The directory's build VM reaches only the npm registry: no git, no GitHub.
      for (const [name, entry] of Object.entries(lock?.packages ?? {})) {
        if (name && entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/')) {
          add('package-lock.json', `${name.replace(/^.*node_modules\//, '')} comes from ${entry.resolved}; the directory only installs from registry.npmjs.org (pin it with "overrides")`);
        }
      }
    }
  }

  const entry = typeof manifest.entrypoint === 'string' && manifest.entrypoint
    ? manifest.entrypoint.replace(/^\.?\//, '') : 'index.js';
  const builtOutput = files.filter((f) => f.startsWith('dist/') || f.startsWith('build/'));
  if (builtOutput.length) {
    add('', `${builtOutput[0]}${builtOutput.length > 1 ? ` and ${builtOutput.length - 1} more` : ''} is committed build output; the directory builds the plugin itself`);
  }
  if (!build && !files.includes(entry)) {
    const prebuilt = files.includes(`${dir}.zip`) ? `${dir}.zip` : builtOutput.length ? 'dist/ or build/' : null;
    add('package.json', prebuilt
      ? `${entry} is only in ${prebuilt}, which the directory refuses; add a "build" script to package.json`
      : `${entry} is missing and there is no build script in package.json`);
  }

  const src = path.join(base, 'src');
  if (existsSync(src) && statSync(src).isDirectory() && !(manifest.minAppVersion && APP_VERSION.test(manifest.minAppVersion)
    && compareVersions(manifest.minAppVersion, KIT_VERSION) >= 0)) {
    const code = files.filter((f) => f.startsWith('src/') && /\.(m?[jt]sx?)$/.test(f))
      .map((f) => readFileSync(path.join(base, f), 'utf8')).join('\n');
    const reasons = [];
    for (const [re, why] of KIT_CODE) {
      const m = code.match(re);
      if (m) reasons.push(why.replace('$1', m[1] ?? ''));
    }
    const perms = (manifest.permissions ?? []).filter((p) => KIT_PERMISSIONS.includes(p));
    if (perms.length) reasons.push(`asks for ${perms.join(', ')}`);
    if (reasons.length) {
      add('manifest.json', `minAppVersion is ${manifest.minAppVersion ?? 'not set'}, but the plugin ${reasons.join(', ')}, which needs webmail ${KIT_VERSION}`);
    }
  }
  return errors;
}

/**
 * Warnings about a published plugin's CHANGELOG.md as { where, message }:
 * there is none, or (with a version) it has no notes for that version.
 */
export function checkChangelog(dir, version) {
  const file = path.join(ROOT, dir, 'CHANGELOG.md');
  const where = `${dir}/CHANGELOG.md`;
  if (!existsSync(file)) {
    return [{ where, message: `there is no CHANGELOG.md; run npm run changelog -- ${dir} before the next release` }];
  }
  if (version && !hasNotes(sectionBody(readFileSync(file, 'utf8'), version))) {
    return [{ where, message: `${version} has no notes in CHANGELOG.md, so the directory shows it without a changelog` }];
  }
  return [];
}

/** Problems with publish.json itself and the folders it does or doesn't name. */
export function checkList(folders) {
  const errors = [];
  const { publish, skip } = readList();
  const all = new Set(pluginFolders());
  for (const name of publish) {
    if (!all.has(name)) errors.push(`publish.json lists "${name}" to publish, but there is no ${name}/manifest.json`);
    if (name in skip) errors.push(`publish.json lists "${name}" both to publish and to skip`);
  }
  for (const name of Object.keys(skip)) {
    if (!all.has(name)) errors.push(`publish.json lists "${name}" to skip, but there is no ${name}/manifest.json`);
  }
  for (const name of folders) {
    if (!publish.includes(name) && !(name in skip)) {
      errors.push(`${name}: add it to publish.json, under "publish" or under "skip" with the reason`);
    }
  }
  return errors;
}

/** `<plugin>@<version>` → its parts, or an error. */
export function parseTag(tag) {
  const at = tag.lastIndexOf('@');
  if (at <= 0) return { error: `"${tag}" is not a release tag; use <plugin>@<version>, for example smime@1.3.1` };
  return { plugin: tag.slice(0, at), version: tag.slice(at + 1) };
}

function report(problems, level = 'error') {
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  for (const { where, message } of problems) {
    if (annotate) console.log(`::${level} file=${where}::${message.replace(/\r?\n/g, ' ')}`);
    else console.error(`${level === 'warning' ? 'warning: ' : ''}${where}: ${message}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const problems = [];
  const warnings = [];
  let tagVersion = null;
  const tagAt = args.indexOf('--tag');
  let wanted = args.filter((a, i) => !a.startsWith('--') && i !== tagAt + 1);

  if (tagAt !== -1) {
    const tag = args[tagAt + 1] ?? '';
    const parsed = parseTag(tag);
    if (parsed.error) {
      report([{ where: 'publish.json', message: parsed.error }]);
      process.exit(1);
    }
    const { publish } = readList();
    if (!publish.includes(parsed.plugin)) {
      report([{ where: 'publish.json', message: `"${parsed.plugin}" is not in the publish list of publish.json, so ${tag} is not published` }]);
      process.exit(1);
    }
    const manifest = JSON.parse(readFileSync(path.join(ROOT, parsed.plugin, 'manifest.json'), 'utf8'));
    if (manifest.version !== parsed.version) {
      problems.push({ where: `${parsed.plugin}/manifest.json`, message: `the tag says ${parsed.version}, but manifest.json says ${manifest.version}` });
    }
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `plugin=${parsed.plugin}\nversion=${parsed.version}\n`);
    }
    wanted = [parsed.plugin];
    tagVersion = parsed.version;
  }

  const folders = pluginFolders();
  for (const name of wanted) {
    if (!folders.includes(name)) problems.push({ where: name, message: `there is no ${name}/manifest.json` });
  }
  const dirs = wanted.length ? wanted.filter((n) => folders.includes(n)) : folders;
  for (const message of checkList(dirs)) problems.push({ where: 'publish.json', message });
  const { publish } = readList();
  for (const dir of dirs.filter((d) => publish.includes(d))) {
    problems.push(...checkPlugin(dir));
    warnings.push(...checkChangelog(dir, tagVersion));
  }

  report(warnings, 'warning');
  report(problems);
  if (problems.length) {
    console.error(`${problems.length} problem${problems.length === 1 ? '' : 's'} found`);
    process.exit(1);
  }
  console.log(`checked ${dirs.length} plugin${dirs.length === 1 ? '' : 's'}: ok`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
