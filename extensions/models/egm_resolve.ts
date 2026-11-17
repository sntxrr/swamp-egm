/**
 * EGM resolve as a swamp behavior: the "Elephant" half of a Goldfish review.
 *
 * `prepare` loads the target document and the findings (from an `@sntxrr/egm`
 * review instance or a JSON file) and builds one categorization request. That
 * request runs through `@keeb/anthropic/claude`'s `cli_generate_many_tools`
 * with read-only tools, so a CONTEST can cite real files and symbols.
 * `writeReport` validates the answer, enforces upstream's rules in code (a
 * contest needs checkable evidence; severities never change), checks every
 * proposed edit applies uniquely, and writes goldfish_review_report.md with an
 * `[x] apply` checkbox per edit. After a human approves (the workflow's
 * manual_approval gate), `applyFixes` backs the document up and applies only
 * the edits still ticked, by exact unique-string replacement. It refuses to
 * run if the document changed since categorization.
 *
 * Upstream: https://github.com/google/elephant-goldfish-model (Apache-2.0).
 *
 * @module
 */
import { z } from "npm:zod@4";
import { READONLY_TOOLS } from "./egm_claude_tools.ts";
import { numberLines, type Range, SEVERITY_ORDER } from "./egm_lib.ts";

// ---------------------------------------------------------------- schemas

const GlobalArgsSchema = z.object({
  workingDirectory: z.string().optional().describe(
    "Repository root the categorizer may read (read-only) for CONTEST evidence. Defaults to the swamp repo root.",
  ),
  artifactDir: z.string().optional().describe(
    "Where goldfish_review_report.md and document backups go. Defaults to workingDirectory.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Resolution categories, from upstream egm-resolve step 2. */
export const CATEGORIES = [
  "CONTEST",
  "ESCALATE",
  "PROPOSE FIX",
  "DECLINE",
] as const;

type Category = typeof CATEGORIES[number];

const InFindingSchema = z.object({
  findingId: z.string(),
  reviewerPersona: z.string(),
  severity: z.enum(["Blocker", "Major", "Nit"]),
  title: z.string(),
  scope: z.string(),
  description: z.string(),
  rationale: z.string(),
});

type InFinding = z.infer<typeof InFindingSchema>;

const EditSchema = z.object({
  location: z.string(),
  oldText: z.string().min(1),
  newText: z.string(),
});

const AnswerItemSchema = z.object({
  findingId: z.string(),
  category: z.enum(CATEGORIES),
  justification: z.string().min(1),
  evidence: z.object({
    file: z.string(),
    symbol: z.string().optional(),
    detail: z.string().optional(),
  }).nullable().optional(),
  edits: z.array(EditSchema).default([]),
  coveredBy: z.string().optional(),
});

/** The categorizer's answer. */
export const AnswerSchema = z.object({ items: z.array(AnswerItemSchema) });

const ANSWER_JSON: Record<string, unknown> = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          findingId: { type: "string" },
          category: { type: "string", enum: [...CATEGORIES] },
          justification: { type: "string" },
          evidence: {
            type: "object",
            properties: {
              file: { type: "string" },
              symbol: { type: "string" },
              detail: { type: "string" },
            },
            required: ["file"],
          },
          coveredBy: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                location: { type: "string" },
                oldText: { type: "string" },
                newText: { type: "string" },
              },
              required: ["location", "oldText", "newText"],
            },
          },
        },
        required: ["findingId", "category", "justification", "edits"],
      },
    },
  },
  required: ["items"],
};

const ResolveRequestSchema = z.object({
  batch: z.string(),
  targetFile: z.string(),
  targetDisplay: z.string(),
  workingDirectory: z.string(),
  artifactDir: z.string(),
  lineRange: z.string(),
  range: z.object({ start: z.number(), end: z.number() }),
  documentSha256: z.string(),
  findings: z.array(InFindingSchema),
  findingCount: z.number(),
  sourceOfFindings: z.enum(["file", "egm"]),
  requests: z.array(z.object({
    key: z.string(),
    prompt: z.string(),
    jsonSchema: z.record(z.string(), z.unknown()),
    tools: z.array(z.string()),
  })),
  timestamp: z.string(),
});

