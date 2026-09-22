import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { routedModel } from "../src/catalog.mjs";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { xiaomiMiMoResponseHeaders } from "../src/xiaomi-mimo-compat.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provider = JSON.parse(readFileSync(path.join(root, "config/xiaomi/payg-responses.json"))).providers[0];
const ids = ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"];
const models = ids.map((id, priority) => ({
  slug: `${provider.id}/${id}`,
  provider: provider.id,
  gatewayModel: `${provider.id}-${id.replaceAll(".", "-")}`,
  upstreamModel: id,
  listed: true,
  displayName: id,
  description: "Xiaomi official PAYG test fixture",
  defaultEffort: "low",
  reasoningLevels: ["none", "low", "medium", "high"].map((effort) => ({ effort, description: effort })),
  contextWindow: 1048576,
  autoCompact: 891289,
  inputModalities: ["text", "image"],
  supportsReasoningSummaries: true,
  supportsImageDetailOriginal: true,
  supportsParallelToolCalls: false,
  priority,
  compHash: "mimo-fixture",
}));

test("Xiaomi official catalog opts into lite without changing reseller or older Xiaomi routes", () => {
  const template = { slug: "native", shell_type: "shell_command", base_instructions: "Codex" };
  for (const model of models) {
    const published = routedModel(template, model);
    assert.equal(published.use_responses_lite, true);
    assert.equal(published.tool_mode, "code_mode_only");
    assert.equal(published.shell_type, "unified_exec");
    assert.equal(published.default_reasoning_summary, "none");
    assert.equal(published.multi_agent_version, "v1");
    assert.equal(published.multi_agent_reasoning_effort, "high");
    assert.equal(published.supports_experimental_context, true);
    assert.equal(published.auto_compact_token_limit, null);
    assert.match(published.base_instructions, /^You are MiMo,/);
    assert.deepEqual(published.experimental_supported_tools, ["send_user_message_async", "clock"]);
    assert.deepEqual(published.supported_reasoning_levels.map((level) => level.effort), ["none", "low", "medium", "high"]);
    assert.deepEqual(xiaomiMiMoResponseHeaders(provider, { model: model.upstreamModel }), {
      "x-openai-internal-codex-responses-lite": "true",
    });
  }
  for (const id of ["opencode-go", "xiaomi-mimo", "openai"]) {
    const published = routedModel(template, { ...models[0], provider: id });
    assert.equal(published.use_responses_lite, false);
    assert.equal(published.tool_mode, undefined);
    assert.deepEqual(xiaomiMiMoResponseHeaders({ ...provider, id }, { model: ids[0] }), {});
  }
  assert.deepEqual(xiaomiMiMoResponseHeaders(provider, { model: "unknown-model" }), {});
});

