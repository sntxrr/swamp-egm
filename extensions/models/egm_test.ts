// Tests for egm_lib.ts and the @sntxrr/egm review behavior. No claude calls:
// reviewer answers are injected as fake cliResult records.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  buildReviewPrompt,
  extractLinks,
  findSplit,
  normalizePersona,
  parseReviewerOutput,
  PERSONAS,
  resolveStages,
  reviewerSchema,
} from "./egm_lib.ts";
import { model as review } from "./egm.ts";

// ---------------------------------------------------------------- fake ctx

type Rec = { name: string; specName?: string; attributes: Record<string, unknown> };

function fakeCtx(
  globalArgs: Record<string, unknown>,
  other: Record<string, Rec[]> = {},
) {
  const own = new Map<string, Record<string, unknown>>();
  const ctx = {
    globalArgs,
    logger: { info: () => {}, warning: () => {} },
    writeResource: (_spec: string, name: string, data: Record<string, unknown>) => {
      own.set(name, structuredClone(data));
      return Promise.resolve({ name });
    },
    readResource: (name: string) => Promise.resolve(own.get(name) ?? null),
    readModelData: (m: string, spec?: string) =>
      Promise.resolve(
        (other[m] ?? []).filter((r) => !spec || (r.specName ?? "cliResult") === spec),
      ),
  };
  return { ctx, own, other };
}

// deno-lint-ignore no-explicit-any
const run = (method: { execute: any }, args: unknown, ctx: unknown) =>
  method.execute(args, ctx);

const DOC = [
  "# Widget service",
  "",
  "Widgets are cached. See [the cache](cache.md) and [outside](../../etc/hosts) and [web](https://example.com/x).",
  "",
  "```md",
  "## Implementation Plan",
  "```",
  "",
  "## Detailed Implementation Plan",
  "",
  "1. Add `WidgetCache` in src/cache.ts.",
].join("\n");

async function repoWithDoc(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "egm-test-" });
  await Deno.writeTextFile(`${dir}/design.md`, DOC + "\n");
  await Deno.writeTextFile(`${dir}/cache.md`, "cache notes\n");
  return dir;
}

// ---------------------------------------------------------------- lib

Deno.test("findSplit ignores fenced headers and finds the detailed plan", () => {
  const s = findSplit(DOC.split("\n"), { preset: "uninterrupted" });
  assertEquals(s.status, "standard");
  assertEquals(s.featureRange, { start: 1, end: 8 });
  assertEquals(s.detailedRange, { start: 9, end: 11 });
});

Deno.test("findSplit resolves ambiguity, honours splitLine, bypasses for feature_spec", () => {
  const lines = ["# x", "## Implementation Plan", "a", "## Detailed Implementation Plan", "b"];
  const amb = findSplit(lines, { preset: "uninterrupted" });
  assertEquals(amb.status, "ambiguous_resolved");
  assertEquals(amb.detailedRange?.start, 4);
  assertEquals(findSplit(lines, { preset: "uninterrupted", splitLine: 2 }).detailedRange?.start, 2);
  assertEquals(findSplit(lines, { preset: "feature_spec" }).status, "bypassed");
  assertEquals(findSplit(["# only"], { preset: "uninterrupted" }).detailedRange, null);
});

Deno.test("resolveStages and personas validate their inputs", () => {
  assertEquals(resolveStages("uninterrupted"), [5, 6, 7, 8, 9]);
  assertEquals(resolveStages("uninterrupted", [9, 5, 5]), [5, 9]);
  assertThrows(() => resolveStages("nope"));
  assertThrows(() => resolveStages("uninterrupted", [4]));
  assertEquals(normalizePersona("egm-zoom-out"), "zoom-out");
  assertThrows(() => normalizePersona("egm-nobody"));
});

Deno.test("extractLinks strips fragments and skips anchors and mailto", () => {
  const md = "[a](x.md#s) [b](#top) [c](mailto:q@r)\n[d]: ./y.md\n[e](https://h/p)";
  assertEquals(extractLinks(md).sort(), ["./y.md", "https://h/p", "x.md"].sort());
});

Deno.test("buildReviewPrompt holds only persona, standard, document, context", () => {
  const p = buildReviewPrompt({
    personaText: "PERSONA",
    persona: "design",
    instance: "A",
    stage: 7,
    targetPath: "design.md",
    range: { start: 1, end: 3 },
    totalLines: 5,
    standardName: "feature-spec-standard",
    standardText: "STD",
    documentLines: ["a", "b", "c", "d", "e"],
    context: [{ path: "cache.md", content: "CTX" }],
    tools: false,
  });
  assertStringIncludes(p, "PERSONA");
  assertStringIncludes(p, "Mode: REVIEW");
  assertStringIncludes(p, "LineRange: 1-3");
  assertStringIncludes(p, "STD");
  assertStringIncludes(p, "### cache.md");
  assertStringIncludes(p, "4 : d"); // outside the range
  assertStringIncludes(p, "1 | a");
  assertStringIncludes(p, "You have no tools");
});

