const http = require("http");

const APP_NAME = "MAMISHI AI";
const AUTHOR_NAME = "Mamishi Tonny Madire";
const API_PORT = Number(process.env.API_PORT || 5001);
const API_SECRET = process.env.API_SECRET || "mamishi-dev-key";
const FLASK_CHAT_URL = process.env.FLASK_CHAT_URL || "http://127.0.0.1:5000/chat";
const FLASK_HEALTH_URL = process.env.FLASK_HEALTH_URL || "http://127.0.0.1:5000/";
const FLASK_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434/api/chat";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gpt-oss:120b-cloud";

const SYSTEM_PROMPT = `You are ${APP_NAME}, a personal AI created for ${AUTHOR_NAME}.
You are smart, innovative, practical, and deeply focused on problem solving.
Be concise, useful, and professional.

Identity rules:
- Never present yourself as Claude. Your name is ${APP_NAME}.
- If asked who built or authored you, say: "${APP_NAME} was created by ${AUTHOR_NAME}."`;

function sendJson(res, code, payload) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString("utf-8");
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
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

async function isFlaskAvailable() {
  try {
    const response = await fetch(FLASK_HEALTH_URL, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

async function askViaFlask(question) {
  const response = await fetch(FLASK_CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "user", content: question },
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Flask backend failed: ${response.status} ${details}`.trim());
  }

  const raw = await response.text();
  const lines = raw.split(/\r?\n/);
  let answer = "";

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    try {
      const data = JSON.parse(line.slice(6));
      if (data.error) {
        throw new Error(data.error);
      }
      if (data.text) {
        answer += data.text;
      }
    } catch (error) {
      if (error instanceof Error) throw error;
    }
  }

  return answer.trim();
}

async function chatViaFlask(messages) {
  const response = await fetch(FLASK_CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Flask backend failed: ${response.status} ${details}`.trim());
  }

  const raw = await response.text();
  const lines = raw.split(/\r?\n/);
  let answer = "";

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = JSON.parse(line.slice(6));
    if (data.error) {
      throw new Error(data.error);
    }
    if (data.text) {
      answer += data.text;
    }
  }

  return answer.trim();
}

async function askViaOllama(question) {
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: question },
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Ollama backend failed: ${response.status} ${details}`.trim());
  }

  const payload = await response.json();
  return String(payload?.message?.content || "").trim();
}

function normalizeMessages(messages) {
  return messages
    .filter(message => message && typeof message === "object")
    .map(message => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || "").trim(),
    }))
    .filter(message => message.content);
}

async function chatViaOllama(messages) {
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...normalizeMessages(messages),
      ],
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Ollama backend failed: ${response.status} ${details}`.trim());
  }

  const payload = await response.json();
  return String(payload?.message?.content || "").trim();
}

function buildAskPrompt(question, context = "") {
  const trimmedQuestion = String(question || "").trim();
  const trimmedContext = String(context || "").trim();
  if (!trimmedContext) {
    return trimmedQuestion;
  }
  return `Context:\n${trimmedContext}\n\nQuestion:\n${trimmedQuestion}`;
}

async function askQuestion(question, context = "") {
  const prompt = buildAskPrompt(question, context);
  if (await isFlaskAvailable()) {
    try {
      const answer = await askViaFlask(prompt);
      return { answer, backend: "flask", model: FLASK_MODEL };
    } catch (error) {
      const fallbackAnswer = await askViaOllama(prompt);
      return {
        answer: fallbackAnswer,
        backend: "ollama",
        model: OLLAMA_MODEL,
        fallback_from: "flask",
        fallback_reason: String(error.message || error),
      };
    }
  }

  const answer = await askViaOllama(prompt);
  return { answer, backend: "ollama", model: OLLAMA_MODEL };
}

async function chatMessages(messages) {
  const normalized = normalizeMessages(messages);
  if (!normalized.length) {
    throw new Error("At least one message is required");
  }

  if (await isFlaskAvailable()) {
    try {
      const answer = await chatViaFlask(normalized);
      return { answer, backend: "flask", model: FLASK_MODEL };
    } catch (error) {
      const fallbackAnswer = await chatViaOllama(normalized);
      return {
        answer: fallbackAnswer,
        backend: "ollama",
        model: OLLAMA_MODEL,
        fallback_from: "flask",
        fallback_reason: String(error.message || error),
      };
    }
  }

  const answer = await chatViaOllama(normalized);
  return { answer, backend: "ollama", model: OLLAMA_MODEL };
}

function formatDuration(startTime) {
  return `${Date.now() - startTime}ms`;
}

function isAuthorized(req) {
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" && apiKey === API_SECRET;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        status: "ok",
        service: "mamishi-api",
        app: APP_NAME,
        port: API_PORT,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ask") {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const startedAt = Date.now();
      const body = await parseBody(req);
      const question = String(body.question || "").trim();
      if (!question) {
        sendJson(res, 400, { error: "Question is required" });
        return;
      }

      const context = String(body.context || "").trim();
      const result = await askQuestion(question, context);
      sendJson(res, 200, {
        answer: result.answer,
        question,
        model: result.model,
        duration: formatDuration(startedAt),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const startedAt = Date.now();
      const body = await parseBody(req);
      if (!Array.isArray(body.messages) || !body.messages.length) {
        sendJson(res, 400, { error: "messages array is required" });
        return;
      }

      const result = await chatMessages(body.messages);
      sendJson(res, 200, {
        message: {
          role: "assistant",
          content: result.answer,
        },
        model: result.model,
        duration: formatDuration(startedAt),
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: String(error.message || error) });
  }
});

server.listen(API_PORT, () => {
  console.log(`${APP_NAME} API running at http://localhost:${API_PORT}`);
  console.log(`x-api-key required for /api/ask and /api/chat`);
});
