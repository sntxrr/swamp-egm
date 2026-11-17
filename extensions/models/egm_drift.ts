/**
 * EGM drift report as a swamp behavior: checks design documents and READMEs
 * against the code they describe.
 *
 * `prepare` lists the documents and builds one isolated request per document.
 * Each request runs through `@keeb/anthropic/claude`'s
 * `cli_generate_many_tools` with read-only tools (Read, Grep, Glob) confined
 * to the repo root, and answers with schema-checked drift items.
 * `collectFindings` validates the answers and, optionally, lists source files
 * no document mentions. `writeReport` writes `{YYYY-MM-DD}_DRIFT_REPORT.md` in
 * upstream egm-drift-report's strict per-document format and records
 * per-document drift counts against the previous run, so a scheduled run can
 * fail on new drift.
 *
 * Upstream: https://github.com/google/elephant-goldfish-model (Apache-2.0).
 *
 * @module
 */
import { z } from "npm:zod@4";
import { expandGlob } from "jsr:@std/fs@1.0.24/expand-glob";
import { globToRegExp } from "jsr:@std/path@1.1.6/glob-to-regexp";
import { READONLY_TOOLS } from "./egm_claude_tools.ts";

// ---------------------------------------------------------------- schemas

const GlobalArgsSchema = z.object({
  repoRoot: z.string().describe(
    "Source tree root. Reviewers run here with read-only tools and are confined to it.",
  ),
  docsDir: z.string().describe(
    "Directory holding the design documents or READMEs, absolute or relative to repoRoot",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Drift categories, from upstream egm-drift-report. */
export const DRIFT_CATEGORIES = [
  "missing_feature",
  "incomplete_model",
  "logic_shortcut",
  "architectural_divergence",
  "unreferenced_logic",
] as const;

const DriftItemSchema = z.object({
  category: z.enum(DRIFT_CATEGORIES),
  description: z.string().min(1),
  docRef: z.string(),
  codeRef: z.string(),
});

/** One document's answer. */
export const DocAnswerSchema = z.object({
  noDrift: z.boolean(),
  items: z.array(DriftItemSchema),
  missingLinks: z.array(z.object({
    symbol: z.string(),
    suggestedPath: z.string(),
  })).default([]),
  codeFilesExamined: z.array(z.string()).default([]),
});

/** JSON Schema given to each reviewer. */
export const DOC_ANSWER_JSON: Record<string, unknown> = {
  type: "object",
  properties: {
    noDrift: { type: "boolean" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: [...DRIFT_CATEGORIES] },
          description: { type: "string" },
          docRef: { type: "string" },
          codeRef: { type: "string" },
        },
        required: ["category", "description", "docRef", "codeRef"],
      },
    },
    missingLinks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          suggestedPath: { type: "string" },
        },
        required: ["symbol", "suggestedPath"],
      },
    },
    codeFilesExamined: { type: "array", items: { type: "string" } },
  },
  required: ["noDrift", "items", "missingLinks", "codeFilesExamined"],
};

const DocSchema = z.object({
  key: z.string(),
  relPath: z.string(),
  absPath: z.string(),
  bytes: z.number(),
  sha256: z.string(),
});

const DriftPlanSchema = z.object({
  batch: z.string(),
  repoRoot: z.string(),
  docsDir: z.string(),
  docs: z.array(DocSchema),
  docCount: z.number(),
  sourceFiles: z.array(z.string()),
  requests: z.array(z.object({
    key: z.string(),
    prompt: z.string(),
    jsonSchema: z.record(z.string(), z.unknown()),
    tools: z.array(z.string()),
  })),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  timestamp: z.string(),
});

type DriftPlan = z.infer<typeof DriftPlanSchema>;

const PerDocSchema = z.object({
  doc: z.string(),
  status: z.enum(["ok", "error"]),
  error: z.string().optional(),
  noDrift: z.boolean(),
  items: z.array(DriftItemSchema),
  missingLinks: z.array(z.object({
    symbol: z.string(),
    suggestedPath: z.string(),
  })),
  codeFilesExamined: z.array(z.string()),
});