test("Xiaomi native Responses bypasses the translator and preserves reasoning and output budget", async (t) => {
  const state = mkdtempSync(path.join(os.tmpdir(), "xiaomi-native-wire-"));
  const received = [];
  let gatewayCalls = 0;
  const reply = (res, payload) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const api = http.createServer(async (req, res) => {
    if (req.method === "GET") return reply(res, { ok: true });
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    reply(res, { id: "resp_native_test", object: "response", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  });
  const gateway = http.createServer((req, res) => {
    if (req.method === "POST") gatewayCalls++;
    reply(res, { ok: true });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const registryPath = path.join(state, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ version: 1, providers: [provider], models }));
  writeFileSync(path.join(state, "xiaomi-mimo-payg-api-key.secret"), "LOCAL_ONLY", { mode: 0o600 });
  writeFileSync(path.join(state, "enabled-providers.json"), JSON.stringify({ version: 1, providers: [provider.id] }));
  const port = await openPort();
  const caller = "test-xiaomi-native-caller-key-long-enough";
  const child = spawn(process.execPath, [path.join(root, "src/router.mjs")], {
    cwd: root,
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: state, MODEL_ROUTER_REGISTRY: registryPath,
      MODEL_ROUTER_USER_MODELS: path.join(state, "no-user-models.json"),
      CODEX_ROUTER_CALLER_KEY: caller, CODEX_ROUTER_INTERNAL_KEY: "test-xiaomi-native-internal-key",
      CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_API_PORT: String(api.address().port),
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.address().port}/v1`,
      CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gateway.address().port}/health`,
      CODEX_ROUTER_QUIET: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); }
    api.closeAllConnections(); gateway.closeAllConnections();
    await Promise.all([new Promise((resolve) => api.close(resolve)), new Promise((resolve) => gateway.close(resolve))]);
    rmSync(state, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error(errors);
    try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, errors);
  const input = [
    { role: "user", content: "Use the synthetic tool." },
    { type: "reasoning", id: "rs_history", summary: [{ type: "summary_text", text: "KEEP_REASONING_SEPARATE" }] },
    { type: "function_call", call_id: "call_history", name: "probe", arguments: "{}" },
    { type: "function_call_output", call_id: "call_history", output: "OK" },
  ];
  const tools = [{ type: "custom", name: "apply_patch", format: { type: "text" } }];
  for (const effort of ["none", "low", "medium", "high"]) {
    const res = await fetch(`${callerBaseUrl(port, caller)}/responses`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: models[1].slug, input, tools, reasoning: { effort, summary: "none" },
        max_output_tokens: 131072, stream: false }) });
    assert.equal(res.status, 200, await res.text());
    const sent = received.at(-1);
    assert.deepEqual(sent.input, input);
    assert.deepEqual(sent.tools, tools);
    assert.equal(sent.reasoning.effort, effort);
    assert.equal(sent.max_output_tokens, 131072);
    assert.equal(sent.model, models[1].gatewayModel);
  }
  assert.equal(gatewayCalls, 0, "native MiMo traffic must not go through protocol translation");
});

test("Xiaomi forwarder preserves official model IDs, freeform tools, lite header, and SSE", async (t) => {
  const state = mkdtempSync(path.join(os.tmpdir(), "xiaomi-mimo-test-"));
  const observed = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    observed.push({ url: request.url, headers: request.headers, body });
    const result = {
      id: "resp_mimo_local", object: "response", status: "completed", model: body.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "LOCAL_OK" }] }],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    };
    if (body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: result })}\n\n`);
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const registryPath = path.join(state, "registry.json");
  writeFileSync(registryPath, JSON.stringify({
    version: 1,
    providers: [{ ...provider, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }],
    models,
  }));
  const port = await openPort();
  const internalKey = "test-xiaomi-forwarder-internal-key";
  const child = spawn(process.execPath, [path.join(root, "src/api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: state,
      MODEL_ROUTER_REGISTRY: registryPath,
      MODEL_ROUTER_USER_MODELS: path.join(state, "no-user-models.json"),
      MODEL_ROUTER_API_PORT: String(port),
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_QUIET: "1",
      MIMO_API_KEY: "LOCAL_TEST_KEY",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(state, { recursive: true, force: true });
  });
  const headers = { Authorization: `Bearer ${internalKey}`, "Content-Type": "application/json" };
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw Error(errors);
    try { ready = (await fetch(`http://127.0.0.1:${port}/health`, { headers })).ok; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, errors);
  const tools = [{ type: "custom", name: "apply_patch", format: { type: "text" } }];
  for (const [index, model] of models.entries()) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { ...headers, "x-openai-internal-unrelated": "never-forward" },
      body: JSON.stringify({ model: `responses/${model.gatewayModel}`, input: "LOCAL_ONLY", tools,
        reasoning: { effort: "low", summary: "none" }, reasoning_effort: "low", stream: index === 2 }),
    });
    assert.equal(response.status, 200, errors);
    assert.match(await response.text(), /LOCAL_OK/);
    const request = observed[index];
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.body.model, model.upstreamModel);
    assert.deepEqual(request.body.tools, tools);
    assert.equal(request.body.reasoning.effort, "low");
    assert.equal(request.body.reasoning_effort, undefined);
    assert.equal(request.headers.authorization, "Bearer LOCAL_TEST_KEY");
    assert.equal(request.headers["x-openai-internal-codex-responses-lite"], "true");
    assert.equal(request.headers["x-openai-internal-unrelated"], undefined);
  }
});
