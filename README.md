# @sntxrr/egm

[Elephant-Goldfish Model](https://egm.dev) (EGM) design-document review for
swamp. EGM's idea: the author (the Elephant) knows too much to see what a
document leaves out, so fresh reviewers (Goldfish) who never saw the
conversation read only the written document and report what is missing or
unclear. This extension runs that process as swamp workflows, headless, with
structured findings you can query, report on and gate.

| Workflow | What it does |
| --- | --- |
| `@sntxrr/egm-review` | Stages 5-9 of upstream `egm-review`: zoom-out, inventive catalyst, comprehension, design/structural/style critics, a second zoom-out, implementation readiness and codebase details. One retry for failed reviewers, one synthesizer, per-stage reports and `consolidated_review_report.md` with a traceability matrix. |
| `@sntxrr/egm-drift-report` | Upstream `egm-drift-report`: each design doc or README checked against the current code, `{YYYY-MM-DD}_DRIFT_REPORT.md` in the strict format, per-doc counts, and `failOnNewDrift` for scheduled runs. |
| `@sntxrr/egm-resolve` | Upstream `egm-resolve`: categorize each finding CONTEST / ESCALATE / PROPOSE FIX / DECLINE, write `goldfish_review_report.md`, stop at one `manual_approval` gate, then apply the ticked edits with a backup. |

## Requirements

- Claude Code installed and logged in on the host that runs the steps. Every
  model call is `claude -p` under that login; no API key is read.
- `@keeb/anthropic` (declared as a dependency). This extension adds a
  `cli_generate_many_tools` method to its `@keeb/anthropic/claude` type.

## Isolation

Each reviewer is its own `claude -p` session with `--safe-mode`,
`--restricted`, `--strict-mcp-config` and `--no-session-persistence`, so no
CLAUDE.md, skill, plugin, hook or MCP server from the host reaches it, and it
never sees another reviewer's output.

- Tool-less reviewers (most personas, the synthesizer) run with `--tools ""`
  in an empty temp directory.
- Reviewers that must read code (zoom-out, codebase-details, every drift
  check, the resolve categorizer) get only `Read`, `Grep` and `Glob`, rooted
  at the repository; `--restricted` confines the file tools to it and removes
  every tool that runs commands or code.

## Quick start

```bash
swamp extension pull @sntxrr/egm

swamp workflow run @sntxrr/egm-review \
  --input targetFile=docs/design.md \
  --input workingDirectory=/path/to/repo \
  --input outputDir=egm-review

swamp data query 'model("egm-doc") && name == "reports"' --select attributes
```

Then, to act on the findings:

```bash
swamp workflow run @sntxrr/egm-resolve --input targetFile=docs/design.md \
  --input workingDirectory=/path/to/repo --input artifactDir=egm-review
# read egm-review/goldfish_review_report.md, untick edits you do not want
swamp workflow approve @sntxrr/egm-resolve approve-fixes
```

Drift, e.g. on a schedule:

```bash
swamp workflow run @sntxrr/egm-drift-report \
  --input repoRoot=/path/to/repo --input docsDir=docs --input failOnNewDrift=true
```

The first run is a baseline. After that, a document is new drift only when its
count rose by at least `minNewItems` (default 2) and the document or a source
file read for it changed, so the model's run-to-run wobble on unchanged code
doesn't fail the run.

## Behaviors

| Type | Methods | Data |
| --- | --- | --- |
| `@sntxrr/egm` | `prepare`, `collectFindings`, `writeReports` | `reviewPlan`, `findings`, `reports` |
| `@sntxrr/egm/drift` | `prepare`, `collectFindings`, `writeReport` | `plan`, `findings`, `report` |
| `@sntxrr/egm/resolve` | `prepare`, `writeReport`, `applyFixes` | `resolveRequest`, `resolution`, `applyResult` |
| `@keeb/anthropic/claude` (extended) | `cli_generate_many_tools` | `cliResult` |

## Differences from the upstream skills

- No interactive gates. Presets, stages, personas and the split line are
  inputs; resolve has one `manual_approval` gate.
- Stage 8 is a second independent zoom-out pass on the same document (nothing
  changes between stages in a headless run), not a read of the Stage 5 report.
- External links and URLs are excluded unless listed in
  `approvedExternalLinks` (upstream's headless rule).
- Upstream's `egm-review-loop` re-audit and the brainstorm, draft and
  bootstrap skills are not included.
- Rules upstream states in prose are enforced in code: a reviewer that fails
  twice is `not run`, never zero findings; untraced findings are listed; a
  CONTEST without an existing evidence file becomes ESCALATE; severities come
  from the reviewers, never the categorizer; edits apply only by exact unique
  match inside the line range; apply refuses if the document changed.

## Cost

Defaults are `model=claude-opus-5-5`, `effort=high`. A full review is about
10 reviewer sessions plus one synthesizer call, billed to the Claude Code
login. `model=claude-haiku-5-5 effort=low` makes a cheap smoke run.

## License

Apache-2.0. The persona prompts and document standards in `egm/prompts/` are
vendored unmodified from
[google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model);
see NOTICE. Not affiliated with or endorsed by Google.
