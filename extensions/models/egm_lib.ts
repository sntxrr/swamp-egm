/**
 * Pure helpers shared by the @sntxrr/egm behaviors: persona and stage tables,
 * split discovery, markdown link extraction, prompt and schema building, and
 * reviewer-output parsing. Nothing here touches the filesystem or the network,
 * so it is unit-tested directly.
 *
 * Persona prompts and document standards are vendored from
 * https://github.com/google/elephant-goldfish-model (Apache-2.0); see UPSTREAM.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------- personas

/** Reviewer personas: prompt file, and whether it may read the codebase. */
export const PERSONAS = {
  "zoom-out": { file: "zoom_out.md", tools: true },
  "inventive-catalyst": { file: "inventive_catalyst.md", tools: false },
  "comprehension": { file: "comprehension.md", tools: false },
  "design": { file: "design_critic.md", tools: false },
  "structural": { file: "structural.md", tools: false },
  "style": { file: "style.md", tools: false },
  "implementation-readiness": {
    file: "implementation_readiness.md",
    tools: false,
  },
  "codebase-details": { file: "codebase_details.md", tools: true },
} as const;

/** A reviewer persona key, without the upstream `egm-` prefix. */
export type Persona = keyof typeof PERSONAS;

/** Accepts `zoom-out` or upstream's `egm-zoom-out`; throws on anything else. */
export function normalizePersona(name: string): Persona {
  const key = name.replace(/^egm-/, "");
  if (!(key in PERSONAS)) {
    throw new Error(
      `unknown persona "${name}"; expected one of ${
        Object.keys(PERSONAS).join(", ")
      }`,
    );
  }
  return key as Persona;
}

/** Which range of the document a stage reviews. */
export type RangeKind = "full" | "feature" | "detailed" | "feature+detailed";

/** A stage's reviewers, standards, range and report file, per upstream egm-review. */
export interface StageDef {
  name: string;
  range: RangeKind;
  reviewers: Persona[];
  standards: Partial<Record<Persona, string>>;
  report: string;
  context: boolean;
}

/** Stage table, from upstream skills/egm-review/SKILL.md steps 5-9. */
export const STAGES: Record<number, StageDef> = {
  5: {
    name: "Initial Zoom Out",
    range: "full",
    reviewers: ["zoom-out", "inventive-catalyst"],
    standards: { "zoom-out": "zoom-out-standard" },
    report: "zoom_out_report.md",
    context: true,
  },
  6: {
    name: "Comprehension Test",
    range: "feature+detailed",
    reviewers: ["comprehension"],
    standards: {},
    report: "comprehension_report.md",
    context: false,
  },
  7: {
    name: "Critic Review",
    range: "feature",
    reviewers: ["design", "structural", "style"],
    standards: {
      "design": "feature-spec-standard",
      "structural": "feature-spec-standard",
    },
    report: "critic_report.md",
    context: true,
  },
  8: {
    name: "Intermediate Zoom Out",
    range: "full",
    reviewers: ["zoom-out"],
    standards: { "zoom-out": "zoom-out-standard" },
    report: "intermediate_zoom_out_report.md",
    context: true,
  },
  9: {
    name: "Implementation Readiness",
    range: "detailed",
    reviewers: ["implementation-readiness", "codebase-details", "style"],
    standards: {
      "implementation-readiness": "implementation-readiness-standard",
      "codebase-details": "implementation-readiness-standard",
    },
    report: "implementation_readiness_report.md",
    context: true,
  },
};

/** Preset name → stages. Stage 8 is an independent second zoom-out pass. */
export const PRESETS: Record<string, number[]> = {
  uninterrupted: [5, 6, 7, 8, 9],
  feature_spec: [5, 6, 7, 8],
  implementation: [9],
};

/** Resolves the stage list from a preset and an optional explicit override. */
export function resolveStages(preset: string, stages: number[] = []): number[] {
  const picked = stages.length > 0 ? stages : PRESETS[preset];
  if (!picked) {
    throw new Error(
      `unknown preset "${preset}"; expected ${Object.keys(PRESETS).join(", ")}`,
    );
  }
  const out = [...new Set(picked.map(Number))].sort((a, b) => a - b);
  for (const s of out) {
    if (!(s in STAGES)) throw new Error(`stage ${s} is not one of 5-9`);
  }
  return out;
}

