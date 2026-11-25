// Copyright (c) 2026 Joseba Egia
// SPDX-License-Identifier: MIT

/**
 * Fails if any commit in a range doesn't follow Conventional Commits. The
 * changelog is generated from commit messages and pull requests are merged
 * with a merge commit, so a commit that isn't conventional would silently be
 * left out of the changelog, its author's credit included.
 *
 *   node scripts/check-commits.mjs origin/main..HEAD
 *
 * Run by the `commit-messages` job in .github/workflows/ci.yml.
 * See docs-site/development/versioning.md.
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The types cliff.toml sorts into changelog sections.
export const CONVENTIONAL = /^(feat|fix|perf|refactor|docs|chore|build|ci|test|style|revert)(\([^)]+\))?!?: \S/

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const range = process.argv[2]
  if (!range) {
    console.error('Usage: node scripts/check-commits.mjs <base>..<head>')
    process.exit(1)
  }
  const log = execFileSync('git', ['log', '--no-merges', '--format=%h %s', range], { encoding: 'utf8' }).trim()
  const bad = log ? log.split('\n').filter((line) => !CONVENTIONAL.test(line.slice(line.indexOf(' ') + 1))) : []
  if (bad.length) {
    console.error(`These commits don't follow Conventional Commits, so they would be missing from the changelog:\n`)
    for (const line of bad) console.error(`  ${line}`)
    console.error(
      '\nReword them (for example `git rebase -i origin/main`, then `reword`) as\n' +
      '"feat: …", "fix(scope): …", "docs: …" and so on, and force-push the branch.\n' +
      'See https://yayitazale.github.io/eink-hub/development/versioning'
    )
    process.exit(1)
  }
  console.log(`All ${log ? log.split('\n').length : 0} commit(s) follow Conventional Commits.`)
}
