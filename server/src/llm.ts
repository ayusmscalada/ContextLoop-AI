/**
 * Optional Claude layer. Every caller has a deterministic fallback, so the platform
 * runs fully offline; setting ANTHROPIC_API_KEY upgrades extraction, answers,
 * skill rewriting and skill->policy compilation to Claude.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { getSetting } from "./db.ts";

export const MODEL = process.env.CONTEXTLOOP_MODEL ?? "claude-opus-5-5";

let client: Anthropic | null = null;
export let lastLlmError: string | null = null;
export const llmStats = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0 };

export function llmEnabled(): boolean {
  const hasCreds = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return hasCreds && getSetting<boolean>("llm.enabled", true);
}

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

type Effort = "low" | "medium" | "high";

/** Structured output call validated against a zod schema. Returns null on any failure. */
export async function structured<S extends z.ZodType>(opts: {
  system: string;
  prompt: string;
  schema: S;
  effort?: Effort;
  maxTokens?: number;
}): Promise<z.infer<S> | null> {
  if (!llmEnabled()) return null;
  llmStats.calls++;
  try {
    const res = await getClient().beta.messages.parse({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: opts.system,
      output_config: { effort: opts.effort ?? "low", format: betaZodOutputFormat(opts.schema) },
      messages: [{ role: "user", content: opts.prompt }],
    } as any);
    llmStats.inputTokens += res.usage?.input_tokens ?? 0;
    llmStats.outputTokens += res.usage?.output_tokens ?? 0;
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
      lastLlmError = `stop_reason=${res.stop_reason}`;
      llmStats.failures++;
      return null;
    }
    return (res.parsed_output ?? null) as z.infer<S> | null;
  } catch (e: any) {
    lastLlmError = e?.message ?? String(e);
    llmStats.failures++;
    return null;
  }
}

/** Plain text completion. Returns null on any failure. */
export async function complete(opts: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  effort?: Effort;
  maxTokens?: number;
}): Promise<string | null> {
  if (!llmEnabled()) return null;
  llmStats.calls++;
  try {
    const res = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: opts.system,
      output_config: { effort: opts.effort ?? "low" },
      messages: opts.messages,
    } as any);
    llmStats.inputTokens += (res as any).usage?.input_tokens ?? 0;
    llmStats.outputTokens += (res as any).usage?.output_tokens ?? 0;
    if ((res as any).stop_reason === "refusal") {
      llmStats.failures++;
      return null;
    }
    const text = ((res as any).content as any[])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return text || null;
  } catch (e: any) {
    lastLlmError = e?.message ?? String(e);
    llmStats.failures++;
    return null;
  }
}