// ---------------------------------------------------------------- split

/** An inclusive 1-based line range. */
export interface Range {
  start: number;
  end: number;
}

/** Result of split discovery. */
export interface Split {
  status: "standard" | "ambiguous_resolved" | "manual" | "none" | "bypassed";
  boundaryHeader: string | null;
  featureRange: Range;
  detailedRange: Range | null;
  candidates: { line: number; text: string }[];
  warnings: string[];
}

const SPLIT_RE =
  /^##\s+(Detailed Implementation Plan|Implementation Plan|Work Breakdown|Implementation Steps)\s*$/i;

/** Finds the feature-spec / implementation-plan boundary. Ignores fenced code. */
export function findSplit(
  lines: string[],
  opts: { preset: string; splitLine?: number },
): Split {
  const total = lines.length;
  if (opts.preset === "feature_spec") {
    return {
      status: "bypassed",
      boundaryHeader: null,
      featureRange: { start: 1, end: total },
      detailedRange: null,
      candidates: [],
      warnings: [],
    };
  }
  const candidates: { line: number; text: string }[] = [];
  let fenced = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    else if (!fenced && SPLIT_RE.test(l)) {
      candidates.push({ line: i + 1, text: l.trim() });
    }
  });
  const at = (line: number, status: Split["status"], warnings: string[]) => ({
    status,
    boundaryHeader: lines[line - 1]?.trim() ?? null,
    featureRange: { start: 1, end: Math.max(1, line - 1) },
    detailedRange: { start: line, end: total },
    candidates,
    warnings,
  });
  if (opts.splitLine && opts.splitLine > 0) {
    if (opts.splitLine > total) {
      throw new Error(
        `splitLine ${opts.splitLine} is past the end (${total} lines)`,
      );
    }
    return at(opts.splitLine, "manual", []);
  }
  if (candidates.length === 0) {
    return {
      status: "none",
      boundaryHeader: null,
      featureRange: { start: 1, end: total },
      detailedRange: null,
      candidates,
      warnings: [
        "No implementation-plan header found (## Detailed Implementation Plan or a synonym); stage 9 cannot run.",
      ],
    };
  }
  if (candidates.length === 1) {
    return at(candidates[0].line, "standard", []);
  }
  const preferred =
    candidates.find((c) => /detailed implementation plan/i.test(c.text)) ??
      candidates[0];
  return at(preferred.line, "ambiguous_resolved", [
    `Several split headers (${
      candidates.map((c) => `line ${c.line}`).join(", ")
    }); used line ${preferred.line}. Pass splitLine to choose another.`,
  ]);
}

/** The line range a stage reviews, or null when the document has none. */
export function stageRange(
  kind: RangeKind,
  split: Split,
  total: number,
): Range | null {
  switch (kind) {
    case "full":
    case "feature+detailed":
      return { start: 1, end: total };
    case "feature":
      return split.featureRange;
    case "detailed":
      return split.detailedRange;
  }
}

// ---------------------------------------------------------------- links

/** Markdown link targets (inline and reference definitions), fragments stripped. */
export function extractLinks(markdown: string): string[] {
  const out = new Set<string>();
  const inline = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const refdef = /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/gm;
  for (const re of [inline, refdef]) {
    for (const m of markdown.matchAll(re)) {
      const raw = m[1].trim();
      if (!raw || raw.startsWith("#") || raw.startsWith("mailto:")) continue;
      out.add(raw.split("#")[0]);
    }
  }
  return [...out].filter(Boolean);
}

/** True for absolute URLs (http, https and similar). */
export function isUrl(link: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(link);
}

// ---------------------------------------------------------------- prompts

/** Line-numbered document, with lines outside the active range marked. */
export function numberLines(lines: string[], range: Range | null): string {
  const w = String(lines.length).length;
  return lines.map((l, i) => {
    const n = i + 1;
    const active = !range || (n >= range.start && n <= range.end);
    return `${String(n).padStart(w)}${active ? " | " : " : "}${l}`;
  }).join("\n");
}

