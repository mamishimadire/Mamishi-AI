"use strict";

require("./load-env");

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const APP_NAME = "MAMISHI AI Voice";
const API_PORT = Number(process.env.API_PORT || 5001);
const API_SECRET = String(process.env.API_SECRET || "").trim();
const DEFAULT_PYTHON_BIN = path.join(os.homedir(), "tools", "python312-embed", "python.exe");
const PYTHON_BIN = resolvePythonBin(process.env.PYTHON_BIN);
const WHISPER_MODEL = process.env.WHISPER_MODEL || "base";

const LANGUAGE_NAMES = {
  en: "English",
  nso: "Sepedi",
  zu: "isiZulu",
  xh: "isiXhosa",
  st: "Sesotho",
  tn: "Setswana",
  af: "Afrikaans",
  ts: "Xitsonga",
  ss: "siSwati",
  ve: "Tshivenda",
  nr: "isiNdebele",
  sw: "Swahili",
  fr: "French",
  pt: "Portuguese",
  ar: "Arabic",
  hi: "Hindi",
  zh: "Chinese",
  es: "Spanish",
  de: "German",
};

const SPEECH_LANGUAGE_MAP = {
  english: "en",
  sepedi: "nso",
  "northern sotho": "nso",
  isizulu: "zu",
  zulu: "zu",
  isixhosa: "xh",
  xhosa: "xh",
  sesotho: "st",
  sotho: "st",
  setswana: "tn",
  tswana: "tn",
  afrikaans: "af",
  xitsonga: "ts",
  tsonga: "ts",
  siswati: "ss",
  swati: "ss",
  tshivenda: "ve",
  venda: "ve",
  isindebele: "nr",
  ndebele: "nr",
  swahili: "sw",
  french: "fr",
  portuguese: "pt",
  arabic: "ar",
  hindi: "hi",
  chinese: "zh",
  spanish: "es",
  german: "de",
};

function resolvePythonBin(value) {
  const normalized = String(value || "").trim();
  if (normalized && (normalized.includes("\\") || normalized.includes("/") || normalized.endsWith(".exe"))) {
    if (fs.existsSync(normalized)) return normalized;
  }
  if (fs.existsSync(DEFAULT_PYTHON_BIN)) return DEFAULT_PYTHON_BIN;
  return normalized || "python";
}

