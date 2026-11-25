// Copyright (c) 2026 Joseba Egia
// SPDX-License-Identifier: MIT

/**
 * Prints the body of a GitHub release: the image to pull and that version's
 * section of CHANGELOG.md. Used by the `release` job in
 * .github/workflows/release.yml, and by hand to fill in older releases:
 *
 *   node scripts/release-notes.mjs v0.5.0 > notes.md
 *   gh release edit v0.5.0 --notes-file notes.md
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_URL = 'https://github.com/yayitazale/eink-hub'
const IMAGE = 'ghcr.io/yayitazale/eink-hub'

/** The section of `changelog` for `version` ("v1.2.3" or "1.2.3"), without its
 *  "## [x.y.z] - date" heading (the release is already titled with the tag);
 *  null if there is none. */
export function changelogSection(changelog, version) {
  const v = version.replace(/^v/, '')
  const lines = changelog.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => l.startsWith(`## [${v}]`))
  if (start === -1) return null
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['))
  const body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim()
  return body || null
}

/** CHANGELOG.md writes credits as [@user](https://github.com/user), since a
 *  bare @user isn't linked inside a file. On the Release page a plain @user is
 *  better: GitHub links it and lists the contributors with their avatars. */
export function plainMentions(markdown) {
  return markdown.replace(/\[@([A-Za-z0-9-]+)\]\(https:\/\/github\.com\/\1\)/g, '@$1')
}

export function releaseNotes(changelog, tag) {
  const raw = changelogSection(changelog, tag)
  const section = raw && plainMentions(raw)
  const link = `[Full changelog](${REPO_URL}/blob/${tag}/CHANGELOG.md)`
  return [
    `Image: \`${IMAGE}:${tag}\``,
    section ?? `See ${link}.`,
    ...(section ? [link] : []),
  ].join('\n\n') + '\n'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tag = process.argv[2]
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) {
    console.error('Usage: node scripts/release-notes.mjs vX.Y.Z')
    process.exit(1)
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  process.stdout.write(releaseNotes(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), tag))
}