/** Inputs to build one reviewer prompt. */
export interface PromptInput {
  personaText: string;
  persona: Persona;
  instance: string;
  stage: number;
  targetPath: string;
  range: Range | null;
  totalLines: number;
  standardName?: string;
  standardText?: string;
  documentLines: string[];
  context: { path: string; content: string }[];
  tools: boolean;
}

/** Builds a Goldfish prompt: persona, standard, document and context only. */
export function buildReviewPrompt(p: PromptInput): string {
  const range =
    p.range && !(p.range.start === 1 && p.range.end === p.totalLines)
      ? `${p.range.start}-${p.range.end}`
      : "full file";
  const parts = [
    p.personaText.trim(),
    "---",
    "Mode: REVIEW",
    `Reviewer: egm-${p.persona} (instance ${p.instance})`,
    `Stage: ${p.stage} (${STAGES[p.stage].name})`,
    `TargetFile: ${p.targetPath}`,
    `LineRange: ${range}`,
  ];
  if (p.standardName && p.standardText) {
    parts.push(
      `Target Standard: ${p.standardName}`,
      "",
      p.standardText.trim(),
    );
  }
  parts.push(
    "",
    "## Document",
    "",
    "Lines marked `|` are in your LineRange; lines marked `:` are outside it and are shown only for reference. Review only the LineRange.",
    "",
    "```text",
    numberLines(p.documentLines, p.range),
    "```",
  );
  if (p.context.length > 0) {
    parts.push("", "## GoldfishContext", "");
    for (const c of p.context) {
      parts.push(`### ${c.path}`, "", "```text", c.content, "```", "");
    }
  }
  parts.push(
    "",
    "## Output contract",
    "",
    p.tools
      ? "You may use Read, Grep and Glob to inspect the codebase in your working directory. You cannot and must not change anything."
      : "You have no tools. Use only the material above.",
    "You have not seen any other reviewer's output or any conversation about this document. Do not assume context you were not given.",
    'Report each finding with a severity of "Blocker", "Major" or "Nit", the section and line numbers it concerns, what is wrong, and a concrete suggestion. If you find nothing, set noFindings to true and return an empty findings list.',
    "Respond only with JSON that matches the provided schema.",
  );
  return parts.join("\n");
}

const FindingJson = {
  type: "object",
  properties: {
    severity: { type: "string", enum: ["Blocker", "Major", "Nit"] },
    title: { type: "string" },
    section: { type: "string" },
    lines: { type: "string" },
    finding: { type: "string" },
    suggestion: { type: "string" },
  },
  required: ["severity", "title", "section", "finding", "suggestion"],
} as const;

/** JSON Schema each reviewer must answer with. */
export function reviewerSchema(persona: Persona): Record<string, unknown> {
  const finding: Record<string, unknown> = structuredClone(FindingJson);
  const props: Record<string, unknown> = {
    noFindings: { type: "boolean" },
    findings: { type: "array", items: finding },
  };
  const required = ["noFindings", "findings"];
  if (persona === "comprehension") {
    props.whatThisProposes = { type: "string" };
    props.howExistingSystemWorks = { type: "string" };
    required.push("whatThisProposes", "howExistingSystemWorks");
  }
  if (persona === "inventive-catalyst") {
    props.noFalseCompromise = { type: "boolean" };
    (finding.properties as Record<string, unknown>).falseCompromise = {
      type: "string",
    };
    (finding.properties as Record<string, unknown>).proposedResolution = {
      type: "string",
    };
    (finding.properties as Record<string, unknown>).secondaryLiabilities = {
      type: "string",
    };
    required.push("noFalseCompromise");
  }
  return { type: "object", properties: props, required };
}

// ---------------------------------------------------------------- parsing

/** One finding as a reviewer returns it. */
export const FindingSchema = z.object({
  severity: z.enum(["Blocker", "Major", "Nit"]),
  title: z.string(),
  section: z.string(),
  lines: z.string().optional(),
  finding: z.string(),
  suggestion: z.string(),
}).passthrough();

