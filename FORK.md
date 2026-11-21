# Fork features (deploy branch)

The `deploy` branch of this fork combines the features below on top of the upstream release.
The version in the bottom left shows `FR<n>`: the highest feature number included.

| FR | Feature | Branch |
| --- | --- | --- |
| FR1 | Photo location in the Immich caption | `feat/photo-location` |
| FR2 | AI image collections (OpenAI-compatible and ComfyUI) | `feat/ai-collections` |
| FR3 | Several schedules per Canvas, with a weekly overview | `feat/multiple-schedules` |

When a feature is merged into `deploy`, raise `FORK_FEATURE` in `apps/web/src/lib/fork.ts`.
Changes are always made in the feature branch first and then merged into `deploy`, never directly in `deploy`.

## Migrations

Each feature branch adds its own migration after upstream's last one, so they collide in `db/index.ts`
when merged. In `deploy` they are renumbered in merge order:

- v12: photo location (columns on `images` and `assignments`)
- v13: several schedules (rebuilds `assignments`, so it must copy every column added before it, including v12's)

When a feature that changes `assignments` is added later, update the v13 rebuild or add a new migration after it.
