// Tests for the @sntxrr/egm/drift behavior, with fake cliResult records.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import {
  diffCounts,
  type DocInputs,
  docKey,
  hashSourceFiles,
  inputsChanged,
  model as drift,
  renderDriftReport,
  unreferencedFiles,
} from "./egm_drift.ts";

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

// ---------------------------------------------------------------- drift

Deno.test("drift helpers: keys, unreferenced files, diffs, strict render", () => {
  assertEquals(docKey(0, "docs/My Design.md"), "d001-docs-my-design");
  assertEquals(unreferencedFiles(["src/a.ts", "src/b.ts"], ["see a.ts"], []), ["src/b.ts"]);
  const body = renderDriftReport({
    batch: "b",
    perDoc: [
      { doc: "a.md", status: "ok", noDrift: true, items: [], missingLinks: [], codeFilesExamined: [] },
      { doc: "b.md", status: "ok", noDrift: false, items: [{ category: "missing_feature", description: "no cache", docRef: "§2", codeRef: "absent" }], missingLinks: [], codeFilesExamined: [] },
      { doc: "c.md", status: "error", error: "timeout", noDrift: false, items: [], missingLinks: [], codeFilesExamined: [] },
    ],
    coverage: { checked: false, unreferencedFiles: [] },
    totals: { docs: 3, docsWithDrift: 1, driftItems: 1, errors: 1, byCategory: {} },
    costUsd: 0,
    timestamp: "t",
  });
  assertEquals(body, "## a.md\n\nNo drift detected.\n\n## b.md\n\n- [missing_feature] no cache (doc: §2; code: absent)\n\n## c.md\n\n- [error] analysis failed: timeout\n");
});

const inp = (docSha: string, files: Record<string, string> = {}): DocInputs => ({ docSha, files });

Deno.test("diffCounts: first run and legacy previous run are baselines", () => {
  const cur = { "a.md": 6, "b.md": 0 };
  const ci = { "a.md": inp("1"), "b.md": inp("2") };
  for (const [previous, previousInputs] of [[null, null], [{ "a.md": 0 }, null]] as const) {
    const d = diffCounts({ previous, previousInputs, current: cur, currentInputs: ci, minNewItems: 1 });
    assertEquals([d.baseline, d.newDriftDocs, d.baselineDocs], [true, [], ["a.md", "b.md"]]);
  }
});

Deno.test("diffCounts: a rise on unchanged inputs is suppressed, not new", () => {
  const i = { "a.md": inp("d", { "src/a.ts": "h1" }) };
  const d = diffCounts({ previous: { "a.md": 6 }, previousInputs: i, current: { "a.md": 9 }, currentInputs: i, minNewItems: 1 });
  assertEquals(d.newDriftDocs, []);
  assertEquals(d.suppressedDocs, [{ doc: "a.md", previous: 6, current: 9, reason: "inputs_unchanged" }]);
});

Deno.test("diffCounts: changed inputs and a rise of minNewItems is new drift; smaller rise is below threshold", () => {
  const prevI = { "a.md": inp("d", { "src/a.ts": "h1" }), "b.md": inp("e") };
  const curI = { "a.md": inp("d", { "src/a.ts": "h2" }), "b.md": inp("e2") };
  const d = diffCounts({ previous: { "a.md": 1, "b.md": 1, "gone.md": 3 }, previousInputs: prevI, current: { "a.md": 3, "b.md": 2, "new.md": 4 }, currentInputs: { ...curI, "new.md": inp("n") }, minNewItems: 2 });
  assertEquals(d.baseline, false);
  assertEquals(d.newDriftDocs, [{ doc: "a.md", previous: 1, current: 3 }]);
  assertEquals(d.suppressedDocs, [{ doc: "b.md", previous: 1, current: 2, reason: "below_threshold" }]);
  assertEquals(d.baselineDocs, ["new.md"]);
  assertEquals(d.changedDocs, ["a.md", "b.md"]);
  assertEquals(d.resolvedDocs, []);
  const r = diffCounts({ previous: { x: 2 }, previousInputs: { x: inp("1") }, current: { x: 0 }, currentInputs: { x: inp("1") }, minNewItems: 2 });
  assertEquals(r.resolvedDocs, ["x"]);
});

Deno.test("inputsChanged: doc hash, changed or vanished file", () => {
  assert(!inputsChanged(inp("d", { f: "1" }), inp("d", { f: "1", g: "2" })));
  assert(inputsChanged(inp("d", { f: "1" }), inp("d", { f: "absent" })));
  assert(inputsChanged(inp("d"), inp("x")));
  assert(inputsChanged(undefined, inp("d")));
});

