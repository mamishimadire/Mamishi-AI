require("dotenv").config();

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { exec, execFile } = require("child_process");
const { tavily } = require("@tavily/core");
const Tesseract = require("tesseract.js");

const APP_NAME = "MAMISHI AI";
const AUTHOR_NAME = "Mamishi Tonny Madire";
const PORT = Number(process.env.PORT || 5000);

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434/api/chat";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TAVILY_KEY = process.env.TAVILY_API_KEY || "";
const tavilyClient = TAVILY_KEY ? tavily({ apiKey: TAVILY_KEY }) : null;

function parseKeyPool(...values) {
  return [...new Set(values
    .flatMap(value => String(value || "").split(/[\r\n,;]/))
    .map(value => value.trim())
    .filter(Boolean))];
}

const GEMINI_KEYS = parseKeyPool(
  process.env.GEMINI_API_KEYS,
  process.env.GEMINI_API_KEY,
  process.env.GOOGLE_API_KEY
);
const GEMINI_KEY_STATES = GEMINI_KEYS.map((key, index) => ({
  key,
  index,
  fails: 0,
  last: 0,
  cool: 60_000,
}));
let geminiCursor = 0;

const MODELS = {
  fast: process.env.OLLAMA_MODEL || "gpt-oss:120b-cloud",
  smart: process.env.OLLAMA_MODEL_SMART || "gpt-oss:120b-cloud",
  local: process.env.OLLAMA_MODEL_LOCAL || "llama3.2",
};

const BS = {
  gemini: { on: GEMINI_KEYS.length > 0, fails: 0, last: 0, cool: 60_000 },
  groq: { on: Boolean(GROQ_KEY), fails: 0, last: 0, cool: 30_000 },
  ollama: { on: true, fails: 0, last: 0, cool: 10_000 },
  tavily: { on: Boolean(tavilyClient), fails: 0, last: 0, cool: 30_000 },
};

const AGENT_WORKDIR = path.join(os.homedir(), "mamishi-ai-workspace");
const TEMPLATE_PATH = path.join(__dirname, "templates", "index.html");
const CORRECTION_MEMORY_PATH = path.join(__dirname, "correction-memory.json");
const ASSISTANT_PREFERENCES_PATH = path.join(__dirname, "assistant-preferences.json");
const MEMORY_PY_PATH = path.join(__dirname, "memory.py");
const PYTHON_BIN = process.env.PYTHON_BIN || path.join(os.homedir(), "tools", "python312-embed", "python.exe");

const PROJECTS = {
  general: path.join(AGENT_WORKDIR, "general"),
  sadtu: path.join(AGENT_WORKDIR, "sadtu"),
  hemis: path.join(AGENT_WORKDIR, "hemis"),
  tega: path.join(AGENT_WORKDIR, "tega"),
  personal: path.join(AGENT_WORKDIR, "personal"),
};

const FILE_TEXT_CACHE = new Map();
const TEXT_FILE_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".sql", ".py", ".js", ".ts", ".cs", ".html", ".htm", ".xml", ".yaml", ".yml", ".ini", ".log"
]);

fs.mkdirSync(AGENT_WORKDIR, { recursive: true });
Object.values(PROJECTS).forEach(projectPath => fs.mkdirSync(projectPath, { recursive: true }));

const FOUNDER_PROFILE = `${AUTHOR_NAME} was born on January 14, 1998, and raised in Burgersfort in the Sekhukhune District Municipality, Limpopo, South Africa. His home language is Sepedi. He completed Matric in 2016, then studied at the University of Johannesburg, completing a Diploma in Accountancy in 2021, an Advanced Diploma in Accountancy in 2022, and a BCom Honours in Internal Auditing in 2023.

He served as a tutor in Accounting, Internal Auditing, and Cost and Management Accounting, and also supported students as a Registration Assistant and Finance Officer. In 2024 he worked at Bidvest in the ALICE system environment, gaining exposure to system development, automation, data analytics, and audit innovation. In 2025 he joined SNG Grant Thornton as an ACCA Trainee in General Assurance.

His academic mentor was Lulama Boyce. In the corporate environment he was mentored by Frans Geldenhuys. His interests include auditing, technology, automation, Python, SQL, Excel automation, dashboards, and audit analytics. He is known for being the first person in his village to own a computer and gain internet exposure.`;

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current, up-to-date information.",
      parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_command",
      description: "Run a shell command on the user's local PC.",
      parameters: {
        type: "object",
        required: ["command"],
        properties: { command: { type: "string" }, workdir: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the local filesystem.",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file, creates or overwrites.",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders in a directory.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_data",
      description: "Analyze a CSV or Excel file, generate stats and chart.",
      parameters: {
        type: "object",
        required: ["file_path"],
        properties: { file_path: { type: "string" }, chart_type: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_document",
      description: "Create Word, Excel, PowerPoint, PDF, or HTML file.",
      parameters: {
        type: "object",
        required: ["doc_type", "filename", "content_description"],
        properties: {
          doc_type: { type: "string" },
          filename: { type: "string" },
          content_description: { type: "string" },
          data: { type: "string" },
        },
      },
    },
  },
];

const MEMORY_STOPWORDS = new Set([
  "about", "after", "again", "also", "am", "an", "and", "any", "are", "as", "at", "be", "because", "been",
  "before", "being", "between", "both", "but", "by", "can", "could", "did", "do", "does", "doing", "for",
  "from", "had", "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how", "i", "if",
  "in", "into", "is", "it", "its", "just", "me", "more", "most", "my", "no", "not", "now", "of", "on",
  "or", "other", "our", "out", "over", "please", "same", "she", "should", "so", "some", "such", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "those", "through", "to",
  "too", "true", "up", "use", "very", "was", "we", "were", "what", "when", "where", "which", "who", "why",
  "will", "with", "would", "you", "your",
]);

function buildGeminiUrl(apiKey) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?key=${apiKey}&alt=sse`;
}

function geminiKeyReady(state) {
  if (!state) return false;
  if (state.fails === 0) return true;
  return Date.now() - state.last > state.cool;
}

function anyGeminiReady() {
  return GEMINI_KEY_STATES.some(geminiKeyReady);
}

function nextGeminiKeyState() {
  if (!GEMINI_KEY_STATES.length) return null;
  for (let offset = 0; offset < GEMINI_KEY_STATES.length; offset += 1) {
    const index = (geminiCursor + offset) % GEMINI_KEY_STATES.length;
    const state = GEMINI_KEY_STATES[index];
    if (geminiKeyReady(state)) {
      geminiCursor = (index + 1) % GEMINI_KEY_STATES.length;
      return state;
    }
  }
  return null;
}

function markGeminiKeyFailed(state) {
  if (!state) return;
  state.fails += 1;
  state.last = Date.now();
  state.cool = Math.min(state.cool * 2, 15 * 60_000);
  console.log(`[GEMINI KEY] #${state.index + 1} failed (${state.fails}x), cooldown ${state.cool / 1000}s`);
}

function markGeminiKeySuccess(state) {
  if (!state || state.fails === 0) return;
  console.log(`[GEMINI KEY] #${state.index + 1} recovered`);
  state.fails = 0;
  state.cool = 60_000;
}

function ready(name) {
  if (name === "gemini") {
    return BS.gemini.on && anyGeminiReady();
  }
  const state = BS[name];
  if (!state.on) {
    return false;
  }
  if (state.fails === 0) {
    return true;
  }
  return Date.now() - state.last > state.cool;
}

function fail(name) {
  const state = BS[name];
  state.fails += 1;
  state.last = Date.now();
  state.cool = Math.min(state.cool * 2, 15 * 60_000);
  console.log(`[BACKEND] ${name} failed (${state.fails}x), cooldown ${state.cool / 1000}s`);
}

function ok(name) {
  if (BS[name].fails > 0) {
    console.log(`[BACKEND] ${name} recovered`);
    BS[name].fails = 0;
    BS[name].cool = name === "gemini" ? 60_000 : name === "ollama" ? 10_000 : 30_000;
  }
}

function normalizeProject(project = "general") {
  return Object.prototype.hasOwnProperty.call(PROJECTS, project) ? project : "general";
}

function getDir(project = "general") {
  return PROJECTS[normalizeProject(project)];
}

function resolvePath(project = "general", inputPath = "") {
  const base = getDir(project);
  if (!inputPath) {
    return base;
  }
  return path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(base, inputPath));
}

