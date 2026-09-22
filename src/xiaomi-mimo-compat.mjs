import { readFileSync } from "node:fs";

// Xiaomi's official Codex catalog (2026-09-22) requires Responses lite for
// freeform custom tools. Keep this limited to the official PAYG route; the
// OpenCode models and the older Xiaomi Chat Completions route are independent.
// https://mimo.mi.com/docs/zh-CN/tokenplan/integration/codex-configuration
const MODELS = new Set([
  "mimo-v2.6-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro-ultraspeed",
]);

const OFFICIAL_CATALOG = JSON.parse(readFileSync(
  new URL("./xiaomi-mimo-codex-catalog.json", import.meta.url), "utf8",
));
const OFFICIAL_MODELS = new Map(OFFICIAL_CATALOG.models.map((model) => [model.slug, model]));

export function isXiaomiMiMoPayg(model) {
  return model?.provider === "xiaomi-mimo-payg" && MODELS.has(model.upstreamModel);
}

export function xiaomiMiMoOfficialCatalogModel(model) {
  if (!isXiaomiMiMoPayg(model)) return undefined;
  return structuredClone(OFFICIAL_MODELS.get(model.upstreamModel));
}

export function xiaomiMiMoResponseHeaders(provider, payload) {
  return provider?.protocol === "openai-responses" &&
    isXiaomiMiMoPayg({ provider: provider?.id, upstreamModel: payload?.model })
    ? { "x-openai-internal-codex-responses-lite": "true" }
    : {};
}
