// Tests for the @sntxrr/egm/drift behavior, with fake cliResult records.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  diffCounts,
  docKey,
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

// ---------------------------------------------------------------- drift

Deno.test("drift helpers: keys, unreferenced files, diffs, strict render", () => {
  assertEquals(docKey(0, "docs/My Design.md"), "d001-docs-my-design");
  assertEquals(unreferencedFiles(["src/a.ts", "src/b.ts"], ["see a.ts"], []), ["src/b.ts"]);
  assertEquals(diffCounts({ x: 1, y: 2 }, { x: 2, y: 0, z: 1 }), {
    newDriftDocs: [{ doc: "x", previous: 1, current: 2 }, { doc: "z", previous: 0, current: 1 }],
    resolvedDocs: ["y"],
  });
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

Deno.test("drift: prepare → collect → writeReport tracks new drift across runs", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/docs/node_modules`, { recursive: true });
  await Deno.writeTextFile(`${dir}/docs/a.md`, "# A\nuses a.ts\n");
  await Deno.writeTextFile(`${dir}/docs/b.md`, "# B\n");
  await Deno.writeTextFile(`${dir}/docs/node_modules/x.md`, "# vendored\n");
  const { ctx, own, other } = fakeCtx({ repoRoot: dir, docsDir: "docs" });
  const cycle = async (itemsFor: (doc: string) => unknown[]) => {
    await run(drift.methods.prepare, {}, ctx);
    const plan = own.get("plan")!;
    const docs = plan.docs as { key: string; relPath: string }[];
    assertEquals(docs.map((d) => d.relPath), ["docs/a.md", "docs/b.md"]);
    other["egm-drift-claude"] = docs.map((d) => ({
      name: `cli-${plan.batch}-${d.key}`,
      attributes: { batch: plan.batch, key: d.key, ok: true, structured: { noDrift: itemsFor(d.relPath).length === 0, items: itemsFor(d.relPath), missingLinks: [], codeFilesExamined: [] } },
    }));
    await run(drift.methods.collectFindings, {}, ctx);
    await run(drift.methods.writeReport, { reportDate: "2026-11-17" }, ctx);
    return own.get("report")!;
  };
  const item = { category: "logic_shortcut", description: "hard-coded", docRef: "A", codeRef: "a.ts:1" };
  const first = await cycle(() => []);
  assertEquals([first.totalDrift, first.newDriftCount], [0, 0]);
  const second = await cycle((d) => (d === "docs/b.md" ? [item] : []));
  assertEquals(second.newDriftDocs, [{ doc: "docs/b.md", previous: 0, current: 1 }]);
  const text = await Deno.readTextFile(second.path as string);
  assertStringIncludes(text, "## docs/b.md\n\n- [logic_shortcut] hard-coded (doc: A; code: a.ts:1)");
  await Deno.remove(dir, { recursive: true });
});