Deno.test("parseReviewerOutput enforces the schema and persona extras", () => {
  const ok = { noFindings: false, findings: [{ severity: "Major", title: "t", section: "s", finding: "f", suggestion: "g" }] };
  assert(parseReviewerOutput({ structured: ok }, "design").ok);
  assert(parseReviewerOutput({ response: "```json\n" + JSON.stringify(ok) + "\n```" }, "design").ok);
  assert(!parseReviewerOutput({ response: "nope" }, "design").ok);
  assert(!parseReviewerOutput({ structured: { ...ok, noFindings: true } }, "design").ok);
  assert(!parseReviewerOutput({ structured: ok }, "comprehension").ok);
  assert(!parseReviewerOutput({ structured: { noFindings: false, findings: [{ severity: "Huge" }] } }, "design").ok);
  assertEquals((reviewerSchema("comprehension").required as string[]).includes("whatThisProposes"), true);
});

Deno.test("vendored persona and standard files exist for every persona", async () => {
  for (const p of Object.values(PERSONAS)) {
    const t = await Deno.readTextFile(new URL(`./egm/prompts/agents/${p.file}`, import.meta.url));
    assert(t.length > 100, p.file);
  }
  for (const s of ["zoom-out-standard", "feature-spec-standard", "implementation-readiness-standard"]) {
    await Deno.stat(new URL(`./egm/prompts/standards/${s}.md`, import.meta.url));
  }
});

// ---------------------------------------------------------------- review end to end

Deno.test("review: prepare → collect (with failure) → merge retry → writeReports", async () => {
  const dir = await repoWithDoc();
  const g = { workingDirectory: dir, outputDir: "out" };
  const { ctx, own, other } = fakeCtx(g);
  await run(review.methods.prepare, { targetFile: "design.md", approvedExternalLinks: [] }, ctx);
  const plan = own.get("reviewPlan")!;
  assertEquals(plan.stages, [5, 6, 7, 8, 9]);
  assertEquals(plan.contextFiles, ["cache.md"]);
  const excluded = (plan.excludedLinks as { link: string; reason: string }[]).map((l) => l.reason).sort();
  assertEquals(excluded, ["not_approved", "not_found"]);
  const reqs = plan.requests as { key: string; persona: string; tools: string[]; prompt: string }[];
  assertEquals(reqs.length, 2 + 1 + 3 + 1 + 3);
  assertEquals(reqs.filter((r) => r.tools.length).map((r) => r.persona).sort(), ["codebase-details", "zoom-out", "zoom-out"]);
  const comp = reqs.find((r) => r.persona === "comprehension")!;
  assert(!comp.prompt.includes("### cache.md"), "stage 6 must not get context");

  const finding = (t: string) => ({ severity: "Major", title: t, section: "Plan", finding: t, suggestion: "fix" });
  const answer = (key: string) =>
    key.includes("comprehension")
      ? { noFindings: true, findings: [], whatThisProposes: "A cache.", howExistingSystemWorks: "No cache." }
      : { noFindings: false, findings: [finding(key)] };
  const batch = plan.batch as string;
  other["egm-goldfish"] = reqs.map((r) => ({
    name: `cli-${batch}-${r.key}`,
    attributes: r.key === "s7-style-a"
      ? { batch, key: r.key, ok: false, error: "timeout", costUsd: 0 }
      : { batch, key: r.key, ok: true, structured: answer(r.key), costUsd: 0.1 },
  }));
  await run(review.methods.collectFindings, {}, ctx);
  let f = own.get("findings")!;
  assertEquals((f.retryRequests as { key: string }[]).map((r) => r.key), ["s7-style-a"]);

  other["egm-goldfish"].push({
    name: `cli-${batch}-retry-s7-style-a`,
    attributes: { batch: `${batch}-retry`, key: "s7-style-a", ok: true, structured: answer("s7-style-a"), costUsd: 0.1 },
  });
  await run(review.methods.collectFindings, { merge: true }, ctx);
  f = own.get("findings")!;
  assertEquals((f.retryRequests as unknown[]).length, 0);
  const style = (f.reviewers as { key: string; status: string; attempts: number }[]).find((r) => r.key === "s7-style-a")!;
  assertEquals([style.status, style.attempts], ["completed", 2]);
  const raw = f.rawFindings as { id: string }[];
  assertEquals(raw.length, 9);

  const synthesis = {
    stages: [{ stage: 7, findings: [{ title: "x", severity: "Major", personas: ["egm-design"], scope: "Plan", description: "d", recommendation: "r", sourceIds: ["F3"] }] }],
    consolidated: [{ id: "A1", priority: "Major", title: "x", action: "a", rationale: "r", sourceIds: raw.slice(0, 8).map((r) => r.id) }],
  };
  await run(review.methods.writeReports, { synthesis }, ctx);
  const rep = own.get("reports")!;
  assertEquals(rep.untracedFindingIds, [raw[8].id]);
  const consolidated = await Deno.readTextFile(rep.consolidatedReportPath as string);
  assertStringIncludes(consolidated, "## Traceability Matrix");
  assertStringIncludes(consolidated, "## Untraced findings");
  assertStringIncludes(consolidated, `| ${raw[8].id} |`);
  const compReport = await Deno.readTextFile(`${dir}/out/comprehension_report.md`);
  assertStringIncludes(compReport, "**What this proposes**\n\nA cache.");
  await assertRejects(() => run(review.methods.writeReports, { synthesis: { stages: [] } }, ctx));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("review: implementation preset without a plan section fails closed", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/d.md`, "# no plan\n");
  const { ctx } = fakeCtx({ workingDirectory: dir });
  await assertRejects(() => run(review.methods.prepare, { targetFile: "d.md", preset: "implementation" }, ctx), Error, "No stages left");
  await Deno.remove(dir, { recursive: true });
});
