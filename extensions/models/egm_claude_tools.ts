/**
 * Adds `cli_generate_many_tools` to `@keeb/anthropic/claude`: the same batch
 * fan-out as `cli_generate_many`, except each request may name a read-only
 * tool set (Read, Grep, Glob) and then runs rooted at `cwd`.
 *
 * Requests without tools run exactly like `cli_generate_many`: no tools, in an
 * empty temp directory, so nothing but the prompt reaches the model. Requests
 * with tools run with `--restricted`, which confines the file tools to `cwd`
 * and removes every tool that runs commands or code. Every call also passes
 * `--safe-mode` and `--strict-mcp-config`, so no CLAUDE.md, skill, plugin, hook
 * or MCP server from the host reaches a reviewer.
 *
 * Results land in the base type's `cliResult` resource, instance
 * `cli-<batch>-<key>`, with the same fields `cli_generate_many` writes.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Tools a request may enable. All are read-only. */
export const READONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** One prompt in a batch. */
export const ToolRequestSchema = z.object({
  key: z.string().regex(NAME_RE).describe(
    "Unique key in the batch; the result is stored as cli-<batch>-<key>",
  ),
  prompt: z.string().min(1),
  systemPrompt: z.string().optional(),
  jsonSchema: z.record(z.string(), z.unknown()).optional().describe(
    "JSON Schema the answer must satisfy; the parsed answer lands in `structured`",
  ),
  tools: z.array(z.enum(READONLY_TOOLS)).default([]).describe(
    "Read-only tools for this request. Empty = no tools, empty temp cwd.",
  ),
});

/** A validated request. */
export type ToolRequest = z.infer<typeof ToolRequestSchema>;

/** Arguments of `cli_generate_many_tools`. */
export const ToolBatchArgsSchema = z.object({
  batch: z.string().regex(NAME_RE).describe(
    "Batch name; results are stored as cli-<batch>-<key>",
  ),
  requests: z.array(ToolRequestSchema).min(1).describe("Prompts to run"),
  cwd: z.string().optional().describe(
    "Directory tool-enabled requests run in (and are confined to). Required when any request names tools.",
  ),
  systemPrompt: z.string().optional().describe(
    "Shared system prompt for requests that do not carry their own",
  ),
  concurrency: z.number().int().min(1).max(16).default(4),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  timeoutSeconds: z.number().int().positive().default(900),
});

/** Outcome of one claude invocation. */
export interface CliOutcome {
  ok: boolean;
  response: string;
  structured?: unknown;
  error?: string;
  model: string;
  costUsd: number;
  durationMs: number;
}

/** Builds the claude CLI argument list for one request. Exported for tests. */
export function buildClaudeArgs(
  req: Pick<ToolRequest, "systemPrompt" | "jsonSchema" | "tools">,
  opts: { model: string; effort?: string },
): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--model",
    opts.model,
  ];
  if (req.tools.length > 0) {
    const tools = [...new Set(req.tools)].join(",");
    args.push("--tools", tools, "--allowedTools", tools);
  } else {
    args.push("--tools", "");
  }
  if (opts.effort) args.push("--effort", opts.effort);
  if (req.systemPrompt) args.push("--system-prompt", req.systemPrompt);
  if (req.jsonSchema) {
    args.push("--json-schema", JSON.stringify(req.jsonSchema));
  }
  return args;
}

/** Parses `claude -p --output-format json` stdout into an outcome. Exported for tests. */
export function parseClaudeOutput(
  stdout: string,
  stderr: string,
  code: number,
  model: string,
  durationMs: number,
): CliOutcome {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      response: "",
      error: `claude exited ${code}: ${(stderr || stdout).slice(0, 2000)}`,
      model,
      costUsd: 0,
      durationMs,
    };
  }
  const usage = parsed.modelUsage as Record<string, unknown> | undefined;
  const servedBy = usage ? Object.keys(usage)[0] ?? model : model;
  const isError = Boolean(parsed.is_error) || code !== 0;
  return {
    ok: !isError,
    response: String(parsed.result ?? ""),
    structured: parsed.structured_output,
    error: isError
      ? `claude ${String(parsed.subtype ?? "error")}: ${
        String(parsed.result ?? stderr).slice(0, 2000)
      }`
      : undefined,
    model: servedBy,
    costUsd: Number(parsed.total_cost_usd ?? 0),
    durationMs,
  };
}