type ResolveRequest = z.infer<typeof ResolveRequestSchema>;

const Applicability = z.enum([
  "unique",
  "missing",
  "ambiguous",
  "outOfRange",
  "overlaps",
]);

const ResolutionItemSchema = z.object({
  findingId: z.string(),
  reviewerPersona: z.string(),
  severity: z.enum(["Blocker", "Major", "Nit"]),
  title: z.string(),
  scope: z.string(),
  description: z.string(),
  rationale: z.string(),
  category: z.enum(CATEGORIES),
  justification: z.string(),
  evidence: z.string().optional(),
  demotedFromContest: z.boolean(),
  coveredBy: z.string().optional(),
  edits: z.array(z.object({
    editId: z.string(),
    location: z.string(),
    oldText: z.string(),
    newText: z.string(),
    applicability: Applicability,
  })),
});

type ResolutionItem = z.infer<typeof ResolutionItemSchema>;

const ResolutionSchema = z.object({
  batch: z.string(),
  reportPath: z.string(),
  documentSha256: z.string(),
  items: z.array(ResolutionItemSchema),
  counts: z.object({
    contest: z.number(),
    escalate: z.number(),
    proposeFix: z.number(),
    decline: z.number(),
  }),
  proposedEditCount: z.number(),
  applicableEditCount: z.number(),
  missingFindingIds: z.array(z.string()),
  duplicateFindingIds: z.array(z.string()),
  unknownFindingIds: z.array(z.string()),
  allClassified: z.boolean(),
  escalated: z.array(z.string()),
  timestamp: z.string(),
});

type Resolution = z.infer<typeof ResolutionSchema>;

const ApplyResultSchema = z.object({
  batch: z.string(),
  backupPath: z.string().nullable(),
  documentShaBefore: z.string(),
  documentShaAfter: z.string(),
  changed: z.boolean(),
  applied: z.array(z.object({ editId: z.string(), findingId: z.string() })),
  skipped: z.array(z.object({
    editId: z.string(),
    findingId: z.string(),
    reason: z.string(),
  })),
  appliedCount: z.number(),
  skippedCount: z.number(),
  markdownValid: z.boolean(),
  markdownIssues: z.array(z.string()),
  reportPath: z.string(),
  handoff: z.object({
    acceptedFixes: z.number(),
    contested: z.number(),
    escalated: z.number(),
    declined: z.number(),
    remainingUnaddressed: z.number(),
  }),
  timestamp: z.string(),
});

// ---------------------------------------------------------------- context

interface DataRecord {
  name: string;
  attributes: Record<string, unknown>;
}

interface Ctx {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, args?: unknown) => void;
    warning: (msg: string, args?: unknown) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
  readModelData?: (model: string, spec?: string) => Promise<DataRecord[]>;
}

// ---------------------------------------------------------------- helpers

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function resolvePath(base: string, p: string): string {
  return p.startsWith("/") ? p : `${base.replace(/\/$/, "")}/${p}`;
}

function relTo(root: string, p: string): string {
  const r = root.endsWith("/") ? root : `${root}/`;
  return p.startsWith(r) ? p.slice(r.length) : p;
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Parses "full file" or "N-M" (1-based, inclusive). Exported for tests. */
export function parseLineRange(spec: string, total: number): Range {
  if (/^\s*full\s*file\s*$/i.test(spec)) return { start: 1, end: total };
  const m = spec.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!m) {
    throw new Error(`lineRange must be "full file" or "N-M", got "${spec}"`);
  }
  const r = { start: Number(m[1]), end: Number(m[2]) };
  if (r.start < 1 || r.end < r.start || r.end > total) {
    throw new Error(`lineRange ${spec} is outside 1-${total}`);
  }
  return r;
}