function runPy(script, cwd = __dirname, timeoutMs = 180_000) {
  return new Promise(resolve => {
    execFile(
      PYTHON_BIN,
      ["-c", script],
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
  });
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString("utf-8");
      if (body.length > 25_000_000) reject(new Error("Too large"));
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

function requireSecret(req, res) {
  const remote = String(req.socket?.remoteAddress || "").trim();
  if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") return true;
  if (!API_SECRET) return true;
  if (req.headers["x-api-secret"] === API_SECRET) return true;
  sendJson(res, 401, { error: "Unauthorized" });
  return false;
}

function normalizeLanguageCode(input) {
  const value = String(input || "").trim().toLowerCase();
  if (!value) return "";
  if (LANGUAGE_NAMES[value]) return value;
  return SPEECH_LANGUAGE_MAP[value] || value;
}

function languageName(code) {
  const normalized = normalizeLanguageCode(code);
  return LANGUAGE_NAMES[normalized] || normalized || "Unknown";
}

function buildLanguagesList() {
  return Object.entries(LANGUAGE_NAMES).map(([code, name]) => ({ code, name }));
}

async function transcribeAudio(body) {
  const script = `
import base64
import json
import os
import tempfile

result = {}
try:
    import whisper
    from langdetect import detect
    from deep_translator import GoogleTranslator
except Exception as exc:
    print(json.dumps({"error": f"Voice transcription dependency missing: {exc}. Install openai-whisper, langdetect, deep-translator, torch, torchvision, torchaudio, and ffmpeg."}))
    raise SystemExit(0)

audio_b64 = ${JSON.stringify(String(body.audio_base64 || ""))}
mime_type = ${JSON.stringify(String(body.mime_type || "audio/webm"))}
hint_lang = ${JSON.stringify(normalizeLanguageCode(body.language_code || body.language || ""))}
model_name = ${JSON.stringify(WHISPER_MODEL)}

if not audio_b64:
    print(json.dumps({"error": "No audio data received."}))
    raise SystemExit(0)

suffix = {
    "audio/webm": ".webm",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/mp4": ".mp4",
    "audio/m4a": ".m4a",
    "audio/ogg": ".ogg",
}.get(mime_type, ".webm")

fd, temp_path = tempfile.mkstemp(prefix="mamishi-voice-", suffix=suffix)
os.close(fd)
try:
    with open(temp_path, "wb") as handle:
        handle.write(base64.b64decode(audio_b64))

    model = whisper.load_model(model_name)
    kwargs = {}
    if hint_lang and hint_lang != "auto":
        kwargs["language"] = hint_lang
    transcription = model.transcribe(temp_path, task="transcribe", fp16=False, **kwargs)
    text = (transcription.get("text") or "").strip()
    detected = (transcription.get("language") or "").strip().lower()
    if not detected and text:
        try:
            detected = detect(text)
        except Exception:
            detected = ""

    english_text = text
    if text and detected and not detected.startswith("en"):
        try:
            english_text = GoogleTranslator(source="auto", target="en").translate(text)
        except Exception:
            english_text = text

    print(json.dumps({
        "text": text,
        "language_code": detected,
        "language_name": detected,
        "processing_text": english_text
    }))
finally:
    try:
        os.remove(temp_path)
    except OSError:
        pass
`;

  const result = await runPy(script, __dirname, 300_000);
  try {
    return JSON.parse(result.stdout.trim() || "{}");
  } catch {
    return { error: result.stderr.trim() || "Voice transcription failed. Check Whisper installation and ffmpeg." };
  }
}

async function translateText(body) {
  const source = normalizeLanguageCode(body.source_language || body.source_language_code || "auto") || "auto";
  const target = normalizeLanguageCode(body.target_language || body.target_language_code || "en") || "en";
  const text = String(body.text || "").trim();
  if (!text) return { error: "No text received." };

  const script = `
import json
try:
    from deep_translator import GoogleTranslator
except Exception as exc:
    print(json.dumps({"error": f"Missing translation dependency: {exc}"}))
    raise SystemExit(0)

text = ${JSON.stringify(text)}
source = ${JSON.stringify(source)}
target = ${JSON.stringify(target)}

try:
    translated = GoogleTranslator(source=source, target=target).translate(text)
except Exception as exc:
    print(json.dumps({"error": str(exc)}))
else:
    print(json.dumps({"translated_text": translated}))
`;

  const result = await runPy(script, __dirname, 120_000);
  try {
    return JSON.parse(result.stdout.trim() || "{}");
  } catch {
    return { error: result.stderr.trim() || "Translation failed." };
  }
}

async function speakText(body) {
  const language = normalizeLanguageCode(body.language || body.language_code || "en") || "en";
  const text = String(body.text || "").trim();
  if (!text) return { error: "No text received." };

  const script = `
from io import BytesIO
import base64
import json
try:
    from gtts import gTTS
    from gtts.lang import tts_langs
except Exception as exc:
    print(json.dumps({"error": f"Missing TTS dependency: {exc}"}))
    raise SystemExit(0)

lang = ${JSON.stringify(language)}
text = ${JSON.stringify(text)}
langs = tts_langs()

if lang not in langs:
    print(json.dumps({"supported": False, "language": lang}))
    raise SystemExit(0)

fp = BytesIO()
tld = "co.za" if lang == "en" else "com"
tts = gTTS(text=text, lang=lang, tld=tld)
tts.write_to_fp(fp)
print(json.dumps({
    "supported": True,
    "language": lang,
    "mime_type": "audio/mpeg",
    "audio_base64": base64.b64encode(fp.getvalue()).decode("ascii")
}))
`;

  const result = await runPy(script, __dirname, 120_000);
  try {
    const payload = JSON.parse(result.stdout.trim() || "{}");
    if (!payload.supported) {
      return {
        supported: false,
        language,
        reason: payload.error || `${language} is not supported by gTTS on this machine.`,
      };
    }
    return payload;
  } catch {
    return { error: result.stderr.trim() || "Speech generation failed." };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!requireSecret(req, res)) return;

  try {
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/voice/health")) {
      sendJson(res, 200, {
        ok: true,
        app: APP_NAME,
        python: PYTHON_BIN,
        whisper_model: WHISPER_MODEL,
        languages: buildLanguagesList(),
      });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/languages" || url.pathname === "/voice/languages")) {
      sendJson(res, 200, { languages: buildLanguagesList() });
      return;
    }

    if (req.method === "POST" && (url.pathname === "/transcribe" || url.pathname === "/voice/transcribe")) {
      const body = await parseBody(req);
      const result = await transcribeAudio(body);
      if (result.error) {
        sendJson(res, 500, result);
        return;
      }
      const detectedCode = normalizeLanguageCode(result.language_code);
      sendJson(res, 200, {
        text: String(result.text || "").trim(),
        detected_language_code: detectedCode,
        detected_language_name: languageName(detectedCode || result.language_name),
        processing_text: String(result.processing_text || result.text || "").trim(),
        preferred_output_language: languageName(detectedCode),
      });
      return;
    }

    if (req.method === "POST" && (url.pathname === "/translate" || url.pathname === "/voice/translate")) {
      const body = await parseBody(req);
      const result = await translateText(body);
      if (result.error) {
        sendJson(res, 500, result);
        return;
      }
      sendJson(res, 200, {
        translated_text: String(result.translated_text || "").trim(),
        target_language_code: normalizeLanguageCode(body.target_language || body.target_language_code || "en"),
      });
      return;
    }

    if (req.method === "POST" && (url.pathname === "/speak" || url.pathname === "/voice/speak")) {
      const body = await parseBody(req);
      const result = await speakText(body);
      if (result.error) {
        sendJson(res, 500, result);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: String(error.message || error) });
  }
});

server.listen(API_PORT, () => {
  console.log(`${APP_NAME} -> http://localhost:${API_PORT}`);
  console.log(`Python: ${PYTHON_BIN}`);
  console.log(`Whisper model: ${WHISPER_MODEL}`);
});
