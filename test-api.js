"use strict";

const { translateStream } = require("./api.js");

const sourceText = process.argv.slice(2).join(" ").trim() ||
  "Artificial intelligence is changing the way people work.";

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("Missing DEEPSEEK_API_KEY environment variable.");
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  (async () => {
    for await (const chunk of translateStream(sourceText, { signal: controller.signal })) {
      process.stdout.write(chunk);
    }
    process.stdout.write("\n");
  })().catch((error) => {
    if (error && error.name === "AbortError") {
      process.stderr.write("\nRequest cancelled.\n");
      process.exitCode = 130;
      return;
    }
    console.error("\nTranslation failed:", error.code || error.name, error.message);
    process.exitCode = 1;
  });
}