/** Turns @sntxrr/egm findings data (or a JSON file) into resolve input. Exported for tests. */
export function normalizeFindings(input: unknown): InFinding[] {
  const list: unknown[] = Array.isArray(input)
    ? input
    : input && typeof input === "object" &&
        Array.isArray((input as Record<string, unknown>).rawFindings)
    ? (input as { rawFindings: unknown[] }).rawFindings
    : [];
  const out: InFinding[] = [];
  const seen = new Set<string>();
  list.forEach((raw, i) => {
    const f = raw as Record<string, unknown>;
    const sev = String(f.severity ?? "").replace(/[^A-Za-z]/g, "")
      .toLowerCase();
    const severity = sev.startsWith("block")
      ? "Blocker"
      : sev.startsWith("maj")
      ? "Major"
      : sev.startsWith("nit") || sev.startsWith("minor")
      ? "Nit"
      : null;
    if (!severity) {
      throw new Error(`finding ${i + 1} has no Blocker/Major/Nit severity`);
    }
    const persona = String(f.persona ?? f.reviewerPersona ?? "unknown");
    const description = String(
      f.finding ?? f.description ?? f.discrepancyDescription ?? "",
    );
    const dedupe = `${persona}|${description}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push({
      findingId: String(f.id ?? f.findingId ?? `F${i + 1}`),
      reviewerPersona: persona.startsWith("egm-") ? persona : `egm-${persona}`,
      severity,
      title: String(f.title ?? description.slice(0, 80)),
      scope: [f.section, f.lines ? `lines ${f.lines}` : f.scope]
        .filter(Boolean).join(", "),
      description,
      rationale: String(f.suggestion ?? f.rationale ?? f.recommendation ?? ""),
    });
  });
  return out.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );
}

const RULES = `Give each finding exactly one category:
* CONTEST: The critique is inaccurate or relies on a misunderstanding of the codebase. Cite evidence that the reviewer could read: a file and symbol, or a decision recorded in the document.
* ESCALATE: The critique is inaccurate, but the evidence is outside every file the reviewer could read (for example, a team convention or a verbal decision). State that fact. Do not fix the finding.
* PROPOSE FIX: The critique is valid. Define precise textual replacements or structural formatting adjustments to resolve the gap.
* DECLINE: The finding is a Nit. Record it. Do not fix it. You can use PROPOSE FIX for a Nit if the fix is worth it.

Apply these rules:
* A contest must be checkable. "This was intentional" is not evidence. If you cannot cite evidence the reviewer could read, use ESCALATE or PROPOSE FIX.
* Do not add context only to satisfy a reviewer. Add context when a human reader of the document needs it. If only a zero-context subagent needs it, use ESCALATE.
* Do not contest a comprehension gap. If a fresh reader could not follow the document, the document is missing context.
* Do not change a severity. If you think a Blocker is a Nit, CONTEST it and state the reason.`;

function buildPrompt(
  display: string,
  lines: string[],
  range: Range,
  findings: InFinding[],
  context: { path: string; content: string }[],
): string {
  const parts = [
    "You are resolving findings from independent Goldfish reviewers of a design document. You have Read, Grep and Glob, rooted at the repository, to check evidence. You cannot change anything.",
    "",
    RULES,
    "",
    [
      "For PROPOSE FIX, give edits as exact {location, oldText, newText}.",
      "oldText must be copied exactly from the document (without the line-number prefix), must occur exactly once in the whole document, and must lie inside the LineRange.",
      "Keep each oldText as short as is still unique.",
      "Edits must not overlap: when several findings need the same passage changed, write ONE edit on the highest-severity of them that resolves all of them, and give each of the others category PROPOSE FIX, no edits, and coveredBy set to that finding's id.",
      "For CONTEST, set evidence.file to a repository-relative path you actually read.",
    ].join(" "),
    "",
    `TargetFile: ${display}`,
    `LineRange: ${range.start}-${range.end}`,
    "",
    "## Document",
    "",
    "```text",
    numberLines(lines, range),
    "```",
  ];
  if (context.length) {
    parts.push("", "## Design notes from the author", "");
    for (const c of context) {
      parts.push(`### ${c.path}`, "", "```text", c.content, "```", "");
    }
  }
  parts.push(
    "",
    "## Findings",
    "",
    "```json",
    JSON.stringify(findings, null, 1),
    "```",
    "",
    "Categorize every finding exactly once, by findingId. Respond only with JSON that matches the provided schema.",
  );
  return parts.join("\n");
}

function countOccurrences(hay: string, needle: string): number[] {
  const at: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    at.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return at;
}

/** Offset of the first character of a 1-based line. */
function lineOffset(text: string, line: number): number {
  let off = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf("\n", off);
    if (nl === -1) return text.length;
    off = nl + 1;
  }
  return off;
}

