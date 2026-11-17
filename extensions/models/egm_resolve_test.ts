// Tests for the @sntxrr/egm/resolve behavior, with fake cliResult records.
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  applyEdits,
  checkedEditIds,
  checkEdits,
  markdownIssues,
  model as resolve,
  normalizeFindings,
  parseLineRange,
} from "./egm_resolve.ts";

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

// ---------------------------------------------------------------- resolve

Deno.test("resolve helpers: ranges, findings, edits, checkboxes, markdown", () => {
  assertEquals(parseLineRange("full file", 9), { start: 1, end: 9 });
  assertEquals(parseLineRange("2-4", 9), { start: 2, end: 4 });
  assertThrows(() => parseLineRange("4-2", 9));
  assertThrows(() => parseLineRange("1-10", 9));
  const nf = normalizeFindings({ rawFindings: [
    { id: "F1", persona: "style", severity: "Nit", title: "t", finding: "f", suggestion: "s" },
    { id: "F2", persona: "design", severity: "🔴 BLOCKER", title: "t", finding: "g", suggestion: "s" },
    { id: "F3", persona: "design", severity: "Blocker", title: "t", finding: "g", suggestion: "dup" },
  ] });
  assertEquals(nf.map((f) => [f.findingId, f.severity]), [["F2", "Blocker"], ["F1", "Nit"]]);
  assertThrows(() => normalizeFindings([{ severity: "?" }]));
  const text = "one\ntwo\nthree two\nfour\n";
  const st = checkEdits(text, { start: 1, end: 2 }, [
    { editId: "a", oldText: "one" },
    { editId: "b", oldText: "two" },
    { editId: "c", oldText: "four" },
    { editId: "d", oldText: "nope" },
    { editId: "e", oldText: "on" },
  ]);
  assertEquals(Object.fromEntries(st), { a: "overlaps", b: "ambiguous", c: "outOfRange", d: "missing", e: "overlaps" });
  assertEquals(applyEdits("a b c", [{ editId: "1", oldText: "a", newText: "AA" }, { editId: "2", oldText: "c", newText: "C" }]), "AA b C");
  assertEquals([...checkedEditIds("- [x] apply <!-- egm-edit:F1.1 -->\n    - [ ] apply <!-- egm-edit:F2.1 -->\n - [X] apply <!-- egm-edit:F3.1 -->")], ["F1.1", "F3.1"]);
  assertEquals(markdownIssues("# a\n```\nx\n```", "a\n```\nx"), ["unbalanced code fences", "heading count dropped from 1 to 0"]);
});

Deno.test("resolve: contests without evidence are demoted; applyFixes honours ticks and fails closed", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/doc.md`, "# Doc\n\nThe cache is fast.\n\nThe TTL is 5.\n");
  await Deno.writeTextFile(`${dir}/real.ts`, "export const TTL = 5;\n");
  await Deno.writeTextFile(`${dir}/findings.json`, JSON.stringify([
    { id: "F1", persona: "style", severity: "Nit", title: "vague", finding: "fast is vague", suggestion: "quantify" },
    { id: "F2", persona: "design", severity: "Major", title: "ttl", finding: "TTL unspecified", suggestion: "state units" },
    { id: "F3", persona: "design", severity: "Major", title: "x", finding: "made up", suggestion: "-" },
    { id: "F4", persona: "design", severity: "Blocker", title: "y", finding: "really wrong", suggestion: "-" },
    { id: "F5", persona: "style", severity: "Nit", title: "z", finding: "same sentence", suggestion: "-" },
    { id: "F6", persona: "style", severity: "Nit", title: "w", finding: "bogus cover", suggestion: "-" },
  ]));
  const { ctx, own, other } = fakeCtx({ workingDirectory: dir, artifactDir: "art" });
  await run(resolve.methods.prepare, { targetFile: "doc.md", findingsPath: "findings.json" }, ctx);
  const req = own.get("resolveRequest")!;
  assertEquals(req.findingCount, 6);
  const answer = { items: [
    { findingId: "F1", category: "PROPOSE FIX", justification: "j", edits: [{ location: "l3", oldText: "is fast", newText: "answers in 5 ms" }] },
    { findingId: "F2", category: "PROPOSE FIX", justification: "j", edits: [{ location: "l5", oldText: "is 5.", newText: "is 5 seconds." }] },
    { findingId: "F3", category: "CONTEST", justification: "j", evidence: { file: "real.ts", symbol: "TTL" }, edits: [] },
    { findingId: "F4", category: "CONTEST", justification: "j", evidence: { file: "ghost.ts" }, edits: [] },
    { findingId: "F5", category: "PROPOSE FIX", justification: "j", edits: [], coveredBy: "F1" },
    { findingId: "F6", category: "PROPOSE FIX", justification: "j", edits: [], coveredBy: "F3" },
  ] };
  other["egm-resolve-claude"] = [{ name: `cli-${req.batch}-classify`, attributes: { batch: req.batch, key: "classify", ok: true, structured: answer } }];
  await run(resolve.methods.writeReport, {}, ctx);
  const res = own.get("resolution")!;
  assertEquals(res.counts, { contest: 1, escalate: 1, proposeFix: 4, decline: 0 });
  const items = res.items as { findingId: string; coveredBy?: string }[];
  assertEquals(items.find((i) => i.findingId === "F5")?.coveredBy, "F1");
  assertEquals(items.find((i) => i.findingId === "F6")?.coveredBy, undefined);
  assertEquals(res.allClassified, true);
  const reportPath = res.reportPath as string;
  // operator unticks F2's edit
  const rep = await Deno.readTextFile(reportPath);
  await Deno.writeTextFile(reportPath, rep.replace("- [x] apply <!-- egm-edit:F2.1 -->", "- [ ] apply <!-- egm-edit:F2.1 -->"));
  await run(resolve.methods.applyFixes, {}, ctx);
  const ar = own.get("applyResult")!;
  assertEquals([ar.appliedCount, ar.skippedCount, ar.markdownValid], [1, 1, true]);
  // F1 applied, F5 covered by it; F2 unticked, F6's cover was invalid
  assertEquals((ar.handoff as { acceptedFixes: number; remainingUnaddressed: number }).acceptedFixes, 2);
  assertEquals((ar.handoff as { acceptedFixes: number; remainingUnaddressed: number }).remainingUnaddressed, 1 + 2);
  assertEquals(await Deno.readTextFile(`${dir}/doc.md`), "# Doc\n\nThe cache answers in 5 ms.\n\nThe TTL is 5.\n");
  assertStringIncludes(await Deno.readTextFile(reportPath), "**Status:** resolved (1 edits applied, 1 skipped");
  await Deno.stat(ar.backupPath as string);
  // the document has now changed: a second apply must refuse
  await assertRejects(() => run(resolve.methods.applyFixes, {}, ctx), Error, "changed since it was categorized");
  await Deno.remove(dir, { recursive: true });
});
