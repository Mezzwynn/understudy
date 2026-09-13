import { config, providers, log } from "./config.mjs";
import { recordUsage, loadState, saveState } from "./store.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function trackUsage(label, data) {
  const u = data?.usage || {};
  const tin = u.prompt_tokens ?? u.input_tokens ?? 0;
  const tout = u.completion_tokens ?? u.output_tokens ?? 0;
  recordUsage(label, tin, tout);
}

/**
 * Safety valve: a runaway loop or a stuck retry must not drain a prepaid balance
 * overnight. Counts calls per day across every provider.
 */
function budgetCheck() {
  if (!config.budgetGuard) return;
  const st = loadState();
  const day = new Date().toISOString().slice(0, 10);
  const used = st.callsDay === day ? st.calls || 0 : 0;
  if (used >= config.llmDailyCallsMax) {
    if (st.callsNotifiedDay !== day) {
      st.callsNotifiedDay = day;
      saveState(st);
      log(`LLM daily call limit reached (${used}/${config.llmDailyCallsMax}) — she stays quiet until tomorrow`);
      try {
        // best effort, never fatal
        import("node:child_process").then(({ execFile }) =>
          execFile("termux-notification", ["-t", "Understudy", "-c", `Daily model limit reached (${used}). She will stay quiet until tomorrow.`], () => {}),
        );
      } catch {
        /* ignore */
      }
    }
    throw new Error(`budget: daily call limit reached (${used}/${config.llmDailyCallsMax})`);
  }
}

function countCall() {
  const st = loadState();
  const day = new Date().toISOString().slice(0, 10);
  if (st.callsDay !== day) {
    st.callsDay = day;
    st.calls = 0;
  }
  st.calls = (st.calls || 0) + 1;
  saveState(st);
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
        let data2;
        try {
          data2 = JSON.parse(text2);
        } catch {
          throw new Error(`${p.label}: empty/non-JSON response${text2 ? `: ${text2.slice(0, 160)}` : " (empty body)"}`);
        }
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
    let content = (msg?.content ?? "").trim();

    // Some models (GLM especially, and Gemini with thinking turned on) spend the
    // whole max_tokens budget on reasoning and return EMPTY content with
    // finish_reason "length". Retrying the same provider with more room is much
    // cheaper than falling through to another model.
    if (!content && data.choices?.[0]?.finish_reason === "length") {
      const bigger = Math.min(Math.max(maxTokens * 2, maxTokens + 400), 8000);
      log(`llm ${p.label}: empty content after hitting max_tokens (${maxTokens}) — retrying with ${bigger}`);
      const res3 = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({ ...body, max_tokens: bigger }),
        signal: ctrl.signal,
      });
      const text3 = await res3.text();
      if (res3.ok) {
        try {
          const data3 = JSON.parse(text3);
          trackUsage(p.label, data3);
          content = (data3.choices?.[0]?.message?.content ?? "").trim();
        } catch {
          /* stay empty and let the caller fall through to the next provider */
        }
      }
    }

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
  budgetCheck();
  countCall();
  // the smoke test runs the whole reply path without touching the network
  if (process.env.SMOKE_NO_LLM) {
    const text = process.env.SMOKE_LLM_TEXT || "ya. whatever.";
    return opts.json ? "{}" : text;
  }
  const maxTokens = opts.maxTokens ?? config.maxTokens;
  const list = opts.provider ? [opts.provider] : providers();
  let lastErr;

  // some providers (Gemini) refuse a request whose last turn is not a user turn,
  // and our prompt builders sometimes append a trailing system/assistant note
  const safe = messages.length && messages[messages.length - 1].role === "user"
    ? messages
    : [...messages, { role: "user", content: "(lanjut)" }];

  for (const p of list) {
    const temperature = opts.temperature ?? p.temperature ?? config.temperature;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await callProvider(p, { messages: safe, temperature, maxTokens, json: opts.json });
      } catch (err) {
        lastErr = err;
        log(`llm ${p.label}/${p.model} attempt ${attempt} failed: ${err.message}`);
        if (attempt < 2) await sleep(700 * attempt);
      }
    }
  }
  throw lastErr ?? new Error("all providers failed");
}