/** Classifies each edit against the document. Exported for tests. */
export function checkEdits(
  text: string,
  range: Range,
  edits: { editId: string; oldText: string }[],
): Map<string, z.infer<typeof Applicability>> {
  const lo = lineOffset(text, range.start);
  const hi = lineOffset(text, range.end + 1);
  const out = new Map<string, z.infer<typeof Applicability>>();
  const spans: { id: string; s: number; e: number }[] = [];
  for (const e of edits) {
    const at = countOccurrences(text, e.oldText);
    if (at.length === 0) out.set(e.editId, "missing");
    else if (at.length > 1) out.set(e.editId, "ambiguous");
    else if (at[0] < lo || at[0] + e.oldText.length > hi) {
      out.set(e.editId, "outOfRange");
    } else {
      out.set(e.editId, "unique");
      spans.push({ id: e.editId, s: at[0], e: at[0] + e.oldText.length });
    }
  }
  spans.sort((a, b) => a.s - b.s);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].s < spans[i - 1].e) {
      out.set(spans[i].id, "overlaps");
      out.set(spans[i - 1].id, "overlaps");
    }
  }
  return out;
}

/** Applies unique, non-overlapping edits in one pass on the original text. Exported for tests. */
export function applyEdits(
  text: string,
  edits: { editId: string; oldText: string; newText: string }[],
): string {
  const spans = edits.map((e) => {
    const s = text.indexOf(e.oldText);
    return { ...e, s, e: s + e.oldText.length };
  }).sort((a, b) => b.s - a.s);
  let out = text;
  for (const sp of spans) {
    out = out.slice(0, sp.s) + sp.newText + out.slice(sp.e);
  }
  return out;
}

