// Tests for the cli_generate_many_tools extension on @keeb/anthropic/claude.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  buildClaudeArgs,
  extension,
  parseClaudeOutput,
  ToolRequestSchema,
} from "./egm_claude_tools.ts";

// ---------------------------------------------------------------- claude tools

Deno.test("buildClaudeArgs: tool-less vs read-only, always restricted and safe", () => {
  const none = buildClaudeArgs(ToolRequestSchema.parse({ key: "k", prompt: "p" }), { model: "m" });
  assertEquals(none[none.indexOf("--tools") + 1], "");
  assert(!none.includes("--allowedTools"));
  const ro = buildClaudeArgs(
    ToolRequestSchema.parse({ key: "k", prompt: "p", tools: ["Read", "Grep", "Read"], jsonSchema: { type: "object" } }),
    { model: "m", effort: "low" },
  );
  assertEquals(ro[ro.indexOf("--tools") + 1], "Read,Grep");
  for (const f of ["--restricted", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"]) {
    assert(none.includes(f) && ro.includes(f), f);
  }
  assertEquals(ro[ro.indexOf("--json-schema") + 1], '{"type":"object"}');
});

Deno.test("ToolRequestSchema rejects write or exec tools and bad keys", () => {
  assertThrows(() => ToolRequestSchema.parse({ key: "k", prompt: "p", tools: ["Bash"] }));
  assertThrows(() => ToolRequestSchema.parse({ key: "k", prompt: "p", tools: ["Edit"] }));
  assertThrows(() => ToolRequestSchema.parse({ key: "../x", prompt: "p" }));
});

Deno.test("parseClaudeOutput maps errors and structured output", () => {
  const ok = parseClaudeOutput(JSON.stringify({ result: "r", structured_output: { a: 1 }, total_cost_usd: 0.5, modelUsage: { "claude-x": {} } }), "", 0, "m", 1);
  assertEquals([ok.ok, ok.structured, ok.costUsd, ok.model], [true, { a: 1 }, 0.5, "claude-x"]);
  assertEquals(parseClaudeOutput("garbage", "boom", 1, "m", 1).ok, false);
  assertEquals(parseClaudeOutput(JSON.stringify({ is_error: true, subtype: "error_max_turns" }), "", 0, "m", 1).ok, false);
});

// ---------------------------------------------------------------- execute with a stub claude

const STUB = `#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat)"
printf '%s\\t%s\\t%s\\n' "$(pwd -P)" "$*" "$prompt" >> "$EGM_STUB_LOG"
case "$prompt" in
  *FAIL*) echo "boom" >&2; exit 1 ;;
  *) printf '{"result":"done","structured_output":{"ok":true},"total_cost_usd":0.01}' ;;
esac
`;

async function withStubClaude(
  fn: (log: string) => Promise<void>,
): Promise<void> {
  const bin = await Deno.makeTempDir({ prefix: "egm-stub-" });
  await Deno.writeTextFile(`${bin}/claude`, STUB);
  await Deno.chmod(`${bin}/claude`, 0o755);
  const log = `${bin}/log.tsv`;
  const oldPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${bin}:${oldPath}`);
  Deno.env.set("EGM_STUB_LOG", log);
  try {
    await fn(log);
  } finally {
    Deno.env.set("PATH", oldPath);
    Deno.env.delete("EGM_STUB_LOG");
    await Deno.remove(bin, { recursive: true });
  }
}

function toolsCtx() {
  const written = new Map<string, Record<string, unknown>>();
  return {
    written,
    ctx: {
      globalArgs: { model: "claude-test" },
      logger: { info: () => {}, warning: () => {} },
      writeResource: (spec: string, name: string, data: Record<string, unknown>) => {
        assertEquals(spec, "cliResult");
        written.set(name, data);
        return Promise.resolve({ name });
      },
    },
  };
}

const method = extension.methods[0].cli_generate_many_tools;

Deno.test("cli_generate_many_tools: isolation, cwd confinement, failures stored", async () => {
  await withStubClaude(async (log) => {
    const repo = await Deno.realPath(await Deno.makeTempDir({ prefix: "egm-repo-" }));
    const { ctx, written } = toolsCtx();
    await method.execute({
      batch: "b1",
      cwd: repo,
      requests: [
        { key: "plain", prompt: "hello" },
        { key: "coder", prompt: "read code", tools: ["Read", "Grep"] },
        { key: "bad", prompt: "please FAIL" },
      ],
    }, ctx);
    assertEquals([...written.keys()].sort(), ["cli-b1-bad", "cli-b1-coder", "cli-b1-plain"]);
    assertEquals(written.get("cli-b1-plain")!.ok, true);
    assertEquals(written.get("cli-b1-plain")!.structured, { ok: true });
    assertEquals(written.get("cli-b1-bad")!.ok, false);
    assertStringIncludes(String(written.get("cli-b1-bad")!.error), "boom");
    const rows = (await Deno.readTextFile(log)).trim().split("\n").map((l) => l.split("\t"));
    const byPrompt = new Map(rows.map((r) => [r[2], r]));
    const plain = byPrompt.get("hello")!;
    const coder = byPrompt.get("read code")!;
    assert(plain[0] !== repo, "tool-less request must not run in the repo");
    assert(plain[1].endsWith("--tools "), "empty --tools value is the last argument");
    assert(!plain[1].includes("--allowedTools"));
    assertEquals(coder[0], repo);
    assertStringIncludes(coder[1], "--tools Read,Grep --allowedTools Read,Grep");
    for (const r of rows) {
      assertStringIncludes(r[1], "--restricted");
      assertStringIncludes(r[1], "--model claude-test");
    }
    // the tool-less temp directory is removed afterwards
    await assertRejects(() => Deno.stat(plain[0]));
    await Deno.remove(repo, { recursive: true });
  });
});

Deno.test("cli_generate_many_tools: refuses tools without cwd, and duplicate keys", async () => {
  const { ctx } = toolsCtx();
  await assertRejects(
    () => method.execute({ batch: "b", requests: [{ key: "k", prompt: "p", tools: ["Read"] }] }, ctx),
    Error,
    "cwd is required",
  );
  await assertRejects(
    () => method.execute({ batch: "b", requests: [{ key: "k", prompt: "p" }, { key: "k", prompt: "q" }] }, ctx),
    Error,
    "duplicate key",
  );
});