function buildSystemPrompt(project, backend) {
  const projectName = normalizeProject(project);
  const workdir = getDir(projectName);
  const assistantPreferences = loadAssistantPreferences();
  const preferencesText = assistantPreferences.length
    ? `\nStored response preferences:\n${assistantPreferences.map(item => `- ${item}`).join("\n")}`
    : "";
  return `You are ${APP_NAME}, a personal AI created for ${AUTHOR_NAME}.
You are fast, practical, clear, and adaptive.
Current project: ${projectName.toUpperCase()} -> ${workdir}
Active backend: ${backend}

Identity: Your name is ${APP_NAME}. Never say you are Claude, Gemini, Groq, or Llama.
If asked who built you: "${APP_NAME} was created by ${AUTHOR_NAME}."

Founder biography (answer when asked about Mamishi Tonny Madire):
${FOUNDER_PROFILE}

Behaviour:
- Answer directly when no tool is needed.
- Use tools only when they materially help.
- Match the response length to the user's need.
- Do not artificially shorten answers when the question needs detail, explanation, or full context.
- If the user asks for a full answer, complete answer, detailed answer, background, explanation, analysis, or professional response, answer fully.
- Be honest about uncertainty. Do not present guesses, assumptions, or estimates as verified facts.
- Never guess the current time, current date, live exchange rates, election dates, or other current facts. If they are not verified through a live or local source, say you are not sure and suggest how the user can verify them accurately.
- If a question is ambiguous, use the surrounding conversation context first. If it is still ambiguous, ask one short clarifying question instead of guessing.
- For current information, distinguish clearly between verified live facts, stable background knowledge, and rough estimates.
- Do not expose internal tool calls, shell commands, raw file paths, or execution traces unless the user explicitly asks for them.
- After using tools, give a plain-language answer that summarizes the result for the user.
- Never print pseudo-tool instructions or JSON plans such as {"action":"search",...}. Either use the tool silently or answer normally.
- Never narrate internal planning such as "we need to call a tool", "we should read the file", "assuming we have a tool", or similar. Just do the work and answer the user directly.
- If the user provides text, corrections, dates, or a proposed corrected answer, analyze that material directly instead of ignoring it.
- If live web search is unavailable, still answer from the user's provided material and from stable knowledge when possible. Only say verification is unavailable; do not stop there if enough context already exists.
- If the user corrects a factual answer with a specific corrected version, acknowledge it, update the answer, and treat the correction as preferred memory for future related questions.
- When answering about Mamishi Tonny Madire, use only the approved founder biography above and do not invent extra facts.
- If the user asks generally about Mamishi Tonny Madire, his background, biography, journey, education, work, or mentors, give a complete answer from the approved biography unless the user asks for a short version.
- If a founder-related question asks for a detail not covered in the approved biography, say that the detail is not in the approved profile.
- Never identify a person from a filename alone. Do not infer identity from uploaded file names such as personal names in the file name.
- If image understanding is unavailable, say you cannot reliably identify the person from the image and do not guess.
- Do not use write_file or create_document to store conversation memory unless the user explicitly asks to save, export, or create a file in the current turn.
- If the user says "remember this", "keep this information", or similar, keep it in the chat context only and do not write any file unless the user clearly asks for a file.
- Do not fabricate images, maps, files, or links. Only show a markdown image if you have a real image URL. If you need to show a map, prefer a real live map link or an HTML artifact.
- File operations run inside: ${workdir}
- For HTML output wrap entire document in <<<HTML_ARTIFACT>>>...<<<END_ARTIFACT>>>.
- Use markdown when useful.${preferencesText}`;
}

function shouldUseGemini(hasFiles, fileTypes) {
  if (!GEMINI_KEYS.length) {
    return false;
  }

  if (hasFiles) {
    const hasPdf = fileTypes.some(type => type === "application/pdf");
    const hasImage = fileTypes.some(type => (type || "").startsWith("image/"));
    if (hasPdf || hasImage) {
      console.log("[ROUTER] Gemini -> PDF/image detected");
      return true;
    }
  }
  return false;
}