async function invoke(
  req: ToolRequest,
  opts: { model: string; effort?: string; timeoutMs: number; cwd?: string },
  signal?: AbortSignal,
): Promise<CliOutcome> {
  const args = buildClaudeArgs(req, opts);
  const useTools = req.tools.length > 0;
  // tool-less requests get an empty cwd, so no repo file can reach the model
  const tmp = useTools
    ? null
    : await Deno.makeTempDir({ prefix: "egm-goldfish-" });
  const cwd = useTools ? opts.cwd! : tmp!;
  const started = Date.now();
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  try {
    // swamp-quality-ignore deno-command: this method exists to run the local claude CLI; args are fixed flags plus model, effort enum, a read-only tool enum, system prompt and JSON schema; the prompt goes over stdin
    const child = new Deno.Command("claude", {
      args,
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(req.prompt));
    await writer.close();
    const out = await child.output();
    return parseClaudeOutput(
      new TextDecoder().decode(out.stdout),
      new TextDecoder().decode(out.stderr),
      out.code,
      opts.model,
      Date.now() - started,
    );
  } catch (err) {
    return {
      ok: false,
      response: "",
      error: `claude failed to run: ${
        err instanceof Error ? err.message : String(err)
      }`,
      model: opts.model,
      costUsd: 0,
      durationMs: Date.now() - started,
    };
  } finally {
    if (tmp) await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

interface Ctx {
  globalArgs: { model?: string; systemPrompt?: string };
  signal?: AbortSignal;
  logger: {
    info: (msg: string, args?: unknown) => void;
    warning: (msg: string, args?: unknown) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Extension adding cli_generate_many_tools to @keeb/anthropic/claude. */
export const extension = {
  type: "@keeb/anthropic/claude",
  methods: [
    {
      cli_generate_many_tools: {
        description:
          "Run a batch of prompts through the local claude CLI, each in its own fresh session. A request may enable read-only tools (Read, Grep, Glob) confined to cwd; the rest run with no tools in an empty directory. Writes one cliResult per request; a failed request is stored with ok=false and does not fail the batch.",
        arguments: ToolBatchArgsSchema,
        execute: async (
          rawArgs: z.input<typeof ToolBatchArgsSchema>,
          context: Ctx,
        ) => {
          const args = ToolBatchArgsSchema.parse(rawArgs);
          const keys = new Set<string>();
          for (const r of args.requests) {
            if (keys.has(r.key)) throw new Error(`duplicate key ${r.key}`);
            keys.add(r.key);
          }
          const needsCwd = args.requests.some((r) => r.tools.length > 0);
          let cwd: string | undefined;
          if (needsCwd) {
            if (!args.cwd) {
              throw new Error("cwd is required when a request names tools");
            }
            cwd = await Deno.realPath(args.cwd);
            if (!(await Deno.stat(cwd)).isDirectory) {
              throw new Error(`cwd is not a directory: ${args.cwd}`);
            }
          }
          const model = context.globalArgs.model ?? "claude-opus-5-5";
          context.logger.info(
            "running {n} claude requests ({t} with read-only tools)",
            {
              n: args.requests.length,
              t: args.requests.filter((r) => r.tools.length > 0).length,
            },
          );
          const outcomes = await mapLimit(
            args.requests,
            args.concurrency,
            (r) =>
              invoke(
                {
                  ...r,
                  systemPrompt: r.systemPrompt ?? args.systemPrompt ??
                    context.globalArgs.systemPrompt,
                },
                {
                  model,
                  effort: args.effort,
                  timeoutMs: args.timeoutSeconds * 1000,
                  cwd,
                },
                context.signal,
              ),
          );
          const handles = [];
          for (let i = 0; i < args.requests.length; i++) {
            const r = args.requests[i];
            const o = outcomes[i];
            if (!o.ok) {
              context.logger.warning("request {key} failed: {error}", {
                key: r.key,
                error: o.error,
              });
            }
            handles.push(
              await context.writeResource(
                "cliResult",
                `cli-${args.batch}-${r.key}`,
                {
                  key: r.key,
                  batch: args.batch,
                  ok: o.ok,
                  response: o.response,
                  ...(o.structured !== undefined
                    ? { structured: o.structured }
                    : {}),
                  ...(o.error ? { error: o.error } : {}),
                  model: o.model,
                  costUsd: o.costUsd,
                  durationMs: o.durationMs,
                  timestamp: new Date().toISOString(),
                },
              ),
            );
          }
          return { dataHandles: handles };
        },
      },
    },
  ],
};
