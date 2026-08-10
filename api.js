// api.js — DeepSeek streaming contextual word-meaning client.
//
// The extension service worker loads this file and forwards its deltas to the
// content script over a Port. Node callers can also consume it directly:
//
//   for await (const chunk of YTDS_AI_API.translateStream(word, { context })) {
//     explanation += chunk;
//   }
//
// Configuration follows the existing options page contract:
//   chrome.storage.local.byoKeys.deepseek  — API key (never synced)
//   chrome.storage.sync.targetLang         — target language
//   chrome.storage.sync.byoModelBy          — per-provider model selection
// In Node.js, the equivalent values come from DEEPSEEK_API_KEY, TARGET_LANG,
// and DEEPSEEK_MODEL, so local tests do not need to mock chrome.storage.

(function (root) {
  "use strict";

  const ENDPOINT = "https://api.deepseek.com/v1/chat/completions";
  const DEFAULT_MODEL = "deepseek-chat";

  class AIAPIError extends Error {
    constructor(message, code, status) {
      super(message);
      this.name = "AIAPIError";
      this.code = code;
      if (status != null) this.status = status;
    }
  }

  function storageGet(area, defaults) {
    return new Promise((resolve, reject) => {
      if (!root.chrome || !chrome.storage || !chrome.storage[area]) {
        reject(new AIAPIError("Chrome storage is unavailable", "STORAGE_UNAVAILABLE"));
        return;
      }

      chrome.storage[area].get(defaults, (value) => {
        const lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) {
          reject(new AIAPIError(lastError.message || "Failed to read settings", "STORAGE_ERROR"));
          return;
        }
        resolve(value || defaults);
      });
    });
  }

  function environment() {
    return typeof process !== "undefined" && process && process.env
      ? process.env
      : Object.create(null);
  }

  async function readConfig(options) {
    const env = environment();
    const envKey = String(options.apiKey || env.DEEPSEEK_API_KEY || "").trim();

    // Node/local callers use environment variables directly. Keeping this path
    // ahead of storage also makes api.js testable without a chrome global.
    if (envKey) {
      return {
        key: envKey,
        model: String(options.model || env.DEEPSEEK_MODEL || DEFAULT_MODEL).trim(),
        targetLang: String(options.targetLang || env.TARGET_LANG || "zh-CN").trim()
      };
    }

    const [local, sync] = await Promise.all([
      storageGet("local", { byoKeys: {} }),
      storageGet("sync", {
        targetLang: "zh-CN",
        byoProvider: "",
        byoModel: "",
        byoModelBy: {}
      })
    ]);

    const keys = local.byoKeys || {};
    const key = String(keys.deepseek || "").trim();
    if (!key) {
      throw new AIAPIError(
        "DeepSeek API key is not configured. Save it on the existing settings page first.",
        "NO_DEEPSEEK_KEY"
      );
    }

    const models = sync.byoModelBy || {};
    const selectedDeepSeekModel = sync.byoProvider === "deepseek" ? sync.byoModel : "";
    const model = String(
      options.model || models.deepseek || selectedDeepSeekModel || DEFAULT_MODEL
    ).trim();
    const targetLang = String(options.targetLang || sync.targetLang || "zh-CN").trim();

    return { key, model, targetLang };
  }

  function meaningMessages(word, context, targetLang) {
    return [
      {
        role: "system",
        content:
          "You are a contextual vocabulary assistant. Explain what the selected word or " +
          "phrase means specifically in the provided context. Answer in " + targetLang +
          ". Be concise and learner-friendly. Explain the contextual meaning and nuance, " +
          "not the whole sentence. Do not translate or summarize the entire context. " +
          "Return only the explanation, without Markdown headings or fences."
      },
      {
        role: "user",
        content:
          "Selected word or phrase: " + word + "\n" +
          "Context: " + context + "\n\n" +
          "What does this word or phrase mean in this context?"
      }
    ];
  }

  async function responseError(response) {
    let detail = "";
    try {
      const raw = await response.text();
      try {
        const data = JSON.parse(raw);
        detail = data && data.error && (data.error.message || data.error.code);
      } catch (_error) {
        detail = raw;
      }
    } catch (_error) { /* no response body */ }

    detail = String(detail || "").trim().slice(0, 500);
    const suffix = detail ? ": " + detail : "";
    return new AIAPIError(
      "DeepSeek request failed (HTTP " + response.status + ")" + suffix,
      "HTTP_ERROR",
      response.status
    );
  }

  function contentFromEvent(line) {
    if (!line.startsWith("data:")) return null;
    const payload = line.slice(5).trimStart();
    if (!payload) return null;
    if (payload === "[DONE]") return { done: true, content: "" };

    let data;
    try {
      data = JSON.parse(payload);
    } catch (_error) {
      throw new AIAPIError("DeepSeek returned malformed stream data", "BAD_STREAM_DATA");
    }

    const choice = data && data.choices && data.choices[0];
    const delta = choice && choice.delta;
    return {
      done: false,
      content: typeof (delta && delta.content) === "string" ? delta.content : ""
    };
  }

  /**
   * Stream a contextual word-meaning explanation from DeepSeek.
   *
   * @param {string} sourceText Selected word or phrase.
   * @param {{context?: string, apiKey?: string, targetLang?: string, model?: string, signal?: AbortSignal}} [options]
   *        Explicit values override environment variables or stored settings.
   * @yields {string} Each explanation delta returned by DeepSeek.
   */
  async function* translateStream(sourceText, options) {
    if (typeof sourceText !== "string" || !sourceText.trim()) {
      throw new TypeError("sourceText must contain a selected word or phrase");
    }

    const opts = options || {};
    const config = await readConfig(opts);
    const word = sourceText.trim();
    const context = String(opts.context || "").trim();
    if (!context) throw new TypeError("options.context must be a non-empty string");
    let response;

    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + config.key
        },
        body: JSON.stringify({
          model: config.model,
          messages: meaningMessages(word, context, config.targetLang),
          temperature: 0.2,
          stream: true
        }),
        signal: opts.signal
      });
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      throw new AIAPIError(
        "Unable to reach DeepSeek. Check the network and the extension host permission.",
        "NETWORK_ERROR"
      );
    }

    if (!response.ok) throw await responseError(response);
    if (!response.body || typeof response.body.getReader !== "function") {
      throw new AIAPIError("This browser does not expose the response stream", "STREAM_UNAVAILABLE");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    try {
      while (true) {
        const result = await reader.read();
        buffered += decoder.decode(result.value || new Uint8Array(), { stream: !result.done });

        const lines = buffered.split(/\r?\n/);
        buffered = result.done ? "" : lines.pop();

        for (const line of lines) {
          const event = contentFromEvent(line);
          if (!event) continue;
          if (event.done) return;
          if (event.content) yield event.content;
        }

        if (result.done) {
          if (buffered) {
            const event = contentFromEvent(buffered);
            if (event && !event.done && event.content) yield event.content;
          }
          return;
        }
      }
    } finally {
      try { await reader.cancel(); } catch (_error) { /* stream already closed */ }
      try { reader.releaseLock(); } catch (_error) { /* lock already released */ }
    }
  }

  const api = Object.freeze({ translateStream });
  root.YTDS_AI_API = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