Deno.test("hashSourceFiles: confined to repoRoot, absent files marked, refs trimmed", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const outside = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/src`);
  await Deno.writeTextFile(`${root}/src/a.ts`, "x");
  await Deno.writeTextFile(`${outside}/secret`, "s");
  await Deno.symlink(`${outside}/secret`, `${root}/link`);
  const h = await hashSourceFiles(root, ["src/a.ts:12", `${root}/src/a.ts`, "./gone.ts", "../etc/passwd", "/etc/passwd", "link", "src"]);
  assertEquals(Object.keys(h).sort(), ["gone.ts", "src/a.ts"]);
  assertEquals(h["gone.ts"], "absent");
  assertEquals(h["src/a.ts"].length, 64);
  await Deno.remove(root, { recursive: true });
  await Deno.remove(outside, { recursive: true });
});

Deno.test("drift: prepare → collect → writeReport: baseline, wobble suppressed, real change flagged", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/docs/node_modules`, { recursive: true });
  await Deno.mkdir(`${dir}/src`);
  await Deno.writeTextFile(`${dir}/src/a.ts`, "export const a = 1;\n");
  await Deno.writeTextFile(`${dir}/docs/a.md`, "# A\nuses a.ts\n");
  await Deno.writeTextFile(`${dir}/docs/b.md`, "# B\n");
  await Deno.writeTextFile(`${dir}/docs/node_modules/x.md`, "# vendored\n");
  const { ctx, own, other } = fakeCtx({ repoRoot: dir, docsDir: "docs" });
  const item = { category: "logic_shortcut", description: "hard-coded", docRef: "A", codeRef: "src/a.ts:1" };
  const cycle = async (nFor: (doc: string) => number, examined: string[] = ["src/a.ts"], fail: string[] = []) => {
    await run(drift.methods.prepare, {}, ctx);
    const plan = own.get("plan")!;
    const docs = plan.docs as { key: string; relPath: string }[];
    assertEquals(docs.map((d) => d.relPath), ["docs/a.md", "docs/b.md"]);
    other["egm-drift-claude"] = docs.map((d) => {
      const items = Array.from({ length: nFor(d.relPath) }, () => item);
      return {
        name: `cli-${plan.batch}-${d.key}`,
        attributes: fail.includes(d.relPath)
          ? { batch: plan.batch, key: d.key, ok: false, error: "timeout" }
          : { batch: plan.batch, key: d.key, ok: true, structured: { noDrift: items.length === 0, items, missingLinks: [], codeFilesExamined: examined } },
      };
    });
    await run(drift.methods.collectFindings, {}, ctx);
    await run(drift.methods.writeReport, { reportDate: "2026-11-17" }, ctx);
    return own.get("report")!;
  };
  // 1. First run with drift: baseline, nothing new.
  const first = await cycle((d) => (d === "docs/a.md" ? 3 : 0));
  assertEquals([first.baseline, first.newDriftCount, first.totalDrift], [true, 0, 3]);
  assertEquals(Object.keys((first.inputs as Record<string, DocInputs>)["docs/a.md"].files), ["src/a.ts"]);
  // 2. Same code, model reports more (and reads nothing this time): suppressed.
  const second = await cycle((d) => (d === "docs/a.md" ? 6 : 0), []);
  assertEquals([second.baseline, second.newDriftCount], [false, 0]);
  assertEquals((second.suppressedDocs as { reason: string }[]).map((s) => s.reason), ["inputs_unchanged"]);
  // 3. b.md errors: its last good record is carried forward, not reset.
  const third = await cycle((d) => (d === "docs/a.md" ? 6 : 0), ["src/a.ts"], ["docs/b.md"]);
  assertEquals((third.perDocCounts as Record<string, number>)["docs/b.md"], 0);
  // 4. Source file changes and the count rises by 2: new drift.
  await Deno.writeTextFile(`${dir}/src/a.ts`, "export const a = 2;\n");
  const fourth = await cycle((d) => (d === "docs/a.md" ? 8 : 0));
  assertEquals(fourth.changedDocs, ["docs/a.md", "docs/b.md"]); // both read src/a.ts
  assertEquals(fourth.newDriftDocs, [{ doc: "docs/a.md", previous: 6, current: 8 }]);
  // 5. b.md was carried forward through its error, so it is compared, not a baseline.
  const fifth = await cycle((d) => (d === "docs/a.md" ? 8 : 0));
  assertEquals(fifth.baselineDocs, []);
  const text = await Deno.readTextFile(fifth.path as string);
  assertStringIncludes(text, "## docs/a.md\n\n- [logic_shortcut] hard-coded (doc: A; code: src/a.ts:1)");
  await Deno.remove(dir, { recursive: true });
});