const DriftFindingsSchema = z.object({
  batch: z.string(),
  perDoc: z.array(PerDocSchema),
  coverage: z.object({
    checked: z.boolean(),
    unreferencedFiles: z.array(z.string()),
  }),
  totals: z.object({
    docs: z.number(),
    docsWithDrift: z.number(),
    driftItems: z.number(),
    errors: z.number(),
    byCategory: z.record(z.string(), z.number()),
  }),
  costUsd: z.number(),
  timestamp: z.string(),
});

type DriftFindings = z.infer<typeof DriftFindingsSchema>;

const DriftReportSchema = z.object({
  path: z.string(),
  date: z.string(),
  sha256: z.string(),
  perDocCounts: z.record(z.string(), z.number()),
  totalDrift: z.number(),
  errors: z.array(z.string()),
  previousPerDocCounts: z.record(z.string(), z.number()).nullable(),
  newDriftDocs: z.array(z.object({
    doc: z.string(),
    previous: z.number(),
    current: z.number(),
  })),
  newDriftCount: z.number(),
  resolvedDocs: z.array(z.string()),
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

/** A request key from a document path: index plus a short slug. Exported for tests. */
export function docKey(index: number, relPath: string): string {
  const slug = relPath.toLowerCase().replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `d${String(index + 1).padStart(3, "0")}${slug ? `-${slug}` : ""}`;
}

function excluded(rel: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(rel));
}

async function listFiles(
  root: string,
  glob: string,
  exclude: RegExp[],
): Promise<string[]> {
  const out: string[] = [];
  for await (
    const e of expandGlob(glob, { root, includeDirs: false, globstar: true })
  ) {
    if (!e.isFile) continue;
    const rel = relTo(root, e.path);
    if (!excluded(rel, exclude)) out.push(e.path);
  }
  return out.sort();
}

/** Builds one document's drift prompt, from upstream egm-drift-report step 3. Exported for tests. */
export function buildDriftPrompt(relPath: string, text: string): string {
  return [
    "You are checking one design document against the current source code. You have Read, Grep and Glob, rooted at the repository. You cannot change anything.",
    "",
    "Goal: find every place where the code has diverged from, or failed to implement, what this document specifies.",
    "",
    "1. Contextualize: read the document below. Identify its intent, the proposed changes, and the specific file names and symbols it mentions.",
    "2. Locate source: find the matching source files. If the document gives no paths, use Grep and Glob to find the classes, functions or API endpoints it mentions. For each symbol you had to search for, add a missingLinks entry suggesting the path the document should link to.",
    "3. Verify: read the current state of those files. Do not rely on memory.",
    "4. Detect drift. Look for:",
    "   - missing_feature: logic described in the document but absent from the code.",
    "   - incomplete_model: classes, structs, dataclasses or protos missing fields the document specifies.",
    "   - logic_shortcut: hard-coded values where the document planned dynamic logic.",
    "   - architectural_divergence: the code uses different patterns or libraries than proposed.",
    "   - unreferenced_logic: logic in the document's area that the document does not describe.",
    "5. Filter: report ONLY differences. Do not describe what matches. If the code matches the document, set noDrift to true and return no items.",
    "",
    "Be rigorous. If the document names an object, field or file and the code lacks it, that is drift. docRef is the document section or line; codeRef is file:line or file#symbol (or 'absent').",
    "",
    `## Document: ${relPath}`,
    "",
    "```markdown",
    text,
    "```",
    "",
    "List every source file you read in codeFilesExamined (paths relative to the repository root).",
    "Respond only with JSON that matches the provided schema.",
  ].join("\n");
}

// ---------------------------------------------------------------- prepare

const PrepareArgs = z.object({
  glob: z.string().default("**/*.md").describe(
    "Document glob, relative to docsDir",
  ),
  excludeGlobs: z.array(z.string()).default([
    "**/node_modules/**",
    "**/vendor/**",
    "**/.git/**",
  ]).describe("Globs excluded from document and source listings"),
  sourceGlob: z.string().default("").describe(
    "Optional source glob (relative to repoRoot) for the repo-wide unreferenced-file check; empty skips it",
  ),
  maxDocBytes: z.number().int().positive().default(200_000).describe(
    "Documents larger than this are skipped and listed",
  ),
});

async function prepare(
  rawArgs: z.input<typeof PrepareArgs>,
  ctx: Ctx,
): Promise<{ dataHandles: { name: string }[] }> {
  const args = PrepareArgs.parse(rawArgs);
  ctx.logger.info("listing documents in {docsDir}", {
    docsDir: ctx.globalArgs.docsDir,
  });
  const repoRoot = await Deno.realPath(ctx.globalArgs.repoRoot);
  const docsDir = await Deno.realPath(
    resolvePath(repoRoot, ctx.globalArgs.docsDir),
  );
  if (!(await Deno.stat(docsDir)).isDirectory) {
    throw new Error(`docsDir is not a directory: ${ctx.globalArgs.docsDir}`);
  }
  const exclude = args.excludeGlobs.map((g) =>
    globToRegExp(g, { globstar: true, extended: true })
  );
  const skipped: { path: string; reason: string }[] = [];
  const docs: DriftPlan["docs"] = [];
  const requests: DriftPlan["requests"] = [];
  for (const abs of await listFiles(docsDir, args.glob, exclude)) {
    const rel = relTo(repoRoot, abs);
    const text = await Deno.readTextFile(abs);
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > args.maxDocBytes) {
      skipped.push({
        path: rel,
        reason: `larger than ${args.maxDocBytes} bytes`,
      });
      continue;
    }
    if (text.trim() === "") {
      skipped.push({ path: rel, reason: "empty" });
      continue;
    }
    const key = docKey(docs.length, rel);
    docs.push({
      key,
      relPath: rel,
      absPath: abs,
      bytes,
      sha256: await sha256(text),
    });
    requests.push({
      key,
      prompt: buildDriftPrompt(rel, text),
      jsonSchema: DOC_ANSWER_JSON,
      tools: [...READONLY_TOOLS],
    });
  }
  let sourceFiles: string[] = [];
  if (args.sourceGlob) {
    sourceFiles = (await listFiles(repoRoot, args.sourceGlob, exclude))
      .filter((p) => !p.startsWith(`${docsDir}/`))
      .map((p) => relTo(repoRoot, p));
  }
  const plan: DriftPlan = {
    batch: `drift-${crypto.randomUUID().slice(0, 8)}`,
    repoRoot,
    docsDir,
    docs,
    docCount: docs.length,
    sourceFiles,
    requests,
    skipped,
    timestamp: new Date().toISOString(),
  };
  ctx.logger.info("found {n} documents ({s} skipped)", {
    n: docs.length,
    s: skipped.length,
  });
  const handle = await ctx.writeResource(
    "plan",
    "plan",
    DriftPlanSchema.parse(plan),
  );
  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------- collect

const CollectArgs = z.object({
  resultsModel: z.string().default("egm-drift-claude").describe(
    "Name of the @keeb/anthropic/claude instance that ran the batch",
  ),
});

/** Paths in sourceFiles that no document, item or examined-file list mentions. Exported for tests. */
export function unreferencedFiles(
  sourceFiles: string[],
  docTexts: string[],
  perDoc: { items: { codeRef: string }[]; codeFilesExamined: string[] }[],
): string[] {
  const haystack = [
    ...docTexts,
    ...perDoc.flatMap((d) => [
      ...d.codeFilesExamined,
      ...d.items.map((i) => i.codeRef),
    ]),
  ].join("\n");
  return sourceFiles.filter((f) => {
    const base = f.split("/").pop()!;
    return !haystack.includes(f) && !haystack.includes(base);
  });
}

async function collectFindings(
  rawArgs: z.input<typeof CollectArgs>,
  ctx: Ctx,
): Promise<{ dataHandles: { name: string }[] }> {
  const args = CollectArgs.parse(rawArgs);
  ctx.logger.info("collecting drift results from {model}", {
    model: args.resultsModel,
  });
  if (!ctx.readResource || !ctx.readModelData) {
    throw new Error("collectFindings needs readResource and readModelData");
  }
  const planRaw = await ctx.readResource("plan");
  if (!planRaw) throw new Error("No plan data; run prepare first.");
  const plan = DriftPlanSchema.parse(planRaw);
  const results = new Map<string, Record<string, unknown>>();
  for (const r of await ctx.readModelData(args.resultsModel, "cliResult")) {
    if (r.attributes.batch === plan.batch) {
      results.set(String(r.attributes.key), r.attributes);
    }
  }
  const perDoc: DriftFindings["perDoc"] = [];
  let costUsd = 0;
  for (const d of plan.docs) {
    const rec = results.get(d.key);
    costUsd += Number(rec?.costUsd ?? 0);
    const fail = (error: string) =>
      perDoc.push({
        doc: d.relPath,
        status: "error",
        error,
        noDrift: false,
        items: [],
        missingLinks: [],
        codeFilesExamined: [],
      });
    if (!rec) {
      fail("no result recorded");
      continue;
    }
    if (rec.ok !== true) {
      fail(String(rec.error ?? "claude call failed"));
      continue;
    }
    let candidate = rec.structured;
    if (candidate === undefined || candidate === null) {
      try {
        candidate = JSON.parse(
          String(rec.response ?? "").trim().replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, ""),
        );
      } catch {
        fail("answer is not JSON");
        continue;
      }
    }
    const parsed = DocAnswerSchema.safeParse(candidate);
    if (!parsed.success) {
      fail(`schema: ${parsed.error.message.slice(0, 400)}`);
      continue;
    }
    const v = parsed.data;
    if (v.noDrift && v.items.length > 0) {
      fail("noDrift is true but items are listed");
      continue;
    }
    perDoc.push({
      doc: d.relPath,
      status: "ok",
      noDrift: v.items.length === 0,
      items: v.items,
      missingLinks: v.missingLinks,
      codeFilesExamined: v.codeFilesExamined,
    });
  }
  let unref: string[] = [];
  if (plan.sourceFiles.length > 0) {
    const texts = await Promise.all(
      plan.docs.map((d) => Deno.readTextFile(d.absPath).catch(() => "")),
    );
    unref = unreferencedFiles(plan.sourceFiles, texts, perDoc);
  }
  const byCategory: Record<string, number> = Object.fromEntries(
    DRIFT_CATEGORIES.map((c) => [c, 0]),
  );
  for (const d of perDoc) for (const i of d.items) byCategory[i.category]++;
  const findings: DriftFindings = {
    batch: plan.batch,
    perDoc,
    coverage: {
      checked: plan.sourceFiles.length > 0,
      unreferencedFiles: unref,
    },
    totals: {
      docs: perDoc.length,
      docsWithDrift: perDoc.filter((d) => d.items.length > 0).length,
      driftItems: perDoc.reduce((n, d) => n + d.items.length, 0),
      errors: perDoc.filter((d) => d.status === "error").length,
      byCategory,
    },
    costUsd,
    timestamp: new Date().toISOString(),
  };
  ctx.logger.info("{d} drift items across {n} documents, {e} errors", {
    d: findings.totals.driftItems,
    n: findings.totals.docs,
    e: findings.totals.errors,
  });
  const handle = await ctx.writeResource(
    "findings",
    "findings",
    DriftFindingsSchema.parse(findings),
  );
  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------- report

const WriteArgs = z.object({
  reportDir: z.string().default("").describe(
    "Directory for the dated report; empty means repoRoot",
  ),
  reportDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).default("").describe(
    "YYYY-MM-DD for the file name; empty means today (UTC)",
  ),
  append: z.boolean().default(false).describe(
    "Append to an existing report for the same date instead of rewriting it",
  ),
});