/** A reviewer's whole answer. */
export const ReviewerOutputSchema = z.object({
  noFindings: z.boolean(),
  findings: z.array(FindingSchema),
  whatThisProposes: z.string().optional(),
  howExistingSystemWorks: z.string().optional(),
  noFalseCompromise: z.boolean().optional(),
}).passthrough();

/** A parsed reviewer answer. */
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

/** Validates a reviewer result (structured first, else JSON in the text). */
export function parseReviewerOutput(
  rec: { structured?: unknown; response?: string },
  persona: Persona,
): { ok: true; value: ReviewerOutput } | { ok: false; error: string } {
  let candidate: unknown = rec.structured;
  if (candidate === undefined || candidate === null) {
    const text = (rec.response ?? "").trim()
      .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      candidate = JSON.parse(text);
    } catch {
      return { ok: false, error: "reviewer answer is not JSON" };
    }
  }
  const r = ReviewerOutputSchema.safeParse(candidate);
  if (!r.success) {
    return { ok: false, error: `schema: ${r.error.message.slice(0, 500)}` };
  }
  if (
    persona === "comprehension" &&
    (!r.data.whatThisProposes || !r.data.howExistingSystemWorks)
  ) {
    return {
      ok: false,
      error: "comprehension answer is missing the paraphrase",
    };
  }
  if (r.data.noFindings && r.data.findings.length > 0) {
    return { ok: false, error: "noFindings is true but findings are listed" };
  }
  return { ok: true, value: r.data };
}

/** JSON Schema for the synthesizer's answer. */
export const SYNTHESIS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    stages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          stage: { type: "integer" },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                severity: { type: "string", enum: ["Blocker", "Major", "Nit"] },
                personas: { type: "array", items: { type: "string" } },
                scope: { type: "string" },
                description: { type: "string" },
                recommendation: { type: "string" },
                sourceIds: { type: "array", items: { type: "string" } },
              },
              required: [
                "title",
                "severity",
                "personas",
                "scope",
                "description",
                "recommendation",
                "sourceIds",
              ],
            },
          },
        },
        required: ["stage", "findings"],
      },
    },
    consolidated: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          priority: { type: "string", enum: ["Blocker", "Major", "Nit"] },
          title: { type: "string" },
          action: { type: "string" },
          rationale: { type: "string" },
          sourceIds: { type: "array", items: { type: "string" } },
        },
        required: [
          "id",
          "priority",
          "title",
          "action",
          "rationale",
          "sourceIds",
        ],
      },
    },
  },
  required: ["stages", "consolidated"],
};

/** Zod mirror of SYNTHESIS_SCHEMA. */
export const SynthesisSchema = z.object({
  stages: z.array(z.object({
    stage: z.number().int(),
    findings: z.array(z.object({
      title: z.string(),
      severity: z.enum(["Blocker", "Major", "Nit"]),
      personas: z.array(z.string()),
      scope: z.string(),
      description: z.string(),
      recommendation: z.string(),
      sourceIds: z.array(z.string()),
    })),
  })),
  consolidated: z.array(z.object({
    id: z.string(),
    priority: z.enum(["Blocker", "Major", "Nit"]),
    title: z.string(),
    action: z.string(),
    rationale: z.string(),
    sourceIds: z.array(z.string()),
  })),
});

/** Parsed synthesizer answer. */
export type Synthesis = z.infer<typeof SynthesisSchema>;

/** Severity sort order. */
export const SEVERITY_ORDER = { Blocker: 0, Major: 1, Nit: 2 } as const;

/** Upstream's plain-English constraints, condensed for the synthesizer. */
export const EXECUTION_CONSTRAINTS = [
  "Write in plain, direct English. No promotional adjectives or decorative adverbs.",
  "Lead with what is wrong, missing or risky. Do not flatter.",
  'Never use "great", "brilliant", "smart", "correct", "perfect", "excellent" or "spot-on" about the document or its author.',
  "Do not apologise.",
].join("\n");
