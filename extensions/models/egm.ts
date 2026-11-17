/**
 * EGM (Elephant-Goldfish Model) design-document review as a swamp behavior.
 *
 * `prepare` reads a design document, finds the feature-spec /
 * implementation-plan split, resolves context files, and builds one isolated
 * prompt per (stage, persona, instance) from the vendored EGM persona and
 * standard files. The prompts are run by `@keeb/anthropic/claude`'s
 * `cli_generate_many_tools` (see egm_claude_tools.ts). `collectFindings`
 * validates the reviewers' structured answers, schedules one retry for
 * failures and builds the synthesizer prompt. `writeReports` writes the
 * per-stage reports and consolidated_review_report.md with a traceability
 * matrix, so no raw finding is silently dropped.
 *
 * Upstream: https://github.com/google/elephant-goldfish-model (Apache-2.0).
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  buildReviewPrompt,
  EXECUTION_CONSTRAINTS,
  extractLinks,
  findSplit,
  isUrl,
  normalizePersona,
  parseReviewerOutput,
  type Persona,
  PERSONAS,
  type Range,
  resolveStages,
  reviewerSchema,
  SEVERITY_ORDER,
  type Split,
  stageRange,
  STAGES,
  type Synthesis,
  SYNTHESIS_SCHEMA,
  SynthesisSchema,
} from "./egm_lib.ts";
import { READONLY_TOOLS } from "./egm_claude_tools.ts";

// ---------------------------------------------------------------- schemas

const GlobalArgsSchema = z.object({
  workingDirectory: z.string().optional().describe(
    "Root that linked files must stay inside (checked on the real path) and that tool-enabled reviewers may read. Defaults to the swamp repo root.",
  ),
  outputDir: z.string().optional().describe(
    "Folder the report files are written to. Defaults to workingDirectory.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RangeSchema = z.object({ start: z.number(), end: z.number() });

const RequestSchema = z.object({
  key: z.string(),
  stage: z.number(),
  persona: z.string(),
  instance: z.string(),
  prompt: z.string(),
  jsonSchema: z.record(z.string(), z.unknown()),
  tools: z.array(z.string()),
});

type ReviewRequest = z.infer<typeof RequestSchema>;

const ReviewPlanSchema = z.object({
  batch: z.string(),
  targetFile: z.string(),
  targetDisplay: z.string(),
  workingDirectory: z.string(),
  outputDir: z.string(),
  lineCount: z.number(),
  preset: z.string(),
  stages: z.array(z.number()),
  splitStatus: z.string(),
  boundaryHeader: z.string().nullable(),
  featureRange: RangeSchema,
  detailedRange: RangeSchema.nullable(),
  candidateHeaders: z.array(z.object({ line: z.number(), text: z.string() })),
  contextFiles: z.array(z.string()),
  excludedLinks: z.array(z.object({ link: z.string(), reason: z.string() })),
  warnings: z.array(z.string()),
  requests: z.array(RequestSchema),
  requestCount: z.number(),
  toolRequestCount: z.number(),
  timestamp: z.string(),
});

type ReviewPlan = z.infer<typeof ReviewPlanSchema>;

const ReviewerStatusSchema = z.object({
  key: z.string(),
  stage: z.number(),
  persona: z.string(),
  instance: z.string(),
  status: z.enum(["completed", "not_run"]),
  attempts: z.number(),
  findingCount: z.number(),
  error: z.string().optional(),
});

const RawFindingSchema = z.object({
  id: z.string(),
  key: z.string(),
  stage: z.number(),
  persona: z.string(),
  severity: z.enum(["Blocker", "Major", "Nit"]),
  title: z.string(),
  section: z.string(),
  lines: z.string().optional(),
  finding: z.string(),
  suggestion: z.string(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

type RawFinding = z.infer<typeof RawFindingSchema>;

const FindingsSchema = z.object({
  batch: z.string(),
  retryBatch: z.string(),
  reviewers: z.array(ReviewerStatusSchema),
  rawFindings: z.array(RawFindingSchema),
  comprehension: z.array(z.object({
    key: z.string(),
    instance: z.string(),
    whatThisProposes: z.string(),
    howExistingSystemWorks: z.string(),
    findingIds: z.array(z.string()),
  })),
  inventiveNoFalseCompromise: z.array(z.string()),
  retryRequests: z.array(z.record(z.string(), z.unknown())),
  severityCounts: z.record(
    z.string(),
    z.object({ Blocker: z.number(), Major: z.number(), Nit: z.number() }),
  ),
  synthesisPrompt: z.string(),
  synthesisSchema: z.record(z.string(), z.unknown()),
  costUsd: z.number(),
  timestamp: z.string(),
});

type Findings = z.infer<typeof FindingsSchema>;

const ReportsSchema = z.object({
  files: z.array(z.object({ stage: z.number(), path: z.string() })),
  consolidatedReportPath: z.string(),
  untracedFindingIds: z.array(z.string()),
  severityTotals: z.object({
    Blocker: z.number(),
    Major: z.number(),
    Nit: z.number(),
  }),
  actionItems: z.number(),
  reviewersNotRun: z.array(z.string()),
  warnings: z.array(z.string()),
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
  extensionFile?: (path: string) => string;
}

// ---------------------------------------------------------------- io helpers

function promptPath(ctx: Ctx, rel: string): string {
  const p = `egm/prompts/${rel}`;
  if (ctx.extensionFile) return ctx.extensionFile(p);
  return new URL(`./${p}`, import.meta.url).pathname;
}

async function readPrompt(ctx: Ctx, rel: string): Promise<string> {
  return await Deno.readTextFile(promptPath(ctx, rel));
}

function resolvePath(base: string, p: string): string {
  if (p.startsWith("/")) return p;
  return `${base.replace(/\/$/, "")}/${p}`;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function relTo(root: string, p: string): string {
  const r = root.endsWith("/") ? root : `${root}/`;
  return p.startsWith(r) ? p.slice(r.length) : p;
}

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await Deno.realPath(p);
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): { text: string; cut: boolean } {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= max) return { text: s, cut: false };
  return {
    text: new TextDecoder().decode(bytes.slice(0, max)) +
      "\n[... truncated by @sntxrr/egm: maxContextBytes ...]",
    cut: true,
  };
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function rangeLabel(r: Range | null, total: number): string {
  if (!r) return "N/A";
  return r.start === 1 && r.end === total ? "full file" : `${r.start}-${r.end}`;
}

// ---------------------------------------------------------------- prepare

const PrepareArgs = z.object({
  targetFile: z.string().min(1).describe(
    "Design document, absolute or relative to workingDirectory",
  ),
  goldfishContext: z.array(z.string()).default([]).describe(
    "Extra context files for every stage except 6 (comprehension)",
  ),
  preset: z.enum(["uninterrupted", "feature_spec", "implementation"])
    .default("uninterrupted"),
  stages: z.array(z.number().int()).default([]).describe(
    "Explicit stages (5-9); overrides the preset when not empty",
  ),
  personas: z.record(z.string(), z.array(z.string())).default({}).describe(
    'Per-stage reviewer override, e.g. {"7": ["design", "style"]}',
  ),
  approvedExternalLinks: z.array(z.string()).default([]).describe(
    "Links outside workingDirectory, or URLs, approved as context. Others are excluded and listed.",
  ),
  splitLine: z.number().int().min(0).default(0).describe(
    "Manual feature/implementation boundary line; 0 = auto",
  ),
  instancesPerReviewer: z.number().int().min(1).max(3).default(1).describe(
    "Independent copies (A, B, C) of each reviewer, for recall",
  ),
  maxContextBytes: z.number().int().positive().default(100_000).describe(
    "Per-file cap on context file content added to each prompt",
  ),
});

async function prepare(
  rawArgs: z.input<typeof PrepareArgs>,
  ctx: Ctx,
): Promise<{ dataHandles: { name: string }[] }> {
  const args = PrepareArgs.parse(rawArgs);
  ctx.logger.info("preparing EGM review of {target}", {
    target: args.targetFile,
  });
  const wd = await Deno.realPath(ctx.globalArgs.workingDirectory ?? Deno.cwd());
  const outputDir = resolvePath(wd, ctx.globalArgs.outputDir ?? ".");
  const target = await realOrNull(resolvePath(wd, args.targetFile));
  if (!target) throw new Error(`targetFile not found: ${args.targetFile}`);
  const text = await Deno.readTextFile(target);
  const lines = splitLines(text);
  if (lines.length === 0 || text.trim() === "") {
    throw new Error(`targetFile is empty: ${args.targetFile}`);
  }

  let stages = resolveStages(args.preset, args.stages);
  const split: Split = findSplit(lines, {
    preset: args.preset,
    splitLine: args.splitLine,
  });
  const warnings = [...split.warnings];
  if (stages.includes(9) && !split.detailedRange) {
    stages = stages.filter((s) => s !== 9);
    warnings.push("Stage 9 dropped: the document has no implementation plan.");
  }
  if (stages.length === 0) {
    throw new Error(
      "No stages left to run (stage 9 needs an implementation-plan section).",
    );
  }

  // ---- context files
  const excludedLinks: { link: string; reason: string }[] = [];
  const contextPaths: string[] = [];
  const addCtx = (p: string) => {
    if (p !== target && !contextPaths.includes(p)) contextPaths.push(p);
  };
  for (const c of args.goldfishContext) {
    const p = await realOrNull(resolvePath(wd, c));
    if (!p) throw new Error(`goldfishContext file not found: ${c}`);
    addCtx(p);
  }
  const fetched: { path: string; content: string }[] = [];
  if (stages.some((s) => STAGES[s].context)) {
    const approved = new Set(args.approvedExternalLinks);
    for (const link of extractLinks(text)) {
      if (isUrl(link)) {
        if (!approved.has(link)) {
          excludedLinks.push({ link, reason: "not_approved" });
          continue;
        }
        try {
          const res = await fetch(link, {
            signal: AbortSignal.timeout(20_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          fetched.push({ path: link, content: await res.text() });
        } catch (e) {
          excludedLinks.push({
            link,
            reason: `fetch_failed: ${e instanceof Error ? e.message : e}`,
          });
        }
        continue;
      }
      const p = await realOrNull(resolvePath(dirname(target), link));
      if (!p) {
        excludedLinks.push({ link, reason: "not_found" });
        continue;
      }
      const st = await Deno.stat(p);
      if (!st.isFile) {
        excludedLinks.push({ link, reason: "not_a_file" });
        continue;
      }
      if (inside(wd, p) || approved.has(link)) addCtx(p);
      else excludedLinks.push({ link, reason: "outside_working_directory" });
    }
  }
  const context: { path: string; content: string }[] = [];
  for (const p of contextPaths) {
    const t = truncate(await Deno.readTextFile(p), args.maxContextBytes);
    if (t.cut) warnings.push(`Context file truncated: ${relTo(wd, p)}`);
    context.push({ path: relTo(wd, p), content: t.text });
  }
  for (const f of fetched) {
    const t = truncate(f.content, args.maxContextBytes);
    if (t.cut) warnings.push(`Context URL truncated: ${f.path}`);
    context.push({ path: f.path, content: t.text });
  }

  // ---- prompts
  const overrides: Record<number, Persona[]> = {};
  for (const [k, v] of Object.entries(args.personas)) {
    const s = Number(k);
    if (!(s in STAGES)) throw new Error(`personas: unknown stage ${k}`);
    overrides[s] = v.map(normalizePersona);
  }
  const personaText = new Map<Persona, string>();
  const standardText = new Map<string, string>();
  const display = relTo(wd, target);
  const requests: ReviewRequest[] = [];
  for (const s of stages) {
    const def = STAGES[s];
    const range = stageRange(def.range, split, lines.length);
    for (const persona of overrides[s] ?? def.reviewers) {
      if (!personaText.has(persona)) {
        personaText.set(
          persona,
          await readPrompt(ctx, `agents/${PERSONAS[persona].file}`),
        );
      }
      const stdName = def.standards[persona];
      if (stdName && !standardText.has(stdName)) {
        standardText.set(
          stdName,
          await readPrompt(ctx, `standards/${stdName}.md`),
        );
      }
      const tools = PERSONAS[persona].tools;
      for (let i = 0; i < args.instancesPerReviewer; i++) {
        const instance = String.fromCharCode(65 + i);
        requests.push({
          key: `s${s}-${persona}-${instance.toLowerCase()}`,
          stage: s,
          persona,
          instance,
          prompt: buildReviewPrompt({
            personaText: personaText.get(persona)!,
            persona,
            instance,
            stage: s,
            targetPath: display,
            range,
            totalLines: lines.length,
            standardName: stdName,
            standardText: stdName ? standardText.get(stdName) : undefined,
            documentLines: lines,
            context: def.context ? context : [],
            tools,
          }),
          jsonSchema: reviewerSchema(persona),
          tools: tools ? [...READONLY_TOOLS] : [],
        });
      }
    }
  }
  if (requests.length === 0) {
    throw new Error("No reviewer requests were built.");
  }

  const plan: ReviewPlan = {
    batch: `review-${crypto.randomUUID().slice(0, 8)}`,
    targetFile: target,
    targetDisplay: display,
    workingDirectory: wd,
    outputDir,
    lineCount: lines.length,
    preset: args.preset,
    stages,
    splitStatus: split.status,
    boundaryHeader: split.boundaryHeader,
    featureRange: split.featureRange,
    detailedRange: split.detailedRange,
    candidateHeaders: split.candidates,
    contextFiles: context.map((c) => c.path),
    excludedLinks,
    warnings,
    requests,
    requestCount: requests.length,
    toolRequestCount: requests.filter((r) => r.tools.length > 0).length,
    timestamp: new Date().toISOString(),
  };
  ctx.logger.info("built {n} reviewer prompts for stages {stages}", {
    n: requests.length,
    stages: stages.join(","),
  });
  const handle = await ctx.writeResource(
    "reviewPlan",
    "reviewPlan",
    ReviewPlanSchema.parse(plan),
  );
  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------- collect

const CollectArgs = z.object({
  resultsModel: z.string().default("egm-goldfish").describe(
    "Name of the @keeb/anthropic/claude instance that ran the batch",
  ),
  merge: z.boolean().default(false).describe(
    "false: first pass over the main batch. true: merge the retry batch into the previous findings.",
  ),
});

function buildSynthesisPrompt(plan: ReviewPlan, raw: RawFinding[]): string {
  const rows = raw.filter((f) => f.stage !== 6).map((f) => ({
    id: f.id,
    stage: f.stage,
    persona: `egm-${f.persona}`,
    severity: f.severity,
    title: f.title,
    section: f.section,
    lines: f.lines,
    finding: f.finding,
    suggestion: f.suggestion,
  }));
  const comp = raw.filter((f) => f.stage === 6).map((f) => ({
    id: f.id,
    severity: f.severity,
    title: f.title,
    finding: f.finding,
  }));
  return [
    "You are the EGM synthesizer. Independent Goldfish reviewers each read the design document below with no shared context. Your job is to aggregate and triage their findings. You have not read the document and must not add findings of your own.",
    "",
    `Target: ${plan.targetDisplay}. Stages run: ${plan.stages.join(", ")}.`,
    "",
    "Tasks:",
    "1. For each stage except 6, group duplicate or overlapping findings into one stage finding. Keep the highest severity in the group. List every source finding id in sourceIds.",
    "2. Consolidate across all stages (including stage 6 comprehension findings) into action items A1, A2, ... with priority Blocker, Major or Nit. Every source finding id must appear in at least one action item's sourceIds.",
    "3. Do not change a reviewer's severity downward without saying so in the rationale.",
    "",
    "Style:",
    EXECUTION_CONSTRAINTS,
    "",
    "Findings (stages 5, 7, 8, 9):",
    "```json",
    JSON.stringify(rows, null, 1),
    "```",
    "",
    "Comprehension findings (stage 6; use them only for cross-stage consolidation):",
    "```json",
    JSON.stringify(comp, null, 1),
    "```",
    "",
    "Respond only with JSON that matches the provided schema.",
  ].join("\n");
}

async function collectFindings(
  rawArgs: z.input<typeof CollectArgs>,
  ctx: Ctx,
): Promise<{ dataHandles: { name: string }[] }> {
  const args = CollectArgs.parse(rawArgs);
  ctx.logger.info("collecting reviewer results from {model} (merge={merge})", {
    model: args.resultsModel,
    merge: args.merge,
  });
  if (!ctx.readResource || !ctx.readModelData) {
    throw new Error("collectFindings needs readResource and readModelData");
  }
  const planRaw = await ctx.readResource("reviewPlan");
  if (!planRaw) throw new Error("No reviewPlan data; run prepare first.");
  const plan = ReviewPlanSchema.parse(planRaw);
  const retryBatch = `${plan.batch}-retry`;
  const results = await ctx.readModelData(args.resultsModel, "cliResult");
  const byKey = (batch: string) => {
    const m = new Map<string, Record<string, unknown>>();
    for (const r of results) {
      if (r.attributes.batch === batch) {
        m.set(String(r.attributes.key), r.attributes);
      }
    }
    return m;
  };

  let prior: Findings | null = null;
  if (args.merge) {
    const p = await ctx.readResource("findings");
    if (!p) throw new Error("merge=true but there are no prior findings");
    prior = FindingsSchema.parse(p);
    if (prior.batch !== plan.batch) {
      throw new Error(
        `prior findings belong to batch ${prior.batch}, not ${plan.batch}`,
      );
    }
  }
  const main = byKey(plan.batch);
  const retry = byKey(retryBatch);
  const retried = new Set(
    (prior?.retryRequests ?? []).map((r) => String(r.key)),
  );

  type Parsed = ReturnType<typeof parseReviewerOutput>;
  const outcomes = new Map<
    string,
    { parsed: Parsed; attempts: number; cost: number }
  >();
  for (const req of plan.requests) {
    const persona = req.persona as Persona;
    const cost = (rec?: Record<string, unknown>) => Number(rec?.costUsd ?? 0);
    const evaluate = (rec?: Record<string, unknown>): Parsed => {
      if (!rec) return { ok: false, error: "no result recorded" };
      if (rec.ok !== true) {
        return { ok: false, error: String(rec.error ?? "claude call failed") };
      }
      return parseReviewerOutput(
        rec as { structured?: unknown; response?: string },
        persona,
      );
    };
    const first = evaluate(main.get(req.key));
    if (args.merge && retried.has(req.key)) {
      const second = evaluate(retry.get(req.key));
      outcomes.set(req.key, {
        parsed: second.ok ? second : first.ok ? first : second,
        attempts: 2,
        cost: cost(main.get(req.key)) + cost(retry.get(req.key)),
      });
    } else {
      outcomes.set(req.key, {
        parsed: first,
        attempts: 1,
        cost: cost(main.get(req.key)),
      });
    }
  }

  const reviewers: Findings["reviewers"] = [];
  const rawFindings: RawFinding[] = [];
  const comprehension: Findings["comprehension"] = [];
  const noFalseCompromise: string[] = [];
  const retryRequests: Record<string, unknown>[] = [];
  let n = 0;
  let costUsd = 0;
  for (const req of plan.requests) {
    const o = outcomes.get(req.key)!;
    costUsd += o.cost;
    if (!o.parsed.ok) {
      reviewers.push({
        key: req.key,
        stage: req.stage,
        persona: req.persona,
        instance: req.instance,
        status: "not_run",
        attempts: o.attempts,
        findingCount: 0,
        error: o.parsed.error,
      });
      if (!args.merge) {
        retryRequests.push({
          key: req.key,
          prompt: req.prompt,
          jsonSchema: req.jsonSchema,
          tools: req.tools,
        });
      }
      continue;
    }
    const v = o.parsed.value;
    const ids: string[] = [];
    for (const f of v.findings) {
      const id = `F${++n}`;
      ids.push(id);
      const { severity, title, section, lines, finding, suggestion, ...extra } =
        f;
      rawFindings.push({
        id,
        key: req.key,
        stage: req.stage,
        persona: req.persona,
        severity,
        title,
        section,
        lines,
        finding,
        suggestion,
        ...(Object.keys(extra).length ? { extra } : {}),
      });
    }
    reviewers.push({
      key: req.key,
      stage: req.stage,
      persona: req.persona,
      instance: req.instance,
      status: "completed",
      attempts: o.attempts,
      findingCount: ids.length,
    });
    if (req.persona === "comprehension") {
      comprehension.push({
        key: req.key,
        instance: req.instance,
        whatThisProposes: v.whatThisProposes ?? "",
        howExistingSystemWorks: v.howExistingSystemWorks ?? "",
        findingIds: ids,
      });
    }
    if (req.persona === "inventive-catalyst" && v.noFalseCompromise) {
      noFalseCompromise.push(req.key);
    }
  }
  const severityCounts: Findings["severityCounts"] = {};
  for (const s of plan.stages) {
    severityCounts[String(s)] = { Blocker: 0, Major: 0, Nit: 0 };
  }
  for (const f of rawFindings) severityCounts[String(f.stage)][f.severity]++;

  const findings: Findings = {
    batch: plan.batch,
    retryBatch,
    reviewers,
    rawFindings,
    comprehension,
    inventiveNoFalseCompromise: noFalseCompromise,
    retryRequests,
    severityCounts,
    synthesisPrompt: buildSynthesisPrompt(plan, rawFindings),
    synthesisSchema: SYNTHESIS_SCHEMA,
    costUsd,
    timestamp: new Date().toISOString(),
  };
  const notRun = reviewers.filter((r) => r.status === "not_run").length;
  ctx.logger.info(
    "{done}/{total} reviewers completed, {f} findings, {retry} queued for retry",
    {
      done: reviewers.length - notRun,
      total: reviewers.length,
      f: rawFindings.length,
      retry: retryRequests.length,
    },
  );
  const handle = await ctx.writeResource(
    "findings",
    "findings",
    FindingsSchema.parse(findings),
  );
  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------- reports

const WriteArgs = z.object({
  synthesis: z.unknown().describe(
    "Structured synthesizer answer (matching synthesisSchema), passed in through CEL",
  ),
});

const SEV_ICON = { Blocker: "🔴", Major: "🟡", Nit: "🟢" } as const;

function statusTable(
  reviewers: Findings["reviewers"],
  stage?: number,
): string[] {
  const rows = reviewers.filter((r) =>
    stage === undefined || r.stage === stage
  );
  return [
    stage === undefined
      ? "| Stage | Reviewer | Instance | Status | Attempts | Findings |"
      : "| Reviewer | Instance | Status | Attempts | Findings |",
    stage === undefined
      ? "| --- | --- | --- | --- | --- | --- |"
      : "| --- | --- | --- | --- | --- |",
    ...rows.map((r) => {
      const status = r.status === "completed" ? "completed" : "not run";
      const cells = [
        `\`egm-${r.persona}\``,
        r.instance,
        status,
        String(r.attempts),
        String(r.findingCount),
      ];
      return `| ${stage === undefined ? `${r.stage} | ` : ""}${
        cells.join(" | ")
      } |`;
    }),
  ];
}

function stageReport(
  plan: ReviewPlan,
  findings: Findings,
  syn: Synthesis,
  stage: number,
): string {
  const def = STAGES[stage];
  const range = stageRange(
    def.range,
    {
      featureRange: plan.featureRange,
      detailedRange: plan.detailedRange,
    } as Split,
    plan.lineCount,
  );
  const out = [
    "# Goldfish Review Report",
    "",
    `**Target:** \`${plan.targetDisplay}\` (\`${
      rangeLabel(range, plan.lineCount)
    }\`)`,
    `**Stage:** ${stage} (${def.name})`,
    "",
    "## Reviewer Status",
    "",
    ...statusTable(findings.reviewers, stage),
    "",
  ];
  if (stage === 5) {
    const ic = findings.reviewers.filter((r) =>
      r.persona === "inventive-catalyst" && r.status === "completed"
    );
    if (
      ic.length > 0 &&
      ic.every((r) => findings.inventiveNoFalseCompromise.includes(r.key))
    ) {
      out.push("**Inventive catalyst:** No false compromise detected.", "");
    }
  }
  const items = (syn.stages.find((s) => s.stage === stage)?.findings ?? [])
    .slice().sort((a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    );
  out.push("## Prioritized Findings (Blockers -> Major -> Nits)", "");
  if (items.length === 0) out.push("No findings.", "");
  items.forEach((f, i) => {
    out.push(
      `### [Issue ${i + 1}] ${f.title} - Severity: ${f.severity}`,
      "",
      `* **Reviewer Lens:** ${f.personas.map((p) => `\`${p}\``).join(", ")}`,
      `* **Affected Scope:** ${f.scope}`,
      `* **Discrepancy Description:** ${f.description}`,
      `* **Rationale & Recommendation:** ${f.recommendation}`,
      `* **Source findings:** ${f.sourceIds.join(", ")}`,
      "",
    );
  });
  return out.join("\n");
}

function comprehensionReport(plan: ReviewPlan, findings: Findings): string {
  const byId = new Map(findings.rawFindings.map((f) => [f.id, f]));
  const out = [
    "# Comprehension Report",
    "",
    `**Target:** \`${plan.targetDisplay}\` (\`full file\`)`,
    "",
    "## Reviewer Status",
    "",
    ...statusTable(findings.reviewers, 6),
    "",
  ];
  for (const c of findings.comprehension) {
    if (findings.comprehension.length > 1) {
      out.push(`## Instance ${c.instance}`, "");
    }
    out.push(
      "**What this proposes**",
      "",
      c.whatThisProposes,
      "",
      "**How the existing system works, per this document**",
      "",
      c.howExistingSystemWorks,
      "",
      "### Findings",
      "",
    );
    if (c.findingIds.length === 0) out.push("No findings.", "");
    for (const id of c.findingIds) {
      const f = byId.get(id)!;
      out.push(
        `#### ${f.id}: ${f.title} - Severity: ${f.severity}`,
        "",
        `* **Affected Scope:** ${f.section}${
          f.lines ? ` (lines ${f.lines})` : ""
        }`,
        `* **Discrepancy Description:** ${f.finding}`,
        `* **Recommendation:** ${f.suggestion}`,
        "",
      );
    }
  }
  return out.join("\n");
}

function consolidatedReport(
  plan: ReviewPlan,
  findings: Findings,
  syn: Synthesis,
  untraced: string[],
): string {
  const actionFor = new Map<string, string[]>();
  for (const a of syn.consolidated) {
    for (const id of a.sourceIds) {
      actionFor.set(id, [...(actionFor.get(id) ?? []), a.id]);
    }
  }
  const out = [
    "# Consolidated Goldfish Review Report",
    "",
    `**Target:** \`${plan.targetDisplay}\` (${plan.lineCount} lines)`,
    `**Stages:** ${plan.stages.join(", ")} (preset \`${plan.preset}\`)`,
    `**Split:** ${plan.splitStatus}${
      plan.boundaryHeader ? ` at \`${plan.boundaryHeader}\`` : ""
    }; FeatureRange ${plan.featureRange.start}-${plan.featureRange.end}; DetailedRange ${
      rangeLabel(plan.detailedRange, -1)
    }`,
    `**Context files:** ${
      plan.contextFiles.length
        ? plan.contextFiles.map((c) => `\`${c}\``).join(", ")
        : "none"
    }`,
    `**Reviewer cost:** $${findings.costUsd.toFixed(2)}`,
    "",
  ];
  if (plan.warnings.length) {
    out.push("## Warnings", "", ...plan.warnings.map((w) => `* ${w}`), "");
  }
  if (plan.excludedLinks.length) {
    out.push(
      "## Excluded links",
      "",
      ...plan.excludedLinks.map((l) => `* \`${l.link}\`: ${l.reason}`),
      "",
    );
  }
  out.push("## Reviewer Status", "", ...statusTable(findings.reviewers), "");
  out.push("## Action Items", "");
  for (const sev of ["Blocker", "Major", "Nit"] as const) {
    const items = syn.consolidated.filter((a) => a.priority === sev);
    out.push(`### ${SEV_ICON[sev]} ${sev} (${items.length})`, "");
    for (const a of items) {
      out.push(
        `#### ${a.id}: ${a.title}`,
        "",
        `* **Action:** ${a.action}`,
        `* **Rationale:** ${a.rationale}`,
        `* **Source findings:** ${a.sourceIds.join(", ")}`,
        "",
      );
    }
  }
  if (untraced.length) {
    const byId = new Map(findings.rawFindings.map((f) => [f.id, f]));
    out.push(
      "## Untraced findings",
      "",
      "The synthesizer mapped these raw findings to no action item. They are listed here so nothing is dropped.",
      "",
    );
    for (const id of untraced) {
      const f = byId.get(id)!;
      out.push(
        `* **${f.id}** (stage ${f.stage}, \`egm-${f.persona}\`, ${f.severity}): ${f.title}. ${f.finding}`,
      );
    }
    out.push("");
  }
  out.push(
    "## Traceability Matrix",
    "",
    "| Finding | Stage | Reviewer | Severity | Action item |",
    "| --- | --- | --- | --- | --- |",
    ...findings.rawFindings.map((f) =>
      `| ${f.id} | ${f.stage} | \`egm-${f.persona}\` | ${f.severity} | ${
        (actionFor.get(f.id) ?? ["UNTRACED"]).join(", ")
      } |`
    ),
    "",
  );
  return out.join("\n");
}

async function writeReports(
  rawArgs: z.input<typeof WriteArgs>,
  ctx: Ctx,
): Promise<{ dataHandles: { name: string }[] }> {
  const args = WriteArgs.parse(rawArgs);
  ctx.logger.info("writing EGM review reports");
  if (!ctx.readResource) throw new Error("writeReports needs readResource");
  const planRaw = await ctx.readResource("reviewPlan");
  const findingsRaw = await ctx.readResource("findings");
  if (!planRaw || !findingsRaw) {
    throw new Error("Run prepare and collectFindings before writeReports.");
  }
  const plan = ReviewPlanSchema.parse(planRaw);
  const findings = FindingsSchema.parse(findingsRaw);
  const synR = SynthesisSchema.safeParse(args.synthesis);
  if (!synR.success) {
    throw new Error(
      `synthesizer answer does not match the schema: ${
        synR.error.message.slice(0, 800)
      }`,
    );
  }
  const syn = synR.data;
  const traced = new Set(syn.consolidated.flatMap((a) => a.sourceIds));
  const untraced = findings.rawFindings.map((f) => f.id).filter((id) =>
    !traced.has(id)
  );

  await Deno.mkdir(plan.outputDir, { recursive: true });
  const files: { stage: number; path: string }[] = [];
  for (const s of plan.stages) {
    const path = `${plan.outputDir}/${STAGES[s].report}`;
    const body = s === 6
      ? comprehensionReport(plan, findings)
      : stageReport(plan, findings, syn, s);
    await Deno.writeTextFile(path, body);
    files.push({ stage: s, path });
  }
  const consolidatedPath = `${plan.outputDir}/consolidated_review_report.md`;
  await Deno.writeTextFile(
    consolidatedPath,
    consolidatedReport(plan, findings, syn, untraced),
  );

  const totals = { Blocker: 0, Major: 0, Nit: 0 };
  for (const a of syn.consolidated) totals[a.priority]++;
  const warnings = [...plan.warnings];
  if (untraced.length) {
    warnings.push(`${untraced.length} raw findings were left untraced`);
  }
  const reports = {
    files,
    consolidatedReportPath: consolidatedPath,
    untracedFindingIds: untraced,
    severityTotals: totals,
    actionItems: syn.consolidated.length,
    reviewersNotRun: findings.reviewers.filter((r) => r.status === "not_run")
      .map((r) => r.key),
    warnings,
    timestamp: new Date().toISOString(),
  };
  ctx.logger.info("wrote {n} reports; {b} blocker / {m} major / {t} nit", {
    n: files.length + 1,
    b: totals.Blocker,
    m: totals.Major,
    t: totals.Nit,
  });
  const handle = await ctx.writeResource(
    "reports",
    "reports",
    ReportsSchema.parse(reports),
  );
  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------- model

/** Behavior definition for @sntxrr/egm. */
export const model = {
  type: "@sntxrr/egm",
  version: "2026.11.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    reviewPlan: {
      description:
        "Split, stages, context files and one isolated prompt per Goldfish reviewer",
      schema: ReviewPlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    findings: {
      description:
        "Validated reviewer findings with stable ids, reviewer status, retry list and the synthesizer prompt",
      schema: FindingsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    reports: {
      description:
        "Paths of the written reports, severity totals and untraced findings",
      schema: ReportsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    prepare: {
      description:
        "Read the design document, find the feature/implementation split, resolve context files, and build one isolated Goldfish prompt per (stage, persona, instance).",
      arguments: PrepareArgs,
      execute: prepare,
    },
    collectFindings: {
      description:
        "Validate the reviewers' structured answers from the claude batch, number the findings, mark reviewers completed or not run, queue one retry for failures, and build the synthesizer prompt.",
      arguments: CollectArgs,
      execute: collectFindings,
    },
    writeReports: {
      description:
        "Write the per-stage reports, comprehension_report.md (paraphrase verbatim) and consolidated_review_report.md with a traceability matrix; untraced findings are listed, never dropped.",
      arguments: WriteArgs,
      execute: writeReports,
    },
  },
};