/** Renders the strict upstream report body. Exported for tests. */
export function renderDriftReport(f: DriftFindings): string {
  const out: string[] = [];
  for (const d of f.perDoc) {
    out.push(`## ${d.doc}`, "");
    if (d.status === "error") {
      out.push(`- [error] analysis failed: ${d.error}`);
    } else if (d.items.length === 0) {
      out.push("No drift detected.");
    } else {
      for (const i of d.items) {
        out.push(
          `- [${i.category}] ${i.description} (doc: ${i.docRef}; code: ${i.codeRef})`,
        );
      }
    }
    out.push("");
  }
  if (f.coverage.checked && f.coverage.unreferencedFiles.length > 0) {
    out.push(
      "## Unreferenced code (no design doc)",
      "",
      ...f.coverage.unreferencedFiles.map((p) => `- ${p}`),
      "",
    );
  }
  return out.join("\n");
}

/** Compares counts with the previous run. Exported for tests. */
export function diffCounts(
  previous: Record<string, number> | null,
  current: Record<string, number>,
): {
  newDriftDocs: { doc: string; previous: number; current: number }[];
  resolvedDocs: string[];
} {
  const newDriftDocs = Object.entries(current)
    .filter(([doc, n]) => n > (previous?.[doc] ?? 0))
    .map(([doc, n]) => ({ doc, previous: previous?.[doc] ?? 0, current: n }));
  const resolvedDocs = previous
    ? Object.entries(previous)
      .filter(([doc, n]) => n > 0 && current[doc] === 0)
      .map(([doc]) => doc)
    : [];
  return { newDriftDocs, resolvedDocs };
}

