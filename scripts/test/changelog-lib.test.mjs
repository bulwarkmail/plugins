import { describe, expect, it } from 'vitest';
import {
  addToUnreleased, commitEntry, groupCommits, hasNotes, headingVersion, releaseUnreleased, sectionBody,
} from '../changelog-lib.mjs';

const LOG = `# Changelog

## Unreleased

## [2.0.0-beta.1] - 2026-10-01

- Beta

## v1.4.1 (2026-10-29)

### Fixed
- Sort the signed attributes.

\`\`\`
## 9.9.9 inside a code block
\`\`\`

## 1.4.0

- Older
`;

describe('headingVersion', () => {
  it('reads the heading styles authors use', () => {
    expect(headingVersion('1.4.1')).toBe('1.4.1');
    expect(headingVersion('1.4.1 (2026-10-29)')).toBe('1.4.1');
    expect(headingVersion('[1.4.1] - 2026-10-29')).toBe('1.4.1');
    expect(headingVersion('v1.4.1')).toBe('1.4.1');
    expect(headingVersion('2.0.0-beta.1')).toBe('2.0.0-beta.1');
    expect(headingVersion('[Unreleased]')).toBe('unreleased');
  });

  it('does not take other headings or longer numbers for a version', () => {
    expect(headingVersion('Notes')).toBeNull();
    expect(headingVersion('1.4.10')).toBe('1.4.10');
    expect(headingVersion('1.4.1x')).toBeNull();
  });
});

describe('sectionBody', () => {
  it('returns one version up to the next section, code blocks included', () => {
    expect(sectionBody(LOG, '1.4.1')).toBe('### Fixed\n- Sort the signed attributes.\n\n```\n## 9.9.9 inside a code block\n```');
    expect(sectionBody(LOG, '2.0.0-beta.1')).toBe('- Beta');
    expect(sectionBody(LOG, '1.4.0')).toBe('- Older');
  });

  it('is null for a version that is not there, also one only inside a code block', () => {
    expect(sectionBody(LOG, '1.4.2')).toBeNull();
    expect(sectionBody(LOG, '9.9.9')).toBeNull();
    expect(sectionBody(LOG, '1.4')).toBeNull();
  });

  it('reads CRLF files', () => {
    expect(sectionBody(LOG.replace(/\n/g, '\r\n'), '1.4.0')).toBe('- Older');
  });
});

describe('hasNotes', () => {
  it('needs more than headings', () => {
    expect(hasNotes('')).toBe(false);
    expect(hasNotes(null)).toBe(false);
    expect(hasNotes('### Fixed\n\n')).toBe(false);
    expect(hasNotes('### Fixed\n- One')).toBe(true);
  });
});

describe('commitEntry', () => {
  it('sorts conventional commits into groups and drops the noise', () => {
    expect(commitEntry({ subject: 'feat: show the agenda' })).toEqual({ group: 'Added', text: 'Show the agenda' });
    expect(commitEntry({ subject: 'fix(smime): keep the header' })).toEqual({ group: 'Fixed', text: 'Keep the header' });
    expect(commitEntry({ subject: 'refactor: split the parser' })).toEqual({ group: 'Changed', text: 'Split the parser' });
    expect(commitEntry({ subject: 'feat!: drop the old settings' }).group).toBe('Breaking');
    expect(commitEntry({ subject: 'feat: new store', body: 'BREAKING CHANGE: settings move' }).group).toBe('Breaking');
    expect(commitEntry({ subject: 'fix: escape names (GHSA-9mvj-4h5q-x2rf)' }).group).toBe('Security');
    expect(commitEntry({ subject: 'Fix typos in manifest.json' })).toEqual({ group: 'Changed', text: 'Fix typos in manifest.json' });
    for (const t of ['chore', 'test', 'ci', 'docs', 'style', 'build']) expect(commitEntry({ subject: `${t}: x` })).toBeNull();
  });
});

describe('groupCommits', () => {
  it('adds the pull request and thanks, once per entry', () => {
    expect(groupCommits([
      { subject: 'fix: keep the header', pr: 31, thanks: 'kah-ja' },
      { subject: 'fix: keep the header', pr: 31, thanks: 'kah-ja' },
      { subject: 'fix: sort dates #12', pr: 12 },
      { subject: 'test: more' },
    ])).toEqual({ Fixed: ['Keep the header #31 (thanks @kah-ja)', 'Sort dates #12'] });
  });
});

describe('addToUnreleased', () => {
  it('starts a file when there is none', () => {
    expect(addToUnreleased('', { Fixed: ['One'] })).toBe('# Changelog\n\n## Unreleased\n\n### Fixed\n- One\n');
  });

  it('adds groups in their order above the released versions, skipping entries already there', () => {
    const start = '# Changelog\n\n## Unreleased\n\nIntro line.\n\n### Fixed\n- One\n\n### Notes\n- Mine\n\n## 1.0.0\n\n- First\n';
    const out = addToUnreleased(start, { Fixed: ['one', 'Two'], Added: ['New'], Breaking: ['Gone'] });
    expect(out).toBe('# Changelog\n\n## Unreleased\n\nIntro line.\n\n### Breaking\n- Gone\n\n### Added\n- New\n\n### Fixed\n- One\n- Two\n\n### Notes\n- Mine\n\n## 1.0.0\n\n- First\n');
    expect(addToUnreleased(out, { Fixed: ['Two'] })).toBe(out);
  });

  it('puts an Unreleased section above the newest version when it is missing', () => {
    expect(addToUnreleased('# Changelog\n\n## 1.0.0\n\n- First\n', { Added: ['New'] }))
      .toBe('# Changelog\n\n## Unreleased\n\n### Added\n- New\n\n## 1.0.0\n\n- First\n');
  });

  it('keeps CRLF line ends', () => {
    const out = addToUnreleased('# Changelog\r\n\r\n## Unreleased\r\n', { Fixed: ['One'] });
    expect(out).toBe('# Changelog\r\n\r\n## Unreleased\r\n\r\n### Fixed\r\n- One\r\n');
  });
});

describe('releaseUnreleased', () => {
  it('names the notes with the version and starts an empty Unreleased', () => {
    const out = releaseUnreleased('# Changelog\n\n## Unreleased\n\n### Fixed\n- One\n\n## 1.0.0\n', '1.0.1', '2026-10-30');
    expect(out).toEqual({ released: true, text: '# Changelog\n\n## Unreleased\n\n## 1.0.1 (2026-10-30)\n\n### Fixed\n- One\n\n## 1.0.0\n' });
    expect(sectionBody(out.text, '1.0.1')).toBe('### Fixed\n- One');
    expect(hasNotes(sectionBody(out.text, 'unreleased'))).toBe(false);
  });

  it('changes nothing without notes', () => {
    const text = '# Changelog\n\n## Unreleased\n\n### Fixed\n\n## 1.0.0\n';
    expect(releaseUnreleased(text, '1.0.1', '2026-10-30')).toEqual({ released: false, text });
  });
});
