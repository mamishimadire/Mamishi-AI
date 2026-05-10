"use strict";

const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, ".env");

if (fs.existsSync(ENV_PATH)) {
  const raw = fs.readFileSync(ENV_PATH, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1");

    if (key && value && !process.env[key]) {
      process.env[key] = value;
    }
  }
  console.log("[ENV] .env loaded");
} else {
  console.log("[ENV] No .env file - using system environment variables");
}