async function writeReport(
  rawArgs: z.input<typeof WriteArgs>,
  ctx: Ctx,
): Promise<{ dataHandles: { name: string }[] }> {
  const args = WriteArgs.parse(rawArgs);
  ctx.logger.info("writing drift report");
  if (!ctx.readResource) throw new Error("writeReport needs readResource");
  const planRaw = await ctx.readResource("plan");
  const findingsRaw = await ctx.readResource("findings");
  if (!planRaw || !findingsRaw) {
    throw new Error("Run prepare and collectFindings before writeReport.");
  }
  const plan = DriftPlanSchema.parse(planRaw);
  const findings = DriftFindingsSchema.parse(findingsRaw);
  if (findings.batch !== plan.batch) {
    throw new Error(
      "findings belong to an older batch; re-run collectFindings",
    );
  }
  const prevRaw = await ctx.readResource("report");
  const previous = prevRaw
    ? DriftReportSchema.shape.perDocCounts.safeParse(prevRaw.perDocCounts)
    : null;
  const date = args.reportDate || new Date().toISOString().slice(0, 10);
  const dir = resolvePath(plan.repoRoot, args.reportDir || ".");
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${date}_DRIFT_REPORT.md`;
  const body = renderDriftReport(findings);
  if (args.append) {
    await Deno.writeTextFile(path, body, { append: true });
  } else {
    await Deno.writeTextFile(path, `# Drift Report ${date}\n\n${body}`);
  }
  const perDocCounts: Record<string, number> = {};
  for (const d of findings.perDoc) {
    if (d.status === "ok") perDocCounts[d.doc] = d.items.length;
  }
  const prevCounts = previous?.success ? previous.data : null;
  const { newDriftDocs, resolvedDocs } = diffCounts(prevCounts, perDocCounts);
  const report = {
    path,
    date,
    sha256: await sha256(await Deno.readTextFile(path)),
    perDocCounts,
    totalDrift: findings.totals.driftItems,
    errors: findings.perDoc.filter((d) => d.status === "error").map((d) =>
      d.doc
    ),
    previousPerDocCounts: prevCounts,
    newDriftDocs,
    newDriftCount: newDriftDocs.length,
    resolvedDocs,
    timestamp: new Date().toISOString(),
  };
  ctx.logger.info(
    "wrote {path}: {n} drift items, {new} documents with new drift",
    {
      path,
      n: report.totalDrift,
      new: newDriftDocs.length,
    },
  );
  const handle = await ctx.writeResource(
    "report",
    "report",
    DriftReportSchema.parse(report),
  );
  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------- model

/** Behavior definition for @sntxrr/egm/drift. */
export const model = {
  type: "@sntxrr/egm/drift",
  version: "2026.11.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    plan: {
      description:
        "Documents found and one isolated read-only request per document",
      schema: DriftPlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    findings: {
      description:
        "Validated drift items per document, coverage gaps and totals",
      schema: DriftFindingsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    report: {
      description:
        "Path of the dated drift report and per-document counts compared with the previous run",
      schema: DriftReportSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },
  methods: {
    prepare: {
      description:
        "List the design documents and build one isolated read-only drift request per document.",
      arguments: PrepareArgs,
      execute: prepare,
    },
    collectFindings: {
      description:
        "Validate each document's drift answer from the claude batch and optionally list source files no document mentions.",
      arguments: CollectArgs,
      execute: collectFindings,
    },
    writeReport: {
      description:
        "Write {YYYY-MM-DD}_DRIFT_REPORT.md in the strict upstream format and record per-document drift counts against the previous run.",
      arguments: WriteArgs,
      execute: writeReport,
    },
  },
};
