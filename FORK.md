# Fork features (deploy branch)

The `deploy` branch of this fork combines the features below on top of the upstream release.
The version in the bottom left shows `FR<n>`: the highest feature number included.

| FR | Feature | Branch |
| --- | --- | --- |
| FR1 | Photo location in the Immich caption (merged upstream) | `feat/photo-location` |
| FR2 | AI image collections (OpenAI-compatible and ComfyUI) | `feat/ai-collections` |
| FR3 | Several schedules per Canvas, with a weekly overview (merged upstream) | `feat/multiple-schedules` |
| FR4 | Weather as a source, behind a provider interface | `feat/weather-source` |
| FR5 | Weather bar on weather pictures | `feat/ai-weather-bar` |
| FR6 | Weather of a later hour | `feat/ai-weather-offset` |
| FR7 | Negative prompt per ComfyUI collection | `feat/ai-negative-prompt` |
| FR8 | Random choices in prompts | `feat/ai-random-choice` |
| FR9 | Only pick pictures that suit the Canvas | `feat/match-orientation` |

When a feature is merged into `deploy`, raise `FORK_FEATURE` in `apps/web/src/lib/fork.ts`.
Changes are always made in the feature branch first and then merged into `deploy`, never directly in `deploy`.
