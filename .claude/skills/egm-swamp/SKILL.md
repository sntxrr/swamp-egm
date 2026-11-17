---
name: egm-swamp
license: Apache-2.0
description: >-
  Run Elephant-Goldfish Model (EGM, egm.dev) design-document reviews, drift
  reports and finding resolution as swamp workflows with the @sntxrr/egm
  extension: @sntxrr/egm-review (isolated Goldfish reviewer personas, stages
  5-9, consolidated report), @sntxrr/egm-drift-report (design docs vs current
  code, scheduled new-drift alerting) and @sntxrr/egm-resolve (categorize
  findings, approve, apply edits). Triggers on "egm", "goldfish review",
  "elephant goldfish", "review this design doc", "drift report", "doc drift",
  "resolve review findings", "@sntxrr/egm".
---

# @sntxrr/egm

Three workflows. Every model call goes through the local `claude` CLI login
(no API key) via `@keeb/anthropic/claude`'s `cli_generate_many_tools`. Each
reviewer is a fresh session that sees only its prompt. Tool-less reviewers run
in an empty temp directory; the few that need code (zoom-out,
codebase-details, drift, resolve) get only `Read`, `Grep` and `Glob`, confined
to the repo by `--restricted`.

## Review a design document

```bash
swamp workflow run @sntxrr/egm-review \
  --input targetFile=docs/design.md \
  --input workingDirectory=/path/to/repo \
  --input outputDir=egm-review
```

- `preset`: `uninterrupted` (stages 5-9, default), `feature_spec` (5-8, whole
  document), `implementation` (9 only). `stages` overrides it.
- The split is the first `## Detailed Implementation Plan` (or `Implementation
  Plan`, `Work Breakdown`, `Implementation Steps`) outside code fences. With
  several, pass `splitLine`. With none, stage 9 is dropped with a warning.
- In-tree links in the document become context automatically; URLs and links
  outside `workingDirectory` are excluded unless listed in
  `approvedExternalLinks`. Stage 6 (comprehension) never gets context.
- Outputs in `outputDir`: `zoom_out_report.md`, `comprehension_report.md`,
  `critic_report.md`, `intermediate_zoom_out_report.md`,
  `implementation_readiness_report.md`, `consolidated_review_report.md`.

Read the outcome:

```bash
swamp data query 'model("egm-doc") && name == "reports"' --select attributes
```

A reviewer that fails twice is reported `not run`, never as zero findings.
Raw findings the synthesizer did not map are listed under "Untraced findings"
and fail the last (allowFailure) assert, so nothing is dropped silently.

## Resolve the findings

```bash
swamp workflow run @sntxrr/egm-resolve --input targetFile=docs/design.md \
  --input workingDirectory=/path/to/repo --input artifactDir=egm-review
```

It stops at the `approve-fixes` gate after writing
`goldfish_review_report.md`. Read it; ESCALATE items need facts only a person
has. Untick `[x] apply` on edits you do not want, then:

```bash
swamp workflow approve @sntxrr/egm-resolve approve-fixes   # apply ticked edits (backup kept)
swamp workflow reject  @sntxrr/egm-resolve approve-fixes --reason "no changes"
```

A CONTEST whose evidence file does not exist is demoted to ESCALATE. Apply
refuses if the document changed after categorization; re-run instead.

## Drift report

```bash
swamp workflow run @sntxrr/egm-drift-report \
  --input repoRoot=/path/to/repo --input docsDir=docs \
  --input failOnNewDrift=true
```

Writes `<repoRoot>/<YYYY-MM-DD>_DRIFT_REPORT.md` in upstream's strict format
(`## <doc>` then bullets or `No drift detected.`). With `failOnNewDrift`, the
run fails when any document's drift count rose since the previous run, which
suits a scheduled trigger.

## Cost and models

Defaults are `model=claude-opus-5-5`, `effort=high`. A full review is about 10
reviewer sessions plus one synthesizer call; `instancesPerReviewer=2` doubles
the reviewers. Use `model=claude-haiku-5-5 effort=low` for a cheap smoke run.