function sendJson(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString("utf-8");
      if (body.length > 10_000_000) {
        reject(new Error("Too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function loadIndexHtml() {
  const template = await fsp.readFile(TEMPLATE_PATH, "utf8");
  return template.replaceAll("{{ app_name }}", APP_NAME).replaceAll("{{ author_name }}", AUTHOR_NAME);
}

function loadCorrectionMemory() {
  try {
    return JSON.parse(fs.readFileSync(CORRECTION_MEMORY_PATH, "utf8"));
  } catch {
    return [];
  }
}

function loadAssistantPreferences() {
  try {
    const items = JSON.parse(fs.readFileSync(ASSISTANT_PREFERENCES_PATH, "utf8"));
    return Array.isArray(items) ? items.map(item => String(item || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveCorrectionMemory(items) {
  fs.writeFileSync(CORRECTION_MEMORY_PATH, JSON.stringify(items.slice(0, 200), null, 2), "utf8");
}

function normalizeMemoryText(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function extractKeywords(text, max = 14) {
  const words = normalizeMemoryText(text).match(/[a-z0-9]{4,}/g) || [];
  return [...new Set(words.filter(word => !MEMORY_STOPWORDS.has(word)))].slice(0, max);
}

function isCorrectionMessage(text) {
  const value = normalizeMemoryText(text);
  if (!value) return false;

  return [
    "is this true",
    "this is false",
    "this is wrong",
    "partly correct",
    "outdated",
    "more accurate version",
    "corrected version",
    "bottom line",
    "for future use",
    "store correct information",
    "keep the information",
    "remember this correction",
  ].some(term => value.includes(term));
}

function hasDetailedUserContext(text) {
  const value = String(text || "");
  return value.length > 220 || value.includes("\n") || value.includes("•") || value.includes("✔") || value.includes("❌");
}

function extractPreferredCorrectionText(text) {
  const value = String(text || "").trim();
  if (!value) return "";

  const correctedVersion = value.match(/corrected version[:\s]*([\s\S]*)$/i);
  if (correctedVersion?.[1]) {
    return correctedVersion[1].replace(/\s+/g, " ").trim().slice(0, 900);
  }

  const accurateVersion = value.match(/more accurate version(?: would be)?[:\s]*([\s\S]*?)(?:bottom line|$)/i);
  if (accurateVersion?.[1]) {
    return accurateVersion[1].replace(/\s+/g, " ").trim().slice(0, 900);
  }

  const paragraphs = value.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
  return (paragraphs[paragraphs.length - 1] || value).replace(/\s+/g, " ").trim().slice(0, 900);
}

function captureCorrectionMemory(messages) {
  const lastUserText = getLastUserText(messages);
  if (!isCorrectionMessage(lastUserText)) return null;

  const priorAssistant = [...messages].reverse().find(message => message.role === "assistant");
  const combinedTopic = `${priorAssistant?.content || ""}\n${lastUserText}`.trim();
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    created_at: new Date().toISOString(),
    keywords: extractKeywords(combinedTopic),
    prompt: String(priorAssistant?.content || "").slice(0, 1200),
    correction: String(lastUserText).slice(0, 5000),
    preferred_answer: extractPreferredCorrectionText(lastUserText),
  };

  const items = loadCorrectionMemory();
  const duplicate = items.find(item => normalizeMemoryText(item.correction) === normalizeMemoryText(entry.correction));
  if (duplicate) return duplicate;

  items.unshift(entry);
  saveCorrectionMemory(items);
  return entry;
}

function findRelevantCorrectionMemory(messages) {
  const queryKeywords = extractKeywords(getLastUserText(messages), 18);
  if (!queryKeywords.length) return [];

  return loadCorrectionMemory()
    .map(item => ({
      item,
      score: queryKeywords.filter(keyword => item.keywords?.includes(keyword)).length,
    }))
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(result => result.item);
}

function buildCorrectionMemoryPrompt(messages) {
  const memories = findRelevantCorrectionMemory(messages);
  if (!memories.length) return "";

  const lines = memories.map((item, index) => {
    const preferred = extractPreferredCorrectionText(item.preferred_answer || item.correction);
    return `${index + 1}. Preferred corrected fact: ${preferred}`;
  });

  return `Relevant stored user corrections:\n${lines.join("\n")}\nThese corrected facts override older mistaken answers on the same topic unless you have newer verified evidence.`;
}

function runPy(script, cwd) {
  return new Promise(resolve => {
    execFile(
      PYTHON_BIN,
      ["-c", script],
      { cwd, timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
  });
}

function runMemoryCommand(args, options = {}) {
  const {
    stdinText = "",
    timeoutMs = 120_000,
  } = options;

  return new Promise(resolve => {
    const child = execFile(
      PYTHON_BIN,
      [MEMORY_PY_PATH, ...args],
      { cwd: __dirname, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );

    if (stdinText) {
      child.stdin?.write(stdinText);
    }
    child.stdin?.end();
  });
}

async function getMemoryContext(query) {
  if (!fs.existsSync(MEMORY_PY_PATH)) {
    return null;
  }
  const result = await runMemoryCommand(["context", query, "--json"], { timeoutMs: 60_000 });
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

async function getMemoryStatus() {
  if (!fs.existsSync(MEMORY_PY_PATH)) {
    return null;
  }
  const result = await runMemoryCommand(["status", "--json"], { timeoutMs: 60_000 });
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

async function indexKnowledgeFolder(folder) {
  if (!fs.existsSync(MEMORY_PY_PATH)) {
    return { error: "memory.py not found" };
  }
  const args = ["index", "--json"];
  if (folder) {
    args.push("--folder", folder);
  }
  const result = await runMemoryCommand(args, { timeoutMs: 15 * 60_000 });
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return { error: result.stderr || result.stdout || "Indexing failed" };
  }
}

async function rememberConversation(messages) {
  if (!fs.existsSync(MEMORY_PY_PATH)) {
    return;
  }

  const text = messages
    .slice(-10)
    .map(message => {
      const role = message.role === "assistant" ? "Assistant" : "User";
      if (typeof message.content === "string") {
        return `${role}: ${message.content}`;
      }
      return `${role}: ${getLastUserText([{ role: message.role, content: message.content }])}`;
    })
    .filter(Boolean)
    .join("\n");

  if (!text.trim()) {
    return;
  }

  await runMemoryCommand(["remember"], { stdinText: text, timeoutMs: 60_000 });
}

function getFileCacheKey(kind, base64Data) {
  return `${kind}:${crypto.createHash("sha1").update(base64Data).digest("hex")}`;
}

function getFileExtension(fileName = "") {
  return path.extname(String(fileName || "")).toLowerCase();
}

function isTextLikeFile(fileName = "", mimeType = "") {
  const extension = getFileExtension(fileName);
  return TEXT_FILE_EXTENSIONS.has(extension) || /^text\//i.test(mimeType) || /json|javascript|typescript|xml|yaml/i.test(mimeType);
}

async function writeBase64TempFile(base64Data, extension) {
  const tempDir = path.join(AGENT_WORKDIR, ".tmp");
  await fsp.mkdir(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}${extension}`);
  await fsp.writeFile(filePath, Buffer.from(base64Data, "base64"));
  return filePath;
}

function getImageExtension(fileName = "", mimeType = "") {
  const extension = getFileExtension(fileName);
  if (extension) {
    return extension;
  }
  const normalizedMime = String(mimeType || "").toLowerCase();
  if (normalizedMime === "image/jpeg") return ".jpg";
  if (normalizedMime === "image/png") return ".png";
  if (normalizedMime === "image/webp") return ".webp";
  if (normalizedMime === "image/gif") return ".gif";
  if (normalizedMime === "image/bmp") return ".bmp";
  return ".png";
}

async function extractTextLikeFile(base64Data, fileName = "") {
  const cacheKey = getFileCacheKey(`text:${getFileExtension(fileName) || "plain"}`, base64Data);
  if (FILE_TEXT_CACHE.has(cacheKey)) {
    return FILE_TEXT_CACHE.get(cacheKey);
  }

  let parsed;
  try {
    const raw = Buffer.from(base64Data, "base64").toString("utf8");
    parsed = { text: raw.slice(0, 30000) };
  } catch {
    parsed = { error: "Text extraction failed" };
  }
  FILE_TEXT_CACHE.set(cacheKey, parsed);
  return parsed;
}

async function extractPdf(base64Data) {
  const cacheKey = getFileCacheKey("pdf", base64Data);
  if (FILE_TEXT_CACHE.has(cacheKey)) {
    return FILE_TEXT_CACHE.get(cacheKey);
  }

  let tempFile = null;
  try {
    tempFile = await writeBase64TempFile(base64Data, ".pdf");
    const result = await runPy(
      `
import json
try:
    import fitz
    fp = ${JSON.stringify(tempFile)}
    doc = fitz.open(fp)
    pages = []
    for i, page in enumerate(doc):
        text = page.get_text().strip()
        if text:
            pages.append(f"--- Page {i+1} ---\\n{text}")
    output = "\\n\\n".join(pages[:30])
    print(json.dumps({"text": output[:50000], "pages": len(doc)}))
except ImportError:
    print(json.dumps({"error": "Run: pip install pymupdf"}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`,
      AGENT_WORKDIR
    );
    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      parsed = { error: result.stderr || "PDF extraction failed" };
    }
    FILE_TEXT_CACHE.set(cacheKey, parsed);
    return parsed;
  } finally {
    if (tempFile) {
      await fsp.unlink(tempFile).catch(() => {});
    }
  }
}

async function extractImage(base64Data, fileName = "", mimeType = "") {
  const cacheKey = getFileCacheKey("image", base64Data);
  if (FILE_TEXT_CACHE.has(cacheKey)) {
    return FILE_TEXT_CACHE.get(cacheKey);
  }

  let tempFile = null;
  try {
    tempFile = await writeBase64TempFile(base64Data, getImageExtension(fileName, mimeType));
    const result = await runPy(
      `
import json
try:
    from PIL import Image
    import pytesseract
    fp = ${JSON.stringify(tempFile)}
    img = Image.open(fp)
    text = pytesseract.image_to_string(img)
    print(json.dumps({"text": text.strip()[:20000]}))
except ImportError as e:
    print(json.dumps({"error": f"Run: pip install pytesseract pillow - {e}"}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`,
      AGENT_WORKDIR
    );
    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      parsed = { error: result.stderr || "Image OCR failed" };
    }

    const needsFallback = !String(parsed?.text || "").trim();
    if (needsFallback) {
      try {
        const ocr = await Tesseract.recognize(tempFile, "eng", { logger: () => {} });
        const text = String(ocr?.data?.text || "").trim().slice(0, 20000);
        if (text) {
          parsed = { text, source: "tesseract.js" };
        } else if (!parsed?.error) {
          parsed = { error: "No readable text found in image." };
        }
      } catch (error) {
        if (!parsed?.error) {
          parsed = { error: String(error.message || error) };
        }
      }
    }

    FILE_TEXT_CACHE.set(cacheKey, parsed);
    return parsed;
  } finally {
    if (tempFile) {
      await fsp.unlink(tempFile).catch(() => {});
    }
  }
}

async function extractSpreadsheet(base64Data, fileName = "") {
  const extension = getFileExtension(fileName) || ".xlsx";
  const cacheKey = getFileCacheKey(`sheet:${extension}`, base64Data);
  if (FILE_TEXT_CACHE.has(cacheKey)) {
    return FILE_TEXT_CACHE.get(cacheKey);
  }

  let tempFile = null;
  try {
    tempFile = await writeBase64TempFile(base64Data, extension);
    const result = await runPy(
      `
import json, os
try:
    import pandas as pd
    fp = ${JSON.stringify(tempFile)}
    ext = os.path.splitext(fp)[1].lower()
    previews = []
    if ext == ".csv":
        sheets = {"Sheet1": pd.read_csv(fp)}
    else:
        sheets = pd.read_excel(fp, sheet_name=None)
    for name, df in list(sheets.items())[:3]:
        preview = df.head(8).fillna("").astype(str).to_dict(orient="records")
        previews.append({
            "sheet": str(name),
            "rows": int(len(df.index)),
            "columns": [str(c) for c in df.columns.tolist()],
            "preview": preview
        })
    print(json.dumps({"sheets": previews}))
except ImportError as e:
    print(json.dumps({"error": f"Run: pip install openpyxl pandas - {e}"}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`,
      AGENT_WORKDIR
    );
    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      parsed = { error: result.stderr || "Spreadsheet extraction failed" };
    }
    FILE_TEXT_CACHE.set(cacheKey, parsed);
    return parsed;
  } finally {
    if (tempFile) {
      await fsp.unlink(tempFile).catch(() => {});
    }
  }
}

async function extractDocx(base64Data, fileName = "") {
  const extension = getFileExtension(fileName) || ".docx";
  const cacheKey = getFileCacheKey(`docx:${extension}`, base64Data);
  if (FILE_TEXT_CACHE.has(cacheKey)) {
    return FILE_TEXT_CACHE.get(cacheKey);
  }

  let tempFile = null;
  try {
    tempFile = await writeBase64TempFile(base64Data, extension);
    const result = await runPy(
      `
import json
try:
    from docx import Document
    fp = ${JSON.stringify(tempFile)}
    doc = Document(fp)
    lines = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
    print(json.dumps({"text": "\\n".join(lines)[:30000]}))
except ImportError as e:
    print(json.dumps({"error": f"Run: pip install python-docx - {e}"}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`,
      AGENT_WORKDIR
    );
    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      parsed = { error: result.stderr || "DOCX extraction failed" };
    }
    FILE_TEXT_CACHE.set(cacheKey, parsed);
    return parsed;
  } finally {
    if (tempFile) {
      await fsp.unlink(tempFile).catch(() => {});
    }
  }
}

async function extractPptx(base64Data, fileName = "") {
  const extension = getFileExtension(fileName) || ".pptx";
  const cacheKey = getFileCacheKey(`pptx:${extension}`, base64Data);
  if (FILE_TEXT_CACHE.has(cacheKey)) {
    return FILE_TEXT_CACHE.get(cacheKey);
  }

  let tempFile = null;
  try {
    tempFile = await writeBase64TempFile(base64Data, extension);
    const result = await runPy(
      `
import json
try:
    from pptx import Presentation
    fp = ${JSON.stringify(tempFile)}
    prs = Presentation(fp)
    slides = []
    for i, slide in enumerate(prs.slides):
        texts = []
        for shape in slide.shapes:
            if hasattr(shape, "text") and shape.text.strip():
                texts.append(shape.text.strip())
        if texts:
            slides.append(f"--- Slide {i+1} ---\\n" + "\\n".join(texts))
    print(json.dumps({"text": "\\n\\n".join(slides)[:30000]}))
except ImportError as e:
    print(json.dumps({"error": f"Run: pip install python-pptx - {e}"}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`,
      AGENT_WORKDIR
    );
    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      parsed = { error: result.stderr || "PPTX extraction failed" };
    }
    FILE_TEXT_CACHE.set(cacheKey, parsed);
    return parsed;
  } finally {
    if (tempFile) {
      await fsp.unlink(tempFile).catch(() => {});
    }
  }
}

async function toText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content || "");
  }

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if (part.type === "text" && part.text) {
      parts.push(part.text);
      continue;
    }
    if ((part.type === "file" || part.type === "image") && part.base64 && isTextLikeFile(part.name, part.mimeType)) {
      const result = await extractTextLikeFile(part.base64, part.name);
      parts.push(
        result.error
          ? `[Text file: ${part.name} - extraction failed: ${result.error}]`
          : `[Text file content: ${part.name}]\n${result.text}`
      );
      continue;
    }
    if (part.type === "file" && part.mimeType === "application/pdf" && part.base64) {
      console.log(`[EXTRACT] PDF: ${part.name || "file.pdf"}`);
      const result = await extractPdf(part.base64);
      parts.push(
        result.error
          ? `[PDF: ${part.name} - extraction failed: ${result.error}]`
          : `[PDF Content: ${part.name} (${result.pages} pages)]\n\n${result.text}`
      );
      continue;
    }
    if (part.type === "file" && part.base64 && [".xlsx", ".xls", ".csv"].includes(getFileExtension(part.name))) {
      console.log(`[EXTRACT] Spreadsheet: ${part.name || "sheet"}`);
      const result = await extractSpreadsheet(part.base64, part.name);
      if (result.error) {
        parts.push(`[Spreadsheet: ${part.name} - extraction failed: ${result.error}]`);
      } else {
        const previewText = (result.sheets || []).map(sheet => {
          const rows = (sheet.preview || []).map(row => JSON.stringify(row)).join("\n");
          return `--- ${sheet.sheet} (${sheet.rows} rows) ---\nColumns: ${(sheet.columns || []).join(", ")}\n${rows}`;
        }).join("\n\n");
        parts.push(`[Spreadsheet content: ${part.name}]\n${previewText}`.slice(0, 30000));
      }
      continue;
    }
    if (part.type === "file" && part.base64 && getFileExtension(part.name) === ".docx") {
      console.log(`[EXTRACT] DOCX: ${part.name || "document.docx"}`);
      const result = await extractDocx(part.base64, part.name);
      parts.push(
        result.error
          ? `[DOCX: ${part.name} - extraction failed: ${result.error}]`
          : `[Document content: ${part.name}]\n${result.text}`
      );
      continue;
    }
    if (part.type === "file" && part.base64 && getFileExtension(part.name) === ".pptx") {
      console.log(`[EXTRACT] PPTX: ${part.name || "slides.pptx"}`);
      const result = await extractPptx(part.base64, part.name);
      parts.push(
        result.error
          ? `[PPTX: ${part.name} - extraction failed: ${result.error}]`
          : `[Presentation content: ${part.name}]\n${result.text}`
      );
      continue;
    }
    if (part.type === "image" && part.base64) {
      console.log(`[EXTRACT] Image OCR: ${part.name || "image"}`);
      const result = await extractImage(part.base64, part.name, part.mimeType);
      parts.push(
        result.error
          ? `[Image: ${part.name} - OCR failed: ${result.error}]`
          : result.text
            ? `[Image text via OCR: ${part.name}]\n${result.text}`
            : `[Image: ${part.name} - no text found]`
      );
      continue;
    }
    if (part.name) {
      parts.push(`[File: ${part.name}]`);
    }
  }

  return parts.join("\n\n").trim() || "(no content)";
}

function toGeminiParts(content) {
  if (typeof content === "string") {
    return [{ text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ text: String(content || "") }];
  }

  const parts = [];
  for (const part of content) {
    if (part.type === "text" && part.text) {
      parts.push({ text: part.text });
    } else if (part.type === "image" && part.base64) {
      parts.push({ inline_data: { mime_type: part.mimeType || "image/jpeg", data: part.base64 } });
    } else if (part.type === "file" && part.base64) {
      parts.push({ inline_data: { mime_type: part.mimeType || "application/pdf", data: part.base64 } });
    }
  }
  return parts.length ? parts : [{ text: "(no content)" }];
}

function detectFiles(messages) {
  let hasFiles = false;
  const types = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part && (part.type === "image" || part.type === "file") && part.base64) {
        hasFiles = true;
        types.push(part.mimeType || "");
      }
    }
  }
  return { hasFiles, types };
}

function getLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      return messages[i];
    }
  }
  return null;
}

function getPreviousUserText(messages) {
  let seenLatest = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (!seenLatest) {
      seenLatest = true;
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      const textPart = message.content.find(part => part.type === "text");
      if (textPart?.text) return textPart.text;
    }
  }
  return "";
}

function getLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      const textPart = message.content.find(part => part.type === "text");
      if (textPart) {
        return textPart.text || "";
      }
    }
  }
  return "";
}

function isShortFollowUpAffirmation(text) {
  return /^(do|okay|ok|yes|yeah|yep|sure|please do|go ahead|continue|retry)$/i.test(String(text || "").trim());
}

function getEffectiveUserText(messages) {
  const lastUserText = getLastUserText(messages).trim();
  if (!isShortFollowUpAffirmation(lastUserText)) {
    return lastUserText;
  }

  const previousUserText = getPreviousUserText(messages).trim();
  const previousAssistant = [...messages].reverse().find(message => message.role === "assistant");
  const assistantText = String(previousAssistant?.content || "");

  if (/current live rate|exact conversion|exchange rate|convert/i.test(assistantText) && previousUserText) {
    return `${previousUserText} current live rate exact conversion`;
  }
  if (/show.*map|live map|open in google maps|openstreetmap/i.test(assistantText) && previousUserText) {
    return previousUserText;
  }
  if (/\bcurrent time\b|\blive time\b|\bcurrent date\b|\btoday'?s date\b|\bdevice clock\b|\blive clock\b/i.test(assistantText) && previousUserText) {
    return `${previousUserText} current live time`;
  }
  return previousUserText || lastUserText;
}

function isImageIdentityQuery(messages) {
  const lastUserMessage = getLastUserMessage(messages);
  const text = getLastUserText(messages).toLowerCase().trim();
  if (!lastUserMessage || !Array.isArray(lastUserMessage.content) || !text) {
    return false;
  }

  const hasImage = lastUserMessage.content.some(part => part?.type === "image" && part.base64);
  if (!hasImage) {
    return false;
  }

  return [
    "who is this",
    "who is this person",
    "identify this person",
    "identify this image",
    "who is he",
    "who is she",
    "what person is this",
  ].some(term => text.includes(term));
}

function buildImageIdentityFallbackAnswer() {
  return "I can't reliably identify the person in this image with the current vision path, and I won't guess from the filename or appearance alone. If you want, upload a clearer image or tell me who you think it might be and I can help verify or provide background.";
}

function detectRealtimeIntent(text) {
  const normalized = String(text || "").toLowerCase().trim();
  if (!normalized) {
    return { asksTime: false, asksDate: false, asksOtherZone: false };
  }

  const asksTime =
    /\bwhat(?:'s| is)?\s+(?:the\s+)?time(?:\s+now)?\b|\bcurrent time\b|\btime is it\b|\bwhat time is it\b|\btime now\b|\bthe time now\b|\blive time\b|\bshow live time\b|\bprovide live time\b/.test(normalized) ||
    (/\btime\b/.test(normalized) && /\b(now|current|please|tell|give|exact|live|correct|show|provide)\b/.test(normalized));

  const asksDate =
    /\bwhat(?:'s| is)?\s+(?:the\s+)?date(?:\s+today)?\b|\bcurrent date\b|\btoday'?s date\b|\bwhat day is it\b|\bwhat is today'?s date\b|\bdate today\b/.test(normalized) ||
    (/\bdate\b/.test(normalized) && /\b(today|current|now|please|tell|give|exact)\b/.test(normalized));

  const asksOtherZone =
    /\b(utc|gmt|est|pst|cst|ist|cet|eet)\b/.test(normalized) ||
    /\btime\s+in\s+[a-z]/.test(normalized) ||
    /\bdate\s+in\s+[a-z]/.test(normalized);

  return { asksTime, asksDate, asksOtherZone };
}

function buildRealtimeFallbackAnswer(messages) {
  const text = getEffectiveUserText(messages).toLowerCase().trim();
  const { asksTime, asksDate } = detectRealtimeIntent(text);
  if (!asksTime && !asksDate) {
    return null;
  }
  if (asksTime && asksDate) {
    return "I’m not sure enough to give you an exact current time and date from the model alone. Please check your device clock or ask again once the live clock path is available.";
  }
  if (asksTime) {
    return "I’m not sure enough to give you an exact current time from the model alone. Please check your device clock or ask again once the live clock path is available.";
  }
  return "I’m not sure enough to give you an exact current date from the model alone. Please check your device calendar or ask again once the live clock path is available.";
}

function isAttachmentOverviewQuery(messages) {
  const lastUserMessage = getLastUserMessage(messages);
  const text = getLastUserText(messages).toLowerCase().trim();
  if (!lastUserMessage || !Array.isArray(lastUserMessage.content)) {
    return false;
  }

  const hasNonImageFile = lastUserMessage.content.some(part => part?.type === "file" && part.base64);
  if (!hasNonImageFile) {
    return false;
  }

  if (!text) {
    return true;
  }

  return [
    "what is this",
    "what is this file",
    "what is in this file",
    "summarize this file",
    "summarise this file",
    "describe this file",
    "explain this file",
    "review this file",
    "analyze this file",
    "analyse this file",
    "check this file",
    "tell me about this file",
  ].some(term => text.includes(term));
}

function isImageOverviewQuery(messages) {
  const lastUserMessage = getLastUserMessage(messages);
  const text = getLastUserText(messages).toLowerCase().trim();
  if (!lastUserMessage || !Array.isArray(lastUserMessage.content)) {
    return false;
  }

  const hasImage = lastUserMessage.content.some(part => part?.type === "image" && part.base64);
  if (!hasImage) {
    return false;
  }

  if (!text) {
    return true;
  }

  return [
    "what is this",
    "what is in this image",
    "what is in this picture",
    "what is in this screenshot",
    "read this",
    "read this image",
    "read this screenshot",
    "read this picture",
    "extract text",
    "extract the text",
    "what does this say",
    "describe this image",
    "describe this screenshot",
    "explain this image",
    "explain this screenshot",
  ].some(term => text.includes(term));
}

function normalizeSnippet(text, maxLength = 800) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function extractOpeningLines(text, maxLines = 8, maxLength = 600) {
  const lines = String(text || "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, maxLines);
  return normalizeSnippet(lines.join("\n"), maxLength);
}

async function buildAttachmentOverviewAnswer(messages) {
  const lastUserMessage = getLastUserMessage(messages);
  if (!lastUserMessage || !Array.isArray(lastUserMessage.content)) {
    return null;
  }

  const filePart = lastUserMessage.content.find(part => part?.type === "file" && part.base64);
  if (!filePart) {
    return null;
  }

  const name = filePart.name || "uploaded file";
  const extension = getFileExtension(name);

  if ([".xlsx", ".xls", ".csv"].includes(extension)) {
    const result = await extractSpreadsheet(filePart.base64, name);
    if (result?.error) {
      return `I can see you uploaded \`${name}\`, but I couldn't extract a reliable spreadsheet preview from it right now. If you want, try again and I can analyze the workbook structure or extract the data once the file-reading path is available.`;
    }

    const sheets = Array.isArray(result.sheets) ? result.sheets : [];
    if (!sheets.length) {
      return `\`${name}\` looks like a spreadsheet file, but I couldn't find any readable sheet data in the preview.`;
    }

    const summaryLines = sheets.slice(0, 3).map(sheet => {
      const sample = Array.isArray(sheet.preview) && sheet.preview.length
        ? sheet.preview[0]
        : null;
      const sampleText = sample
        ? Object.entries(sample).slice(0, 4).map(([key, value]) => `${key}: ${value}`).join(", ")
        : "No sample rows in preview";
      return `- Sheet \`${sheet.sheet}\` has ${sheet.rows} row(s) with columns: ${(sheet.columns || []).join(", ")}. Sample: ${sampleText}.`;
    }).join("\n");

    return `\`${name}\` is a spreadsheet workbook.\n\nI can already read its structure:\n${summaryLines}\n\nIf you want, I can next summarize trends, total values, anomalies, or turn the data into a cleaner report.`;
  }

  if (extension === ".docx") {
    const result = await extractDocx(filePart.base64, name);
    if (result?.error) {
      return `I can see you uploaded \`${name}\`, but I couldn't extract the document text reliably right now.`;
    }
    const opening = extractOpeningLines(result.text, 8, 700);
    return `\`${name}\` is a Word document. The opening content suggests it begins with:\n\n${opening || "(No readable opening text found.)"}\n\nIf you want, I can summarize the full document or extract the key points.`;
  }

  if (extension === ".pptx") {
    const result = await extractPptx(filePart.base64, name);
    if (result?.error) {
      return `I can see you uploaded \`${name}\`, but I couldn't extract the slide text reliably right now.`;
    }
    const opening = extractOpeningLines(result.text, 10, 700);
    return `\`${name}\` is a PowerPoint presentation. The readable slide text starts like this:\n\n${opening || "(No readable slide text found.)"}\n\nIf you want, I can summarize the deck or pull out the main themes slide by slide.`;
  }

  if (extension === ".pdf") {
    const result = await extractPdf(filePart.base64);
    if (result?.error) {
      return `I can see you uploaded \`${name}\`, but I couldn't extract readable PDF text from it right now.`;
    }
    const opening = extractOpeningLines(result.text, 10, 700);
    return `\`${name}\` is a PDF document${result.pages ? ` with ${result.pages} page(s)` : ""}. The opening text starts like this:\n\n${opening || "(No readable opening text found.)"}\n\nIf you want, I can summarize it in more detail or extract specific sections.`;
  }

  if (isTextLikeFile(name, filePart.mimeType)) {
    const result = await extractTextLikeFile(filePart.base64, name);
    if (result?.error) {
      return `I can see you uploaded \`${name}\`, but I couldn't decode the file contents reliably right now.`;
    }
    const opening = extractOpeningLines(result.text, 10, 700);
    return `\`${name}\` is a text-based file. The opening content is:\n\n${opening || "(No readable text found.)"}\n\nIf you want, I can explain it, summarize it, or help you work with it.`;
  }

  return `I can see you uploaded \`${name}\`. I can work with it, but I need a more specific prompt than “what is this” for this file type. Ask me to summarize it, extract key details, or explain a specific section.`;
}

async function buildImageOverviewAnswer(messages) {
  const lastUserMessage = getLastUserMessage(messages);
  if (!lastUserMessage || !Array.isArray(lastUserMessage.content)) {
    return null;
  }

  const imagePart = lastUserMessage.content.find(part => part?.type === "image" && part.base64);
  if (!imagePart) {
    return null;
  }

  const name = imagePart.name || "uploaded image";
  const result = await extractImage(imagePart.base64, imagePart.name, imagePart.mimeType);
  if (result?.error) {
    return `I can see you uploaded \`${name}\`, but I couldn't extract readable text from it reliably right now. If you want, try a clearer screenshot or ask a more specific question about what is shown in the image.`;
  }

  const opening = extractOpeningLines(result.text, 12, 1200);
  if (!opening) {
    return `I can see you uploaded \`${name}\`, but I couldn't find clear readable text in it. If you want, I can still help if you tell me what part of the image you want me to focus on.`;
  }

  return `\`${name}\` looks like an image or screenshot with readable text.\n\nThe extracted text starts like this:\n\n${opening}\n\nIf you want, I can summarize it, check whether the information is accurate, or explain what it means.`;
}

function buildRealtimeAnswer(messages) {
  const text = getEffectiveUserText(messages).toLowerCase().trim();
  if (!text) return null;

  const { asksTime, asksDate, asksOtherZone } = detectRealtimeIntent(text);

  if (!asksTime && !asksDate) {
    return null;
  }

  if (asksOtherZone) {
    return null;
  }

  const now = new Date();
  const timeZone = "Africa/Johannesburg";
  const timeText = new Intl.DateTimeFormat("en-ZA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(now);
  const dateText = new Intl.DateTimeFormat("en-ZA", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);

  if (asksTime && asksDate) {
    return `The current time is ${timeText}, and today is ${dateText}.`;
  }
  if (asksTime) {
    return `The current time is ${timeText}.`;
  }
  return `Today is ${dateText}.`;
}

function buildRealtimeFallbackAnswer(messages) {
  const text = getEffectiveUserText(messages).toLowerCase().trim();
  const { asksTime, asksDate } = detectRealtimeIntent(text);
  if (!asksTime && !asksDate) {
    return null;
  }
  if (asksTime && asksDate) {
    return "I'm not sure enough to give you an exact current time and date from the model alone. Please check your device clock or ask again once the live clock path is available.";
  }
  if (asksTime) {
    return "I'm not sure enough to give you an exact current time from the model alone. Please check your device clock or ask again once the live clock path is available.";
  }
  return "I'm not sure enough to give you an exact current date from the model alone. Please check your device calendar or ask again once the live clock path is available.";
}

function extractMapQuery(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return "";

  const patterns = [
    /\bshow me (?:the )?map of\s+(.+)$/i,
    /\bshow (?:the )?map of\s+(.+)$/i,
    /\bmap of\s+(.+)$/i,
    /\bmap for\s+(.+)$/i,
    /\bwhere is\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/[?.!]+$/, "").trim();
    }
  }
  if (/\bmap\b/i.test(text)) {
    return text.replace(/[?.!]+$/, "").trim();
  }
  return "";
}

function buildMapAnswer(messages) {
  const rawText = getLastUserText(messages).trim();
  const place = extractMapQuery(rawText);
  if (!place) return null;

  const encoded = encodeURIComponent(place);
  const safeTitle = place.replace(/[<>&"]/g, "");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Map of ${safeTitle}</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: Georgia, serif; background: #f3efe5; color: #1b1b18; }
    .shell { padding: 18px; }
    .card { background: #fffdf7; border: 1px solid #d8cfbe; border-radius: 18px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.08); }
    .head { padding: 16px 18px; background: linear-gradient(135deg, #e7ddca, #f7f1e5); border-bottom: 1px solid #d8cfbe; }
    .eyebrow { font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #746754; }
    h1 { margin: 6px 0 0; font-size: 28px; line-height: 1.1; }
    iframe { width: 100%; height: 460px; border: 0; display: block; background: #ece7db; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; padding: 16px 18px 20px; }
    a { text-decoration: none; color: #1b1b18; background: #efe4cf; border: 1px solid #d4c4a8; border-radius: 999px; padding: 10px 14px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <div class="head">
        <div class="eyebrow">Live Map</div>
        <h1>${safeTitle}</h1>
      </div>
      <iframe
        src="https://www.google.com/maps?q=${encoded}&output=embed"
        loading="lazy"
        referrerpolicy="no-referrer-when-downgrade"
        title="Map of ${safeTitle}"></iframe>
      <div class="actions">
        <a href="https://www.google.com/maps/search/?api=1&query=${encoded}" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>
        <a href="https://www.openstreetmap.org/search?query=${encoded}" target="_blank" rel="noopener noreferrer">Open in OpenStreetMap</a>
      </div>
    </div>
  </div>
</body>
</html>`;

  return `Here's a live map for ${place}.\n\n<<<HTML_ARTIFACT>>>${html}<<<END_ARTIFACT>>>`;
}

function isFounderQuery(messages) {
  const text = getLastUserText(messages).toLowerCase();
  if (!text) return false;

  return [
    "mamishi",
    "tonny",
    "madire",
    "who is he",
    "who is him",
    "about him",
    "his background",
    "background",
    "biography",
    "bio",
    "journey",
    "mentor",
    "mentors",
  ].some(term => text.includes(term));
}

function shouldAutoSearch(messages) {
  if (!tavilyClient && !BS.tavily.on) return false;
  if (isFounderQuery(messages)) return false;

  const text = getEffectiveUserText(messages).toLowerCase();
  if (!text) return false;
  if (isCorrectionMessage(text) && hasDetailedUserContext(text)) return false;

  const entityLookup = [
    "who is",
    "who are",
    "who was",
    "who were",
    "tell me about",
    "what is",
    "what are",
    "when did",
    "when was",
    "when is",
    "where is",
    "where are",
    "how much is",
    "how many",
    "what happened",
    "what happened to",
    "define ",
    "explain ",
  ].some(term => text.startsWith(term) || text.includes(" " + term));

  if (entityLookup) return true;

  return [
    "latest",
    "current",
    "today",
    "tonight",
    "recent",
    "result",
    "results",
    "score",
    "scores",
    "price",
    "prices",
    "weather",
    "news",
    "update",
    "updates",
    "exchange",
    "rate",
    "rates",
    "conversion",
    "convert",
    "currency",
    "usd",
    "zar",
    "eur",
    "gbp",
    "draw",
    "jackpot",
    "lotto",
    "loto",
    "powerball",
  ].some(term => text.includes(term));
}

function buildSearchQuery(messages) {
  const text = getEffectiveUserText(messages).replace(/\s+/g, " ").trim();
  if (!text) return "";

  if (text.length <= 320) {
    return text;
  }

  const firstSentence = text.split(/(?<=[.!?])\s+/)[0]?.trim();
  if (firstSentence && firstSentence.length <= 320) {
    return firstSentence;
  }

  const keywords = extractKeywords(text, 12);
  if (keywords.length) {
    return keywords.join(" ").slice(0, 320);
  }

  return text.slice(0, 320);
}

function formatSearchContext(searchResult, originalQuery) {
  if (searchResult.error) {
    return [
      `Live web search for the user's latest question failed.`,
      `Original question: ${originalQuery}`,
      "Temporary verification issue.",
      "If the user has already provided candidate facts, dates, or a corrected version, analyze that material directly.",
      "If the question requires live verification and you do not have enough reliable context, say: At the moment I can't provide a verified answer. Please try again later.",
    ].join("\n");
  }
  if (!searchResult.results?.length) {
    return [
      `No live web results were found for the user's latest question.`,
      `Original question: ${originalQuery}`,
      "Answer from general knowledge only if it is still reliable; otherwise say: At the moment I can't provide a verified answer. Please try again later.",
    ].join("\n");
  }

  return [
    `Current web search results for the user's latest question: ${searchResult.query}`,
    ...searchResult.results.map((item, index) => `${index + 1}. ${item.title}\nURL: ${item.url}\nSummary: ${item.content}`),
    "Use these results directly in the answer. Do not ask to search again unless the results are clearly insufficient.",
  ].join("\n\n");
}

function shouldExposeTools(messages) {
  const text = getLastUserText(messages).toLowerCase();
  if (!text) return false;

  return [
    "latest",
    "current",
    "today",
    "news",
    "search",
    "web",
    "price",
    "open",
    "read",
    "write",
    "create file",
    "save",
    "folder",
    "directory",
    "command",
    "run ",
    "terminal",
    "shell",
    "csv",
    "excel",
    "spreadsheet",
    "analyze data",
    "analyse data",
    "document",
    "ppt",
    "pdf",
  ].some(term => text.includes(term));
}

function chooseGroqMaxTokens(messages) {
  const text = getLastUserText(messages).trim();
  if (isFounderQuery(messages)) return 1800;
  if (!text) return 1024;
  if (text.length <= 40) return 384;
  if (text.length <= 120) return 768;
  if (text.length <= 280) return 1280;
  return 2048;
}

function toolExecuteCommand(command, workdir, project = "general") {
  return new Promise(resolve => {
    const cwd = workdir ? resolvePath(project, workdir) : getDir(project);
    exec(command, { cwd, timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ error: "Timed out" });
        return;
      }
      resolve({
        returncode: error && Number.isInteger(error.code) ? error.code : 0,
        stdout: String(stdout || "").slice(0, 4000),
        stderr: String(stderr || "").slice(0, 2000),
        cwd,
      });
    });
  });
}

async function toolReadFile(filePath, project = "general") {
  try {
    const resolved = resolvePath(project, filePath);
    const content = await fsp.readFile(resolved, "utf8");
    return { path: resolved, content: content.slice(0, 20000), size: content.length };
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

async function toolWriteFile(filePath, content, project = "general") {
  try {
    const resolved = resolvePath(project, filePath);
    await fsp.mkdir(path.dirname(resolved), { recursive: true });
    await fsp.writeFile(resolved, content, "utf8");
    return { path: resolved, bytes_written: Buffer.byteLength(content, "utf8") };
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

async function toolListDir(dirPath, project = "general") {
  try {
    const resolved = dirPath ? resolvePath(project, dirPath) : getDir(project);
    const entries = await fsp.readdir(resolved, { withFileTypes: true });
    const result = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(resolved, entry.name);
      result.push({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file",
        size: entry.isFile() ? (await fsp.stat(fullPath)).size : null,
      });
    }
    return { path: resolved, entries: result, count: result.length };
  } catch (error) {
    return { error: String(error.message || error) };
  }
}

function stripHtmlTags(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDuckDuckGoHref(href = "") {
  try {
    if (/^https?:\/\//i.test(href)) return href;
    const url = new URL(href, "https://html.duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return href;
  }
}

async function fallbackWebSearch(query, priorError = "") {
  try {
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      },
    });
    const html = await response.text();
    const results = [];
    const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>|<div[^>]*class="result__snippet"[^>]*>)([\s\S]*?)(?:<\/a>|<\/div>)/gi;
    let match;
    while ((match = resultPattern.exec(html)) && results.length < 5) {
      results.push({
        title: stripHtmlTags(match[2]).slice(0, 200),
        url: decodeDuckDuckGoHref(match[1]),
        content: stripHtmlTags(match[3]).slice(0, 500),
      });
    }
    if (results.length) {
      BS.tavily.on = true;
      ok("tavily");
      return { query, results, count: results.length };
    }
    return { error: priorError || "No search results found." };
  } catch (error) {
    return { error: priorError || String(error.message || error) };
  }
}

async function toolWebSearch(query) {
  const safeQuery = String(query || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!safeQuery) {
    return { error: "Empty search query." };
  }
  if (!tavilyClient) {
    BS.tavily.on = false;
    return fallbackWebSearch(safeQuery, "Tavily is unavailable.");
  }
  try {
    const response = await tavilyClient.search(safeQuery, { searchDepth: "basic", maxResults: 5 });
    BS.tavily.on = true;
    ok("tavily");
    return {
      query: safeQuery,
      results: (response.results || []).map(item => ({
        title: item.title || "",
        url: item.url || "",
        content: String(item.content || "").slice(0, 500),
      })),
      count: (response.results || []).length,
    };
  } catch (error) {
    const message = String(error.message || error);
    if (/unauthorized|invalid api key|missing api key/i.test(message)) {
      BS.tavily.on = false;
    }
    fail("tavily");
    return fallbackWebSearch(safeQuery, message);
  }
}

async function toolAnalyzeData(filePath, chartType = "bar", project = "general") {
  const resolved = resolvePath(project, filePath);
  const chartOut = resolved.replace(/\.[^.]+$/, "_chart.png");
  const result = await runPy(
    `
import json, pandas as pd, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fp = ${JSON.stringify(resolved)}
co = ${JSON.stringify(chartOut)}
ct = ${JSON.stringify(chartType)}
df = pd.read_csv(fp) if fp.lower().endswith(".csv") else pd.read_excel(fp)
info = {"rows": int(len(df)), "columns": int(len(df.columns)), "column_names": list(df.columns), "summary": {}}
for c in df.select_dtypes(include="number").columns:
    info["summary"][c] = {"min": float(df[c].min()), "max": float(df[c].max()), "mean": round(float(df[c].mean()), 2), "sum": float(df[c].sum())}
nc = df.select_dtypes(include="number").columns.tolist()
if nc:
    fig, ax = plt.subplots(figsize=(10, 5))
    if ct == "pie":
        df[nc[0]].head(10).plot.pie(ax=ax, autopct="%1.1f%%")
    elif ct == "line":
        df[nc[:4]].head(50).plot(ax=ax, kind="line", marker="o", markersize=3)
    elif ct == "hist":
        df[nc[0]].plot(ax=ax, kind="hist", bins=20, color="#f28c38")
    else:
        df[nc[:3]].head(20).plot(ax=ax, kind="bar", color=["#f28c38", "#5b9cf6", "#4ade80"])
    plt.tight_layout()
    plt.savefig(co, dpi=120, bbox_inches="tight")
    plt.close()
    info["chart_saved"] = co
print(json.dumps(info))
`,
    getDir(project)
  );
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return { ...parsed, chart_path: parsed.chart_saved || null };
  } catch {
    return { error: result.stderr || result.stdout || String(result.error) };
  }
}

async function toolCreateDocument(docType, filename, description, data, project = "general") {
  const outPath = resolvePath(project, filename);

  if (docType === "html") {
    const html = String(description).includes("<html")
      ? description
      : `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>MAMISHI AI</title><style>body{font-family:Arial,sans-serif;padding:40px;max-width:900px;margin:0 auto}</style></head><body>${description}</body></html>`;
    return toolWriteFile(outPath, html, project);
  }

  const scripts = {
    xlsx: `import json,openpyxl;wb=openpyxl.Workbook();ws=wb.active;ws.title="Data"\ntry:\n rows=json.loads(${JSON.stringify(data || "[]")})\n if rows and isinstance(rows[0],dict):\n  headers=list(rows[0].keys())\n  ws.append(headers)\n  [ws.append([r.get(h,"") for h in headers]) for r in rows]\n except Exception:\n  ws.append([${JSON.stringify(description)}])\nwb.save(${JSON.stringify(outPath)});print("OK")`,
    docx: `from docx import Document;doc=Document()\nfor l in ${JSON.stringify(description)}.splitlines():\n l=l.strip()\n if not l:doc.add_paragraph("")\n elif l.startswith("# "):doc.add_heading(l[2:],1)\n elif l.startswith("## "):doc.add_heading(l[3:],2)\n elif l.startswith("- ") or l.startswith("* "):doc.add_paragraph(l[2:],"List Bullet")\n else:doc.add_paragraph(l)\ndoc.save(${JSON.stringify(outPath)});print("OK")`,
    pptx: `from pptx import Presentation;prs=Presentation()\nfor s in ${JSON.stringify(description)}.split("---"):\n lines=[l.strip() for l in s.splitlines() if l.strip()]\n sl=prs.slides.add_slide(prs.slide_layouts[1])\n sl.shapes.title.text=lines[0] if lines else "Slide"\n sl.placeholders[1].text="\\n".join(lines[1:]) if len(lines)>1 else ""\nprs.save(${JSON.stringify(outPath)});print("OK")`,
    pdf: `import fitz;doc=fitz.open();page=doc.new_page();rect=fitz.Rect(50,50,545,792);page.insert_textbox(rect, ${JSON.stringify(description)} or "Generated by MAMISHI AI.", fontsize=12, fontname="helv", color=(0,0,0));doc.save(${JSON.stringify(outPath)});doc.close();print("OK")`,
  };

  const script = scripts[docType];
  if (!script) {
    return { error: `Unsupported: ${docType}. Use docx, xlsx, pptx, pdf, html.` };
  }

  const result = await runPy(script, getDir(project));
  if (result.stdout.includes("OK")) {
    return { path: outPath, created: true, message: `Saved: ${path.basename(outPath)}` };
  }
  return { error: result.stderr || result.stdout || String(result.error) };
}

async function runTool(name, args, project = "general") {
  if (name === "web_search") return toolWebSearch(args.query);
  if (name === "execute_command") return toolExecuteCommand(args.command, args.workdir, project);
  if (name === "read_file") return toolReadFile(args.path, project);
  if (name === "write_file") return toolWriteFile(args.path, args.content, project);
  if (name === "list_dir") return toolListDir(args.path, project);
  if (name === "analyze_data") return toolAnalyzeData(args.file_path, args.chart_type || "bar", project);
  if (name === "create_document") return toolCreateDocument(args.doc_type, args.filename, args.content_description, args.data || "[]", project);
  return { error: `Unknown tool: ${name}` };
}

async function streamGemini(messages, res, systemPrompt, apiKey) {
  const contents = messages
    .filter(message => message.role !== "system" && message.role !== "tool")
    .map(message => ({ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) }));

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: [
      {
        function_declarations: TOOL_SCHEMAS.map(tool => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      },
    ],
  };

  const response = await fetch(buildGeminiUrl(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => "");
    if (response.status === 429 || response.status === 503) {
      throw new Error(`QUOTA:${response.status}:${errText}`);
    }
    throw new Error(`Gemini:${response.status}:${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") {
        continue;
      }
      try {
        const chunk = JSON.parse(raw);
        for (const part of chunk.candidates?.[0]?.content?.parts || []) {
          if (part.text) {
            content += part.text;
            sendSse(res, { text: part.text });
          }
          if (part.functionCall) {
            toolCalls.push({
              type: "function",
              function: { index: toolCalls.length, name: part.functionCall.name, arguments: part.functionCall.args || {} },
            });
          }
        }
      } catch {
        continue;
      }
    }
  }

  return { role: "assistant", content, tool_calls: toolCalls };
}

async function streamGroq(messages, res, systemPrompt) {
  const processed = [];
  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    processed.push({ role: message.role === "assistant" ? "assistant" : "user", content: await toText(message.content) });
  }

  const exposeTools = shouldExposeTools(messages);

  const body = {
    model: GROQ_MODEL,
    messages: [{ role: "system", content: systemPrompt }, ...processed],
    temperature: 0.3,
    stream: true,
    max_tokens: chooseGroqMaxTokens(messages),
  };
  if (exposeTools) {
    body.tools = TOOL_SCHEMAS;
    body.tool_choice = "auto";
  }

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => "");
    if (response.status === 429) {
      throw new Error(`QUOTA:429:${errText}`);
    }
    throw new Error(`Groq:${response.status}:${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") {
        continue;
      }
      try {
        const chunk = JSON.parse(raw);
        const delta = chunk.choices?.[0]?.delta || {};
        if (delta.content) {
          content += delta.content;
          sendSse(res, { text: delta.content });
        }
        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const index = toolCall.index || 0;
            if (!toolCalls[index]) {
              toolCalls[index] = { type: "function", function: { index, name: "", arguments: "" } };
            }
            if (toolCall.function?.name) {
              toolCalls[index].function.name += toolCall.function.name;
            }
            if (toolCall.function?.arguments) {
              toolCalls[index].function.arguments += toolCall.function.arguments;
            }
          }
        }
      } catch {
        continue;
      }
    }
  }

  const parsedCalls = toolCalls.filter(Boolean).map(toolCall => {
    try {
      return { ...toolCall, function: { ...toolCall.function, arguments: JSON.parse(toolCall.function.arguments || "{}") } };
    } catch {
      return { ...toolCall, function: { ...toolCall.function, arguments: {} } };
    }
  });

  return { role: "assistant", content, tool_calls: parsedCalls };
}

function mergeToolCall(toolMap, call) {
  const index = call.function?.index ?? toolMap.size;
  const current = toolMap.get(index) || { type: "function", function: { index, name: "", arguments: {} } };
  current.function.name = call.function?.name || current.function.name;
  current.function.arguments = { ...current.function.arguments, ...(call.function?.arguments || {}) };
  toolMap.set(index, current);
}

async function streamOllama(messages, res, modelKey, systemPrompt) {
  const processed = [];
  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    processed.push({ role: message.role === "assistant" ? "assistant" : "user", content: await toText(message.content) });
  }

  const model = MODELS[modelKey] || MODELS.fast;
  const exposeTools = shouldExposeTools(messages);
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...processed],
      stream: true,
      keep_alive: "10m",
      ...(exposeTools ? { tools: TOOL_SCHEMAS } : {}),
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Ollama:${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolMap = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const chunk = JSON.parse(trimmed);
      const message = chunk.message || {};
      if (message.content) {
        content += message.content;
        sendSse(res, { text: message.content });
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          mergeToolCall(toolMap, call);
        }
      }
    }
  }

  if (buffer.trim()) {
    const chunk = JSON.parse(buffer.trim());
    const message = chunk.message || {};
    if (message.content) {
      content += message.content;
      sendSse(res, { text: message.content });
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        mergeToolCall(toolMap, call);
      }
    }
  }

  return {
    role: "assistant",
    content,
    tool_calls: Array.from(toolMap.values()).sort((a, b) => (a.function.index || 0) - (b.function.index || 0)),
  };
}

async function agentLoop(messages, res, systemPrompt, modelKey, project) {
  const { hasFiles, types } = detectFiles(messages);
  const preferredBackend = shouldUseGemini(hasFiles, types) && ready("gemini")
    ? "gemini"
    : ready("groq")
      ? "groq"
      : "ollama";
  let usedBackend = null;
  const executedToolSignatures = new Set();
  let toolRounds = 0;
  let autoSearchInjected = false;
  let autoSearchResult = null;
  const imageIdentityQuery = isImageIdentityQuery(messages);

  if (preferredBackend === "gemini") sendSse(res, { backend_info: "Gemini" });
  else if (preferredBackend === "groq") sendSse(res, { backend_info: "Groq" });
  else sendSse(res, { backend_info: "Ollama" });

  async function callBackend(workingMessages) {
    if (preferredBackend === "gemini" && usedBackend === null && ready("gemini")) {
      const keyState = nextGeminiKeyState();
      if (keyState) {
        try {
          const result = await streamGemini(workingMessages, res, systemPrompt, keyState.key);
          markGeminiKeySuccess(keyState);
          ok("gemini");
          usedBackend = "gemini";
          return result;
        } catch (error) {
          const message = String(error.message || error);
          const isQuota = message.startsWith("QUOTA");
          console.log(`[FALLBACK] Gemini ${isQuota ? "quota" : "error"} -> ${imageIdentityQuery ? "local safe fallback" : "Groq"}`);
          markGeminiKeyFailed(keyState);
          if (!anyGeminiReady()) {
            fail("gemini");
          }
          if (imageIdentityQuery) {
            const fallbackText = buildImageIdentityFallbackAnswer();
            sendSse(res, { text: fallbackText });
            usedBackend = "local";
            return { role: "assistant", content: fallbackText, tool_calls: [] };
          }
          sendSse(res, {
            notice: isQuota
              ? "Gemini limit reached - switching to Groq"
              : "Gemini error - switching to Groq",
          });
        }
      }
    }

    if (ready("groq") && usedBackend !== "ollama") {
      try {
        const result = await streamGroq(workingMessages, res, systemPrompt);
        ok("groq");
        usedBackend = "groq";
        return result;
      } catch (error) {
        const isQuota = String(error.message || error).startsWith("QUOTA");
        console.log(`[FALLBACK] Groq ${isQuota ? "quota" : "error"} -> Ollama`);
        sendSse(res, {
          notice: isQuota
            ? "Groq limit reached - switching to Ollama"
            : "Groq error - switching to Ollama",
        });
        fail("groq");
      }
    }

    try {
      const result = await streamOllama(workingMessages, res, modelKey, systemPrompt);
      ok("ollama");
      usedBackend = "ollama";
      return result;
    } catch (error) {
      fail("ollama");
      throw new Error(`All backends failed: ${error.message}`);
    }
  }

  const workingMessages = [...messages];
  while (true) {
    if (!autoSearchInjected && shouldAutoSearch(workingMessages) && findRelevantCorrectionMemory(workingMessages).length === 0) {
      autoSearchInjected = true;
      const query = buildSearchQuery(workingMessages);
      sendSse(res, { tool_start: { name: "web_search", input: { query } } });
      autoSearchResult = await toolWebSearch(query);
      sendSse(res, { tool_end: { name: "web_search", result: autoSearchResult } });
      workingMessages.push({ role: "user", content: formatSearchContext(autoSearchResult, query) });
    }

    toolRounds += 1;
    if (toolRounds > 6) {
      sendSse(res, { notice: "Stopping repeated tool loop" });
      break;
    }

    const assistantMessage = await callBackend(workingMessages);
    const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
    if (!assistantMessage.content && !toolCalls.length && autoSearchResult?.error && !hasDetailedUserContext(getLastUserText(workingMessages))) {
      sendSse(res, { text: "At the moment I can't provide a verified answer. Please try again later." });
      break;
    }
    if (assistantMessage.content || toolCalls.length) {
      workingMessages.push(assistantMessage);
    }
    if (!toolCalls.length) {
      break;
    }

    for (const call of toolCalls) {
      const toolName = call.function?.name;
      const toolArgs = call.function?.arguments || {};
      const toolSignature = `${toolName}:${JSON.stringify(toolArgs)}`;

      if (executedToolSignatures.has(toolSignature)) {
        const duplicateResult = { skipped: true, message: `Skipped duplicate ${toolName} call in the same response.` };
        sendSse(res, { tool_start: { name: toolName, input: toolArgs } });
        sendSse(res, { tool_end: { name: toolName, result: duplicateResult } });
        workingMessages.push({ role: "tool", tool_name: toolName, content: JSON.stringify(duplicateResult) });
        continue;
      }

      executedToolSignatures.add(toolSignature);
      sendSse(res, { tool_start: { name: toolName, input: toolArgs } });
      const result = await runTool(toolName, toolArgs, project);
      sendSse(res, { tool_end: { name: toolName, result } });
      workingMessages.push({ role: "tool", tool_name: toolName, content: JSON.stringify(result) });
    }
  }

  return usedBackend;
}

async function handleChat(req, res) {
  const body = await parseBody(req);
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const project = normalizeProject(body.project || "general");
  const modelKey = Object.prototype.hasOwnProperty.call(MODELS, body.model) ? body.model : "fast";

  if (!rawMessages.length) {
    sendJson(res, 400, { error: "No messages provided" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  try {
    const baseSystemPrompt = buildSystemPrompt(project, "auto");
    const messages = [
      { role: "system", content: baseSystemPrompt },
      ...rawMessages.map(message => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      })),
    ];
    const effectiveQuery = getEffectiveUserText(messages) || getLastUserText(messages);

    const realtimeAnswer = buildRealtimeAnswer(messages);
    if (realtimeAnswer) {
      sendSse(res, { text: realtimeAnswer });
      sendSse(res, { done: true, backend: "local" });
      console.log("[CHAT] Done via: local clock shortcut");
      return;
    }

    const realtimeFallback = buildRealtimeFallbackAnswer(messages);
    if (realtimeFallback) {
      sendSse(res, { text: realtimeFallback });
      sendSse(res, { done: true, backend: "local" });
      console.log("[CHAT] Done via: realtime safety fallback");
      return;
    }

    const mapAnswer = buildMapAnswer(messages);
    if (mapAnswer) {
      sendSse(res, { text: mapAnswer });
      sendSse(res, { done: true, backend: "local" });
      console.log("[CHAT] Done via: local map shortcut");
      return;
    }

    if (isAttachmentOverviewQuery(messages)) {
      const attachmentAnswer = await buildAttachmentOverviewAnswer(messages);
      if (attachmentAnswer) {
        sendSse(res, { text: attachmentAnswer });
        sendSse(res, { done: true, backend: "local" });
        console.log("[CHAT] Done via: local attachment overview");
        return;
      }
    }

    if (!isImageIdentityQuery(messages) && isImageOverviewQuery(messages)) {
      const imageAnswer = await buildImageOverviewAnswer(messages);
      if (imageAnswer) {
        sendSse(res, { text: imageAnswer });
        sendSse(res, { done: true, backend: "local" });
        console.log("[CHAT] Done via: local image overview");
        return;
      }
    }

    captureCorrectionMemory(messages);
    const correctionMemoryPrompt = buildCorrectionMemoryPrompt(messages);
    const memoryContext = await getMemoryContext(effectiveQuery);
    const memoryPrompt = memoryContext?.has_context
      ? `Relevant retrieved memory and document context:\n${memoryContext.context}\nUse this only when it helps answer the user's question accurately.`
      : "";
    const systemPrompt = [baseSystemPrompt, correctionMemoryPrompt, memoryPrompt]
      .filter(Boolean)
      .join("\n\n");

    const backend = await agentLoop(messages, res, systemPrompt, modelKey, project);
    await rememberConversation(
      rawMessages.map(message => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: typeof message.content === "string" ? message.content : "",
      }))
    );
    sendSse(res, { done: true, backend });
    console.log(`[CHAT] Done via: ${backend}`);
  } catch (error) {
    sendSse(res, { error: String(error.message || error) });
    console.error("[CHAT ERROR]", error.message || error);
  } finally {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await loadIndexHtml());
      return;
    }

    if (req.method === "GET" && url.pathname === "/workdir") {
      const memoryStatus = await getMemoryStatus();
      sendJson(res, 200, {
        workdir: AGENT_WORKDIR,
        projects: PROJECTS,
        routing: "Groq=default | Ollama=fallback | Tavily=web-search",
        backends: {
          gemini: { available: GEMINI_KEYS.length > 0, ready: ready("gemini"), model: GEMINI_MODEL, key_count: GEMINI_KEYS.length, active: false },
          groq: { available: Boolean(GROQ_KEY), ready: ready("groq"), model: GROQ_MODEL, key: Boolean(GROQ_KEY) },
          ollama: { available: true, ready: ready("ollama"), models: MODELS },
          tavily: { available: BS.tavily.on, ready: ready("tavily") },
        },
        memory: memoryStatus,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/memory/status") {
      const memoryStatus = await getMemoryStatus();
      sendJson(res, 200, memoryStatus || { error: "Memory status unavailable" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/memory/index") {
      const body = await parseBody(req);
      const folder = String(body.folder || "").trim();
      const result = await indexKnowledgeFolder(folder || undefined);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/chat") {
      await handleChat(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/clear") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: String(error.message || error) });
  }
});

server.listen(PORT, () => {
  console.log(`\n${APP_NAME} -> http://localhost:${PORT}`);
  console.log("\nSMART ROUTING:");
  console.log("  Groq   -> default request path");
  console.log("  Ollama -> fallback when Groq fails or hits limits");
  console.log("  Tavily -> automatic web search for current/live questions");
  console.log("\nBackends:");
  console.log(`  Gemini : ${GEMINI_KEYS.length ? `${GEMINI_MODEL} (${GEMINI_KEYS.length} key(s), standby only)` : "not configured"}`);
  console.log(`  Groq   : ${GROQ_KEY ? `${GROQ_MODEL}` : "not configured"}`);
  console.log(`  Ollama : ${MODELS.fast}`);
  console.log(`\nTavily   : ${tavilyClient ? "enabled" : "not configured"}`);
  console.log("File reading:");
  console.log("  Groq   -> PDFs via PyMuPDF, images via pytesseract OCR");
  console.log("  Ollama -> same as Groq");
  console.log("Optional Python deps: pip install pymupdf pytesseract pillow");
  console.log(`Workspace: ${AGENT_WORKDIR}\n`);
});