/** Cheap structural checks after editing. Exported for tests. */
export function markdownIssues(before: string, after: string): string[] {
  const issues: string[] = [];
  const fences = (t: string) =>
    t.split("\n").filter((l) => /^\s*(```|~~~)/.test(l)).length;
  if (fences(after) % 2 !== 0) issues.push("unbalanced code fences");
  const heads = (t: string) =>
    t.split("\n").filter((l) => /^#{1,6}\s/.test(l)).length;
  if (heads(after) < heads(before)) {
    issues.push(
      `heading count dropped from ${heads(before)} to ${heads(after)}`,
    );
  }
  if (after.trim() === "") issues.push("document is empty");
  return issues;
}

const CHECKBOX_RE =
  /^\s*-\s*\[([ xX])\]\s*apply\s*<!--\s*egm-edit:([A-Za-z0-9._-]+)\s*-->/;

/** Edit ids still ticked in the report. Exported for tests. */
export function checkedEditIds(report: string): Set<string> {
  const ids = new Set<string>();
  for (const l of report.split("\n")) {
    const m = l.match(CHECKBOX_RE);
    if (m && m[1].toLowerCase() === "x") ids.add(m[2]);
  }
  return ids;
}

function renderReport(
  req: ResolveRequest,
  res: Omit<Resolution, "timestamp">,
): string {
  const out = [
    "# Goldfish Annotated Review Report",
    "",
    `**Target:** \`${req.targetDisplay}\` (\`${req.lineRange}\`)`,
    "**Status:** awaiting approval",
    "",
    `CONTEST ${res.counts.contest} · ESCALATE ${res.counts.escalate} · PROPOSE FIX ${res.counts.proposeFix} · DECLINE ${res.counts.decline} · applicable edits ${res.applicableEditCount} of ${res.proposedEditCount}`,
    "",
    "Untick `[x] apply` on any edit you do not want, then approve the workflow gate. Only ticked, applicable edits are applied.",
    "",
  ];
  const esc = res.items.filter((i) => i.category === "ESCALATE");
  if (esc.length) {
    out.push(
      "## Needs your knowledge (ESCALATE)",
      "",
      ...esc.map((i) => `* **${i.findingId}** ${i.title}: ${i.justification}`),
      "",
    );
  }
  out.push("## Prioritized Findings & AI Suggestions", "");
  res.items.forEach((i, n) => {
    out.push(
      `### [Issue ${
        n + 1
      }] [\`${i.reviewerPersona}\`] - Severity: ${i.severity}`,
      "",
      `*   **Finding:** ${i.findingId}: ${i.title}`,
      `*   **Affected Scope:** ${i.scope || "unspecified"}`,
      `*   **Discrepancy Description:** ${i.description}`,
      `*   **Rationale:** ${i.rationale}`,
      `*   ***AI Suggestion:*** ${i.category}${
        i.demotedFromContest
          ? " (demoted from CONTEST: evidence not checkable)"
          : ""
      }`,
      `*   ***Justification:*** ${i.justification}`,
    );
    if (i.evidence) out.push(`*   ***Evidence:*** ${i.evidence}`);
    if (i.coveredBy) {
      out.push(`*   ***Covered by:*** the edit on ${i.coveredBy}`);
    }
    for (const e of i.edits) {
      out.push(
        `*   ***Proposed Edit*** (${e.editId}, ${e.applicability}):`,
        `    *   Location: ${e.location}`,
        "    *   Replace:",
        "",
        "        ```text",
        ...e.oldText.split("\n").map((l) => `        ${l}`),
        "        ```",
        "",
        "    *   With:",
        "",
        "        ```text",
        ...e.newText.split("\n").map((l) => `        ${l}`),
        "        ```",
        "",
        e.applicability === "unique"
          ? `    - [x] apply <!-- egm-edit:${e.editId} -->`
          : `    *   Not applicable (${e.applicability}); it will be skipped.`,
      );
    }
    out.push("");
  });
  return out.join("\n");
}

// ---------------------------------------------------------------- prepare

const PrepareArgs = z.object({
  targetFile: z.string().min(1).describe(
    "Document to resolve, absolute or relative to workingDirectory",
  ),
  lineRange: z.string().default("full file").describe(
    '"full file" or "N-M"; edits must fall inside it',
  ),
  egmModelName: z.string().default("egm-doc").describe(
    "@sntxrr/egm review instance whose findings to resolve (ignored when findingsPath is set)",
  ),
  findingsPath: z.string().default("").describe(
    "Optional JSON file holding a findings array instead",
  ),
  contextPaths: z.array(z.string()).default([]).describe(
    "Author design notes or decision records; they stand in for the authoring session's memory",
  ),
  maxContextBytes: z.number().int().positive().default(100_000),
});

async function prepare(
  rawArgs: z.input<typeof PrepareArgs>,
  ctx: Ctx,
): Promise<{ dataHandles: { name: string }[] }> {
  const args = PrepareArgs.parse(rawArgs);
  ctx.logger.info("loading findings for {target}", { target: args.targetFile });
  const wd = await Deno.realPath(ctx.globalArgs.workingDirectory ?? Deno.cwd());
  const artifactDir = resolvePath(wd, ctx.globalArgs.artifactDir ?? ".");
  const target = await Deno.realPath(resolvePath(wd, args.targetFile));
  const text = await Deno.readTextFile(target);
  const lines = splitLines(text);
  const range = parseLineRange(args.lineRange, lines.length);

  let raw: unknown;
  let source: "file" | "egm";
  if (args.findingsPath) {
    raw = JSON.parse(
      await Deno.readTextFile(resolvePath(wd, args.findingsPath)),
    );
    source = "file";
  } else {
    if (!ctx.readModelData) throw new Error("prepare needs readModelData");
    const recs = await ctx.readModelData(args.egmModelName, "findings");
    if (recs.length === 0) {
      throw new Error(
        `No findings data on "${args.egmModelName}"; run the egm-review workflow first or pass findingsPath.`,
      );
    }
    const plans = await ctx.readModelData(args.egmModelName, "reviewPlan");
    const planTarget = plans[0]?.attributes.targetFile;
    if (planTarget && planTarget !== target) {
      throw new Error(
        `"${args.egmModelName}" reviewed ${planTarget}, not ${target}`,
      );
    }
    raw = recs[0].attributes;
    source = "egm";
  }
  const findings = normalizeFindings(raw);
  if (findings.length === 0) throw new Error("No findings to resolve.");

  const context: { path: string; content: string }[] = [];
  for (const p of args.contextPaths) {
    const abs = await Deno.realPath(resolvePath(wd, p));
    let c = await Deno.readTextFile(abs);
    if (c.length > args.maxContextBytes) {
      c = `${c.slice(0, args.maxContextBytes)}\n[... truncated ...]`;
    }
    context.push({ path: relTo(wd, abs), content: c });
  }
  const display = relTo(wd, target);
  const req: ResolveRequest = {
    batch: `resolve-${crypto.randomUUID().slice(0, 8)}`,
    targetFile: target,
    targetDisplay: display,
    workingDirectory: wd,
    artifactDir,
    lineRange: `${range.start}-${range.end}`,
    range,
    documentSha256: await sha256(text),
    findings,
    findingCount: findings.length,
    sourceOfFindings: source,
    requests: [{
      key: "classify",
      prompt: buildPrompt(display, lines, range, findings, context),
      jsonSchema: ANSWER_JSON,
      tools: [...READONLY_TOOLS],
    }],
    timestamp: new Date().toISOString(),
  };
  ctx.logger.info("loaded {n} findings from {src}", {
    n: findings.length,
    src: source,
  });
  const handle = await ctx.writeResource(
    "resolveRequest",
    "resolveRequest",
    ResolveRequestSchema.parse(req),
  );
  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------- writeReport

const WriteArgs = z.object({
  resultsModel: z.string().default("egm-resolve-claude").describe(
    "Name of the @keeb/anthropic/claude instance that ran the categorization",
  ),
});

async function writeReport(
  rawArgs: z.input<typeof WriteArgs>,
  ctx: Ctx,
): Promise<{ dataHandles: { name: string }[] }> {
  const args = WriteArgs.parse(rawArgs);
  ctx.logger.info("validating categorization from {model}", {
    model: args.resultsModel,
  });
  if (!ctx.readResource || !ctx.readModelData) {
    throw new Error("writeReport needs readResource and readModelData");
  }
  const reqRaw = await ctx.readResource("resolveRequest");
  if (!reqRaw) throw new Error("No resolveRequest data; run prepare first.");
  const req = ResolveRequestSchema.parse(reqRaw);
  const rec = (await ctx.readModelData(args.resultsModel, "cliResult"))
    .map((r) => r.attributes)
    .find((a) => a.batch === req.batch && a.key === "classify");
  if (!rec) throw new Error(`No categorization result for batch ${req.batch}`);
  if (rec.ok !== true) {
    throw new Error(`categorization failed: ${String(rec.error ?? "unknown")}`);
  }
  const ans = AnswerSchema.safeParse(rec.structured);
  if (!ans.success) {
    throw new Error(
      `categorization answer does not match the schema: ${
        ans.error.message.slice(0, 600)
      }`,
    );
  }
  const text = await Deno.readTextFile(req.targetFile);
  const known = new Map(req.findings.map((f) => [f.findingId, f]));
  const seen = new Map<string, number>();
  const unknown: string[] = [];
  for (const it of ans.data.items) {
    if (!known.has(it.findingId)) unknown.push(it.findingId);
    seen.set(it.findingId, (seen.get(it.findingId) ?? 0) + 1);
  }
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  const missing = req.findings.map((f) => f.findingId).filter((id) =>
    !seen.has(id)
  );

  const items: ResolutionItem[] = [];
  for (const f of req.findings) {
    const a = ans.data.items.find((i) => i.findingId === f.findingId);
    if (!a) continue;
    let category: Category = a.category;
    let justification = a.justification;
    let demoted = false;
    let evidence: string | undefined;
    if (a.evidence?.file) {
      evidence = [a.evidence.file, a.evidence.symbol, a.evidence.detail]
        .filter(Boolean).join(" · ");
    }
    if (category === "CONTEST") {
      const file = a.evidence?.file;
      let ok = false;
      if (file) {
        try {
          const abs = await Deno.realPath(
            resolvePath(req.workingDirectory, file),
          );
          ok = abs.startsWith(`${req.workingDirectory}/`) &&
            (await Deno.stat(abs)).isFile;
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        category = "ESCALATE";
        demoted = true;
        justification += ` [Demoted: the cited evidence file ${
          file ? `"${file}" does not exist in the repository` : "is missing"
        }, so the contest is not checkable.]`;
      }
    }
    const edits = category === "PROPOSE FIX"
      ? a.edits.map((e, k) => ({ editId: `${f.findingId}.${k + 1}`, ...e }))
      : [];
    items.push({
      ...f,
      category,
      justification,
      evidence,
      demotedFromContest: demoted,
      ...(category === "PROPOSE FIX" && a.coveredBy && edits.length === 0
        ? { coveredBy: a.coveredBy }
        : {}),
      edits: edits.map((e) => ({ ...e, applicability: "unique" as const })),
    });
  }
  // coveredBy must point at a PROPOSE FIX item that carries its own edits
  const withEdits = new Set(
    items.filter((i) => i.category === "PROPOSE FIX" && i.edits.length > 0)
      .map((i) => i.findingId),
  );
  for (const i of items) {
    if (i.coveredBy && !withEdits.has(i.coveredBy)) {
      i.justification +=
        ` [coveredBy ${i.coveredBy} ignored: that finding has no edit.]`;
      delete i.coveredBy;
    }
  }
  const applic = checkEdits(text, req.range, items.flatMap((i) => i.edits));
  for (const i of items) {
    for (const e of i.edits) e.applicability = applic.get(e.editId)!;
  }
  const allEdits = items.flatMap((i) => i.edits);
  const counts = {
    contest: items.filter((i) => i.category === "CONTEST").length,
    escalate: items.filter((i) => i.category === "ESCALATE").length,
    proposeFix: items.filter((i) => i.category === "PROPOSE FIX").length,
    decline: items.filter((i) => i.category === "DECLINE").length,
  };
  await Deno.mkdir(req.artifactDir, { recursive: true });
  const reportPath = `${req.artifactDir}/goldfish_review_report.md`;
  const resolution: Resolution = {
    batch: req.batch,
    reportPath,
    documentSha256: req.documentSha256,
    items,
    counts,
    proposedEditCount: allEdits.length,
    applicableEditCount: allEdits.filter((e) => e.applicability === "unique")
      .length,
    missingFindingIds: missing,
    duplicateFindingIds: duplicates,
    unknownFindingIds: unknown,
    allClassified: missing.length === 0 && duplicates.length === 0 &&
      unknown.length === 0,
    escalated: items.filter((i) => i.category === "ESCALATE").map((i) =>
      i.findingId
    ),
    timestamp: new Date().toISOString(),
  };
  await Deno.writeTextFile(reportPath, renderReport(req, resolution));
  ctx.logger.info(
    "contest {c} / escalate {e} / fix {f} / decline {d}; {a} of {p} edits applicable",
    {
      c: counts.contest,
      e: counts.escalate,
      f: counts.proposeFix,
      d: counts.decline,
      a: resolution.applicableEditCount,
      p: resolution.proposedEditCount,
    },
  );
  const handle = await ctx.writeResource(
    "resolution",
    "resolution",
    ResolutionSchema.parse(resolution),
  );
  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------- applyFixes

async function applyFixes(
  _args: Record<string, never>,
  ctx: Ctx,
): Promise<{ dataHandles: { name: string }[] }> {
  ctx.logger.info("applying approved edits");
  if (!ctx.readResource) throw new Error("applyFixes needs readResource");
  const reqRaw = await ctx.readResource("resolveRequest");
  const resRaw = await ctx.readResource("resolution");
  if (!reqRaw || !resRaw) throw new Error("Run prepare and writeReport first.");
  const req = ResolveRequestSchema.parse(reqRaw);
  const res = ResolutionSchema.parse(resRaw);
  if (res.batch !== req.batch) {
    throw new Error("resolution belongs to an older batch; re-run writeReport");
  }
  const before = await Deno.readTextFile(req.targetFile);
  const shaBefore = await sha256(before);
  if (shaBefore !== res.documentSha256) {
    throw new Error(
      `${req.targetDisplay} changed since it was categorized; refusing to apply. Re-run the egm-resolve workflow.`,
    );
  }
  const report = await Deno.readTextFile(res.reportPath);
  const ticked = checkedEditIds(report);
  const applied: { editId: string; findingId: string }[] = [];
  const skipped: { editId: string; findingId: string; reason: string }[] = [];
  const toApply: { editId: string; oldText: string; newText: string }[] = [];
  for (const i of res.items) {
    for (const e of i.edits) {
      if (e.applicability !== "unique") {
        skipped.push({
          editId: e.editId,
          findingId: i.findingId,
          reason: e.applicability,
        });
      } else if (!ticked.has(e.editId)) {
        skipped.push({
          editId: e.editId,
          findingId: i.findingId,
          reason: "unticked",
        });
      } else {
        toApply.push(e);
        applied.push({ editId: e.editId, findingId: i.findingId });
      }
    }
  }
  // re-check against the current text: the hash matched, so this only guards logic errors
  const recheck = checkEdits(before, req.range, toApply);
  for (const e of toApply) {
    if (recheck.get(e.editId) !== "unique") {
      throw new Error(
        `edit ${e.editId} no longer applies uniquely; nothing written`,
      );
    }
  }
  let after = before;
  let backupPath: string | null = null;
  let issues: string[] = [];
  if (toApply.length > 0) {
    after = applyEdits(before, toApply);
    issues = markdownIssues(before, after);
    const base = req.targetFile.split("/").pop()!;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${req.artifactDir}/${base}.${stamp}.bak`;
    await Deno.copyFile(req.targetFile, backupPath);
    const tmp = `${req.targetFile}.egm-tmp`;
    await Deno.writeTextFile(tmp, after);
    await Deno.rename(tmp, req.targetFile);
  }
  const summary =
    `**Status:** resolved (${applied.length} edits applied, ${skipped.length} skipped${
      backupPath ? `; backup at \`${backupPath}\`` : ""
    })`;
  await Deno.writeTextFile(
    res.reportPath,
    report.replace("**Status:** awaiting approval", summary),
  );
  const fixedFindings = new Set(applied.map((a) => a.findingId));
  for (const i of res.items) {
    if (i.coveredBy && fixedFindings.has(i.coveredBy)) {
      fixedFindings.add(i.findingId);
    }
  }
  const result = {
    batch: req.batch,
    backupPath,
    documentShaBefore: shaBefore,
    documentShaAfter: await sha256(after),
    changed: after !== before,
    applied,
    skipped,
    appliedCount: applied.length,
    skippedCount: skipped.length,
    markdownValid: issues.length === 0,
    markdownIssues: issues,
    reportPath: res.reportPath,
    handoff: {
      acceptedFixes: fixedFindings.size,
      contested: res.counts.contest,
      escalated: res.counts.escalate,
      declined: res.counts.decline,
      remainingUnaddressed: res.counts.escalate +
        res.items.filter((i) =>
          i.category === "PROPOSE FIX" && !fixedFindings.has(i.findingId)
        ).length,
    },
    timestamp: new Date().toISOString(),
  };
  ctx.logger.info("applied {a} edits, skipped {s}", {
    a: applied.length,
    s: skipped.length,
  });
  const handle = await ctx.writeResource(
    "applyResult",
    "applyResult",
    ApplyResultSchema.parse(result),
  );
  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------- model

/** Behavior definition for @sntxrr/egm/resolve. */
export const model = {
  type: "@sntxrr/egm/resolve",
  version: "2026.11.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    resolveRequest: {
      description:
        "Target document, normalized findings and the categorization request",
      schema: ResolveRequestSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    resolution: {
      description:
        "Category, justification and checked edits per finding, and the report path",
      schema: ResolutionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    applyResult: {
      description: "Edits applied and skipped, backup path and handoff counts",
      schema: ApplyResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    prepare: {
      description:
        "Load the target document and findings, and build one read-only categorization request.",
      arguments: PrepareArgs,
      execute: prepare,
    },
    writeReport: {
      description:
        "Validate the categorization, enforce the contest-must-be-checkable and no-severity-change rules, check every edit applies uniquely, and write goldfish_review_report.md.",
      arguments: WriteArgs,
      execute: writeReport,
    },
    applyFixes: {
      description:
        "After approval: back up the document and apply the ticked, applicable PROPOSE FIX edits by exact unique-string replacement. Refuses if the document changed since categorization.",
      arguments: z.object({}),
      execute: applyFixes,
    },
  },
};
