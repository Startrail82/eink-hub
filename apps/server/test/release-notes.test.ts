import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS release tooling, no type declarations
import { changelogSection, releaseNotes } from '../../../scripts/release-notes.mjs';

const changelog = [
  '# Changelog',
  '',
  'Intro.',
  '',
  '## [0.5.0] - 2026-10-22',
  '',
  '### Added',
  '',
  '- New thing',
  '',
  '## [0.4.0] - 2026-10-21',
  '',
  '### Fixed',
  '',
  '- Old bug',
  '',
].join('\r\n');

describe('release notes', () => {
  it('takes one version’s section, without its heading, CRLF or not', () => {
    expect(changelogSection(changelog, 'v0.5.0')).toBe('### Added\n\n- New thing');
    expect(changelogSection(changelog, '0.4.0')).toBe('### Fixed\n\n- Old bug');
    expect(changelogSection(changelog, 'v0.3.0')).toBeNull();
  });

  it('puts the image first and the section, then a link to the whole changelog', () => {
    expect(releaseNotes(changelog, 'v0.4.0')).toBe(
      'Image: `ghcr.io/yayitazale/eink-hub:v0.4.0`\n\n### Fixed\n\n- Old bug\n\n' +
        '[Full changelog](https://github.com/yayitazale/eink-hub/blob/v0.4.0/CHANGELOG.md)\n',
    );
    expect(releaseNotes(changelog, 'v0.3.0')).toContain('See [Full changelog]');
  });

  it('turns linked credits into plain @mentions for the Release page', () => {
    const credited = changelog.replace(
      '- New thing',
      '- New thing ([abcd1234](https://github.com/yayitazale/eink-hub/commit/abcd1234)) by [@some-one](https://github.com/some-one)\r\n\r\n' +
        '### New contributors\r\n\r\n' +
        '- [@some-one](https://github.com/some-one) made their first contribution in [#15](https://github.com/yayitazale/eink-hub/pull/15)',
    );
    const notes = releaseNotes(credited, 'v0.5.0');
    expect(notes).toContain('by @some-one\n');
    expect(notes).toContain('- @some-one made their first contribution in [#15](https://github.com/yayitazale/eink-hub/pull/15)');
    expect(notes).toContain('[abcd1234](https://github.com/yayitazale/eink-hub/commit/abcd1234)');
  });

  it('finds every released version in the real CHANGELOG.md', () => {
    const real = fs.readFileSync(path.resolve(import.meta.dirname, '../../../CHANGELOG.md'), 'utf8');
    const versions = [...real.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(changelogSection(real, `v${v}`), v).toMatch(/\S/);
  });
});
