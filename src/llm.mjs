import { config, providers, log } from "./config.mjs";
import { recordUsage } from "./store.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function trackUsage(label, data) {
  const u = data?.usage || {};
  const tin = u.prompt_tokens ?? u.input_tokens ?? 0;
  const tout = u.completion_tokens ?? u.output_tokens ?? 0;
  recordUsage(label, tin, tout);
}

async function callProvider(p, { messages, temperature, maxTokens, json }) {
  const url = `${p.baseUrl}/chat/completions`;
  const body = {
    model: p.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (config.freqPenalty) body.frequency_penalty = config.freqPenalty;
  if (config.presencePenalty) body.presence_penalty = config.presencePenalty;
  if (json) body.response_format = { type: "json_object" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.requestTimeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${p.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // Providers differ in which OpenAI-compatible fields they accept.
      // Retry once with the unsupported optional fields stripped.
      const optional = ["response_format", "frequency_penalty", "presence_penalty"];
      const reject = /response_format|frequency_penalty|presence_penalty|Unknown name|unknown field/i.test(text);
      const present = optional.filter((k) => k in body);
      if (reject && present.length) {
        const body2 = { ...body };
        for (const k of present) delete body2[k];
        const res2 = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${p.apiKey}`,
          },
          body: JSON.stringify(body2),
        });
        const text2 = await res2.text();
        if (!res2.ok) throw new Error(`${p.label} ${res2.status}: ${text2.slice(0, 300)}`);
        const data2 = JSON.parse(text2);
        trackUsage(p.label, data2);
        const c2 = (data2.choices?.[0]?.message?.content ?? "").trim();
        if (!c2) throw new Error(`${p.label}: empty content`);
        return c2;
      }
      throw new Error(`${p.label} ${res.status}: ${text.slice(0, 300)}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${p.label}: non-JSON response: ${text.slice(0, 200)}`);
    }
    trackUsage(p.label, data);
    const msg = data.choices?.[0]?.message;
    const content = (msg?.content ?? "").trim();
    if (!content) throw new Error(`${p.label}: empty content`);
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat completion with per-provider retry + cross-provider fallback.
 */
export async function chat(messages, opts = {}) {
  const maxTokens = opts.maxTokens ?? config.maxTokens;
  const list = opts.provider ? [opts.provider] : providers();
  let lastErr;

  for (const p of list) {
    const temperature = opts.temperature ?? p.temperature ?? config.temperature;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await callProvider(p, { messages, temperature, maxTokens, json: opts.json });
      } catch (err) {
        lastErr = err;
        log(`llm ${p.label}/${p.model} attempt ${attempt} failed: ${err.message}`);
        if (attempt < 2) await sleep(700 * attempt);
      }
    }
  }
  throw lastErr ?? new Error("all providers failed");
}
