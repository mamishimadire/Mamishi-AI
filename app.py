from flask import Flask, Response, jsonify, render_template, request, stream_with_context
import google.generativeai as genai
import json
import mimetypes
import os
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from tavily import TavilyClient

app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True

# Configure Gemini
API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
TAVILY_API_KEY = os.environ.get("TAVILY_API_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434/api/chat")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")
genai.configure(api_key=API_KEY)
tavily_client = TavilyClient(api_key=TAVILY_API_KEY) if TAVILY_API_KEY else None

APP_NAME = "MAMISHI AI"
AUTHOR_NAME = "Mamishi Tonny Madire"
AGENT_WORKDIR = os.path.expanduser("~/mamishi-ai-workspace")
MODEL_NAME = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
ACTIVITY_LOG_PATH = os.path.join(os.path.dirname(__file__), "activity_log.json")
os.makedirs(AGENT_WORKDIR, exist_ok=True)

MAX_ACTIVITY_ITEMS = 40

BACKEND_STATE = {
    "gemini": {"available": bool(API_KEY), "fails": 0, "last_fail": 0.0, "cooldown": 60.0},
    "groq": {"available": bool(GROQ_API_KEY), "fails": 0, "last_fail": 0.0, "cooldown": 30.0},
    "ollama": {"available": True, "fails": 0, "last_fail": 0.0, "cooldown": 10.0},
}

FOUNDER_PROFILE = """Mamishi Tonny Madire was born on January 14, 1998, and raised in Burgersfort within the Sekhukhune District Municipality. Growing up in a disadvantaged rural environment shaped his understanding of life, resilience, discipline, and perseverance. His home language is Sepedi, and from an early age he learned that true vision is not determined by where a person comes from, but by the mindset and guidance they receive along the journey.

"Greatness is not achieved alone - it is built through vision, struggle, learning, and the people who help you see beyond your limits."

His educational journey began at Matjiri Primary School, the village where his mother was born. In 2010, while in Grade 6, he relocated to Magobading, where he continued at Hlakanang Primary School and completed Grade 7. He later progressed to Magobanye High School, where he completed his Matric in 2016.

Throughout these early years, he travelled long distances to school, sometimes without shoes, yet carried a vision far greater than his circumstances. These experiences built resilience, discipline, and an unshakable belief that his future could be different from his present.

A key part of his journey was mentorship and guidance. At university, one of his academic mentors was Lulama Boyce, who played a significant role in shaping his academic discipline, confidence, and direction in accounting and internal auditing. Later, in the corporate environment, he was mentored by Frans Geldenhuys, who guided him through systems thinking, digital auditing, innovation, and the application of technology in business environments.

These mentors did not only teach technical knowledge - they helped shape mindset, professionalism, and purpose.

Inspired by thinkers and innovators such as Bill Gates, Isaac Newton, and Elon Musk, he developed a deep passion for knowledge, technology, and the power of ideas to transform lives.

He became the first person in his village to own a computer and gain exposure to the internet. Long before technology became widely accessible in rural communities, he was already exploring systems, learning through older operating environments, command-line interfaces, and self-driven experimentation. This foundation shaped his curiosity, independence, and problem-solving mindset.

Although an earlier opportunity to pursue a Bachelor of Education degree majoring in Accounting and Economics at the University of Limpopo could not materialise at the time, he remained committed to education and personal development. In 2019, he enrolled at the University of Johannesburg, where he completed a Diploma in Accountancy in 2021, an Advanced Diploma in Accountancy in 2022, and a BCom Honours in Internal Auditing in 2023.

He also served as a tutor in Accounting, Internal Auditing, and Cost and Management Accounting, while supporting students as a Registration Assistant and Finance Officer during registration periods - developing both leadership and service-oriented skills.

In 2024, he worked at Bidvest within the ALICE system environment, gaining exposure to system development, process automation, data analytics, and audit innovation, while independently developing analytical tools to improve efficiency and decision-making.

In 2025, he joined SNG Grant Thornton as an ACCA Trainee in General Assurance, strengthening his experience in external auditing, IT auditing, data analytics, risk assessment, and control evaluation.

His interests span technology, philosophy, auditing, automation, system development, and continuous learning. He is passionate about using tools such as Python, SQL, Excel automation, dashboards, and audit analytics to solve real problems and improve systems.

More than a professional journey, his story reflects the power of mentorship, resilience, and vision. It shows that success is not only built through personal effort, but also through the guidance of those who see potential and help shape it.

He continues to aspire to inspire others - especially youth from disadvantaged communities - to believe in their potential, embrace learning, and remain committed to growth."""

SYSTEM_PROMPT = f"""You are {APP_NAME}, a personal AI created for {AUTHOR_NAME}.
You are smart, innovative, practical, and deeply focused on problem solving.
You run on the user's local machine and can use tools to interact with the filesystem and terminal.

Identity rules:
- Never present yourself as Claude. Your name is {APP_NAME}.
- If asked who built or authored you, say: "{APP_NAME} was created by {AUTHOR_NAME}."
- If asked who Mamishi Tonny Madire is, or if the user spells the name as MAMISHI TONNY MADIR or MAMAISHI TONNY MADIRE, treat it as the same person and answer with the approved founder biography below.

Approved founder biography:
{FOUNDER_PROFILE}

Core expertise:
1. AUDIT AND ACCOUNTING: ACCA standards, South African auditing, IFRS, internal controls, management letters, HEMIS validation, working papers, and data-driven audit support.
2. CODING AND DEVELOPMENT: Python, C#, ASP.NET, SQL Server, Flask, automation, data analytics, dashboards, integrations, and software problem solving.
3. GENERAL ASSISTANT: Research, analysis, planning, writing, summarisation, and decision support.

Behaviour:
- Use tools proactively when the user asks you to do something on their PC.
- Use the web search tool for current or fast-changing information such as news, prices, recent laws, library updates, or fresh company information.
- File operations run inside: {AGENT_WORKDIR}
- After using a tool, explain what you did and what the result means.
- Be concise, practical, and confident.
- Use markdown when it improves readability."""

web_search_func = genai.protos.FunctionDeclaration(
    name="web_search",
    description="Search the web for current, up-to-date information. Use this for recent news, latest updates, current prices, recent IFRS changes, new libraries, or anything that might have changed recently.",
    parameters=genai.protos.Schema(
        type=genai.protos.Type.OBJECT,
        properties={
            "query": genai.protos.Schema(
                type=genai.protos.Type.STRING,
                description="The search query to look up on the web.",
            ),
        },
        required=["query"],
    ),
)

execute_command_func = genai.protos.FunctionDeclaration(
    name="execute_command",
    description="Run a shell command on the user's local machine. Returns stdout and stderr.",
    parameters=genai.protos.Schema(
        type=genai.protos.Type.OBJECT,
        properties={
            "command": genai.protos.Schema(
                type=genai.protos.Type.STRING,
                description="Shell command to execute.",
            ),
            "workdir": genai.protos.Schema(
                type=genai.protos.Type.STRING,
                description="Optional working directory.",
            ),
        },
        required=["command"],
    ),
)

read_file_func = genai.protos.FunctionDeclaration(
    name="read_file",
    description="Read the contents of a file on the local filesystem.",
    parameters=genai.protos.Schema(
        type=genai.protos.Type.OBJECT,
        properties={
            "path": genai.protos.Schema(
                type=genai.protos.Type.STRING,
                description="Path to the file.",
            ),
        },
        required=["path"],
    ),
)

write_file_func = genai.protos.FunctionDeclaration(
    name="write_file",
    description="Write content to a file. Creates or overwrites the file.",
    parameters=genai.protos.Schema(
        type=genai.protos.Type.OBJECT,
        properties={
            "path": genai.protos.Schema(
                type=genai.protos.Type.STRING,
                description="File path.",
            ),
            "content": genai.protos.Schema(
                type=genai.protos.Type.STRING,
                description="Content to write.",
            ),
        },
        required=["path", "content"],
    ),
)

list_dir_func = genai.protos.FunctionDeclaration(
    name="list_dir",
    description="List files and folders in a directory.",
    parameters=genai.protos.Schema(
        type=genai.protos.Type.OBJECT,
        properties={
            "path": genai.protos.Schema(
                type=genai.protos.Type.STRING,
                description="Directory to list. Optional.",
            ),
        },
        required=[],
    ),
)

TOOLS = genai.protos.Tool(
    function_declarations=[
        web_search_func,
        execute_command_func,
        read_file_func,
        write_file_func,
        list_dir_func,
    ]
)

OPENAI_TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for current, up-to-date information.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "execute_command",
            "description": "Run a shell command on the user's local machine. Returns stdout and stderr.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "workdir": {"type": "string"},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a file on the local filesystem.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file. Creates or overwrites the file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_dir",
            "description": "List files and folders in a directory.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
            },
        },
    },
]


def backend_ready(name):
    state = BACKEND_STATE[name]
    if not state["available"]:
        return False
    if state["fails"] == 0:
        return True
    return (time.time() - state["last_fail"]) > state["cooldown"]


def mark_backend_failed(name):
    state = BACKEND_STATE[name]
    state["fails"] += 1
    state["last_fail"] = time.time()
    state["cooldown"] = min(state["cooldown"] * 2, 15 * 60.0)


def mark_backend_success(name):
    state = BACKEND_STATE[name]
    state["fails"] = 0
    state["last_fail"] = 0.0
    if name == "gemini":
        state["cooldown"] = 60.0
    elif name == "groq":
        state["cooldown"] = 30.0
    else:
        state["cooldown"] = 10.0


def is_quota_error(error):
    text = str(error or "").lower()
    return (
        "429" in text
        or "quota" in text
        or "resource_exhausted" in text
        or "resource exhausted" in text
        or "rate limit" in text
    )


def http_post_json(url, payload, headers=None, timeout=60):
    request_headers = {"Content-Type": "application/json"}
    if headers:
        request_headers.update(headers)

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=request_headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            return response.getcode(), body
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(str(exc.reason)) from exc

def tool_web_search(query):
    if not tavily_client:
        return {"error": "TAVILY_API_KEY is not configured."}

    try:
        results = tavily_client.search(
            query=query,
            search_depth="basic",
            max_results=5,
        )
        formatted = []
        for item in results.get("results", []):
            formatted.append(
                {
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "content": item.get("content", "")[:500],
                }
            )
        log_activity("search", query)
        return {"query": query, "results": formatted, "count": len(formatted)}
    except Exception as exc:
        return {"error": str(exc)}


def tool_execute_command(command, workdir=None):
    cwd = workdir or AGENT_WORKDIR
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return {
            "returncode": result.returncode,
            "stdout": result.stdout[:4000],
            "stderr": result.stderr[:2000],
            "cwd": cwd,
        }
    except subprocess.TimeoutExpired:
        return {"error": "Command timed out after 30 seconds"}
    except Exception as exc:
        return {"error": str(exc)}


def tool_read_file(path):
    if not os.path.isabs(path):
        path = os.path.join(AGENT_WORKDIR, path)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as file:
            content = file.read(20000)
        return {"path": path, "content": content, "size": len(content)}
    except Exception as exc:
        return {"error": str(exc)}


def tool_write_file(path, content):
    if not os.path.isabs(path):
        path = os.path.join(AGENT_WORKDIR, path)
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as file:
            file.write(content)
        return {"path": path, "bytes_written": len(content.encode())}
    except Exception as exc:
        return {"error": str(exc)}


def tool_list_dir(path=None):
    target = path or AGENT_WORKDIR
    if not os.path.isabs(target):
        target = os.path.join(AGENT_WORKDIR, target)
    try:
        entries = []
        for name in sorted(os.listdir(target)):
            full_path = os.path.join(target, name)
            entries.append(
                {
                    "name": name,
                    "type": "dir" if os.path.isdir(full_path) else "file",
                    "size": os.path.getsize(full_path) if os.path.isfile(full_path) else None,
                }
            )
        return {"path": target, "entries": entries, "count": len(entries)}
    except Exception as exc:
        return {"error": str(exc)}


def to_gemini_parts(content):
    if isinstance(content, str):
        return [content]

    if not isinstance(content, list):
        return [str(content)]

    parts = []
    for item in content:
        if not isinstance(item, dict):
            continue

        item_type = item.get("type")
        if item_type == "text":
            text = item.get("text", "")
            if text:
                parts.append(text)
            continue

        if item_type in {"image", "file"}:
            base64_data = item.get("base64")
            if not base64_data:
                continue

            mime_type = (
                item.get("mimeType")
                or item.get("mime_type")
                or mimetypes.guess_type(item.get("name", ""))[0]
                or "application/octet-stream"
            )

            parts.append(
                {
                    "inline_data": {
                        "mime_type": mime_type,
                        "data": base64_data,
                    }
                }
            )

    return parts or [""]


def flatten_content_text(content):
    if isinstance(content, str):
        return content

    if not isinstance(content, list):
        return str(content or "")

    values = []
    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "text":
            text = item.get("text", "").strip()
            if text:
                values.append(text)
        elif item.get("name"):
            values.append(f"[Uploaded file: {item.get('name')}]")
    return "\n".join(values).strip()


def build_text_backend_messages(raw_messages):
    messages = []
    for message in raw_messages:
        role = message.get("role")
        if role == "assistant":
            item = {"role": "assistant", "content": flatten_content_text(message.get("content", ""))}
            if message.get("tool_calls"):
                item["tool_calls"] = message["tool_calls"]
            messages.append(item)
        elif role == "tool":
            messages.append(
                {
                    "role": "tool",
                    "content": flatten_content_text(message.get("content", "")),
                    "tool_call_id": message.get("tool_call_id", "tool_call"),
                }
            )
        else:
            content = flatten_content_text(message.get("content", ""))
            if content:
                messages.append({"role": "user", "content": content})
    return messages


def get_last_user_text(raw_messages):
    for message in reversed(raw_messages):
        if message.get("role") == "user":
            return flatten_content_text(message.get("content", ""))
    return ""


def detect_uploaded_file_types(raw_messages):
    file_types = []
    for message in raw_messages:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") not in {"image", "file"}:
                continue
            file_types.append(item.get("mimeType") or item.get("mime_type") or "")
    return file_types


def should_use_gemini_for_request(raw_messages):
    if not API_KEY:
        return False, "Gemini unavailable"

    file_types = detect_uploaded_file_types(raw_messages)
    if any(file_type == "application/pdf" for file_type in file_types):
        return True, "Gemini (reads PDF natively)"
    if any(file_type.startswith("image/") for file_type in file_types):
        return True, "Gemini (reads image natively)"

    return False, "Groq"


def normalize_activity_title(text):
    cleaned = " ".join((text or "").replace("\r", "\n").split())
    for prefix in ("[AUDIT MODE]", "[BUILD MODE]", "[AGENT MODE]"):
        if cleaned.startswith(prefix):
            cleaned = cleaned[len(prefix):].strip()
    return cleaned[:100] or "Untitled activity"


def load_activity_log():
    try:
        with open(ACTIVITY_LOG_PATH, "r", encoding="utf-8") as file:
            data = json.load(file)
            if isinstance(data, list):
                return data
    except FileNotFoundError:
        return []
    except Exception:
        return []
    return []


def save_activity_log(items):
    with open(ACTIVITY_LOG_PATH, "w", encoding="utf-8") as file:
        json.dump(items[:MAX_ACTIVITY_ITEMS], file, ensure_ascii=True, indent=2)


def log_activity(activity_type, text):
    title = normalize_activity_title(text)
    if not title:
        return

    items = load_activity_log()
    entry = {
        "id": datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f"),
        "type": activity_type,
        "title": title,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    if items and items[0].get("type") == entry["type"] and items[0].get("title") == entry["title"]:
        items[0]["timestamp"] = entry["timestamp"]
    else:
        items.insert(0, entry)

    save_activity_log(items)


def run_tool(name, args):
    if name == "web_search":
        return tool_web_search(args.get("query"))
    if name == "execute_command":
        return tool_execute_command(args.get("command"), args.get("workdir"))
    if name == "read_file":
        return tool_read_file(args.get("path"))
    if name == "write_file":
        return tool_write_file(args.get("path"), args.get("content"))
    if name == "list_dir":
        return tool_list_dir(args.get("path"))
    return {"error": f"Unknown tool: {name}"}


def iter_gemini_events(raw_messages):
    model = genai.GenerativeModel(
        model_name=MODEL_NAME,
        system_instruction=SYSTEM_PROMPT,
        tools=[TOOLS],
    )

    history = []
    for message in raw_messages[:-1]:
        role = "user" if message["role"] == "user" else "model"
        history.append({"role": role, "parts": to_gemini_parts(message["content"])})

    chat_session = model.start_chat(history=history)
    current_msg = to_gemini_parts(raw_messages[-1]["content"])

    while True:
        response = chat_session.send_message(current_msg)
        candidate = response.candidates[0]
        parts = candidate.content.parts

        func_calls = [
            part for part in parts
            if hasattr(part, "function_call") and part.function_call.name
        ]
        text_parts = [
            part for part in parts
            if hasattr(part, "text") and part.text
        ]

        for part in text_parts:
            yield {"text": part.text}

        if not func_calls:
            break

        function_responses = []
        for part in func_calls:
            function_call = part.function_call
            tool_name = function_call.name
            tool_args = dict(function_call.args)

            yield {"tool_start": {"name": tool_name, "input": tool_args}}
            result = run_tool(tool_name, tool_args)
            yield {"tool_end": {"name": tool_name, "result": result}}

            function_responses.append(
                genai.protos.Part(
                    function_response=genai.protos.FunctionResponse(
                        name=tool_name,
                        response={"result": json.dumps(result)},
                    )
                )
            )

        current_msg = genai.protos.Content(parts=function_responses, role="user")


def call_groq(raw_messages):
    messages = build_text_backend_messages(raw_messages)
    payload = {
        "model": GROQ_MODEL,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, *messages],
        "tools": OPENAI_TOOL_SCHEMAS,
        "tool_choice": "auto",
        "stream": False,
    }
    _, body = http_post_json(
        GROQ_URL,
        payload,
        headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
        timeout=90,
    )
    parsed = json.loads(body)
    choice = (parsed.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    tool_calls = []
    for item in message.get("tool_calls") or []:
        function_data = item.get("function") or {}
        try:
            arguments = json.loads(function_data.get("arguments") or "{}")
        except json.JSONDecodeError:
            arguments = {}
        tool_calls.append(
            {
                "id": item.get("id"),
                "type": "function",
                "function": {
                    "name": function_data.get("name"),
                    "arguments": arguments,
                },
            }
        )
    return {
        "content": message.get("content") or "",
        "tool_calls": tool_calls,
    }


def call_ollama(raw_messages):
    messages = build_text_backend_messages(raw_messages)
    payload = {
        "model": OLLAMA_MODEL,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, *messages],
        "tools": OPENAI_TOOL_SCHEMAS,
        "stream": False,
    }
    _, body = http_post_json(OLLAMA_URL, payload, timeout=90)
    parsed = json.loads(body)
    message = parsed.get("message") or {}
    tool_calls = []
    for item in message.get("tool_calls") or []:
        function_data = item.get("function") or {}
        tool_calls.append(
            {
                "id": item.get("id"),
                "type": "function",
                "function": {
                    "name": function_data.get("name"),
                    "arguments": function_data.get("arguments") or {},
                },
            }
        )
    return {
        "content": message.get("content") or "",
        "tool_calls": tool_calls,
    }


@app.route("/")
def index():
    return render_template(
        "index.html",
        app_name=APP_NAME,
        author_name=AUTHOR_NAME,
    )


@app.route("/workdir", methods=["GET"])
def get_workdir():
    return jsonify(
        {
            "workdir": AGENT_WORKDIR,
            "backends": {
                "gemini": {
                    "available": bool(API_KEY),
                    "ready": backend_ready("gemini"),
                    "model": MODEL_NAME,
                    "key": bool(API_KEY),
                },
                "groq": {
                    "available": bool(GROQ_API_KEY),
                    "ready": backend_ready("groq"),
                    "model": GROQ_MODEL,
                    "key": bool(GROQ_API_KEY),
                },
                "ollama": {
                    "available": True,
                    "ready": backend_ready("ollama"),
                    "model": OLLAMA_MODEL,
                },
                "tavily": {
                    "available": bool(TAVILY_API_KEY),
                    "ready": bool(TAVILY_API_KEY),
                },
            },
        }
    )


@app.route("/activity", methods=["GET"])
def get_activity():
    return jsonify({"items": load_activity_log()})


@app.route("/chat", methods=["POST"])
def chat():
    data = request.json or {}
    raw_messages = data.get("messages", [])
    if not raw_messages:
        return jsonify({"error": "No messages provided"}), 400

    latest_message = raw_messages[-1]
    latest_text = flatten_content_text(latest_message.get("content", ""))
    if latest_message.get("role") == "user" and latest_text:
        log_activity("chat", latest_text)

    def generate():
        working_messages = list(raw_messages)
        prefer_gemini, backend_reason = should_use_gemini_for_request(working_messages)
        backend_chain = ["gemini", "groq", "ollama"] if prefer_gemini else ["groq", "ollama"]

        try:
            while True:
                if "gemini" in backend_chain and backend_ready("gemini"):
                    yield f"data: {json.dumps({'backend_info': backend_reason})}\n\n"
                    try:
                        for event in iter_gemini_events(working_messages):
                            yield f"data: {json.dumps(event)}\n\n"
                        mark_backend_success("gemini")
                        yield f"data: {json.dumps({'done': True, 'backend': 'gemini'})}\n\n"
                        break
                    except Exception as exc:
                        mark_backend_failed("gemini")
                        notice = (
                            "Gemini quota reached - switching to Groq automatically"
                            if is_quota_error(exc)
                            else "Gemini unavailable - switching to Groq"
                        )
                        yield f"data: {json.dumps({'notice': notice})}\n\n"

                if "groq" in backend_chain and backend_ready("groq"):
                    groq_info = "Groq" if not prefer_gemini else "Groq (Gemini fallback)"
                    yield f"data: {json.dumps({'backend_info': groq_info})}\n\n"
                    try:
                        while True:
                            result = call_groq(working_messages)
                            if result["content"]:
                                yield f"data: {json.dumps({'text': result['content']})}\n\n"
                            tool_calls = result.get("tool_calls") or []
                            if not tool_calls:
                                mark_backend_success("groq")
                                yield f"data: {json.dumps({'done': True, 'backend': 'groq'})}\n\n"
                                return

                            assistant_tool_message = {
                                "role": "assistant",
                                "content": result["content"],
                                "tool_calls": [],
                            }
                            for tool_call in tool_calls:
                                tool_name = tool_call.get("function", {}).get("name")
                                tool_args = tool_call.get("function", {}).get("arguments") or {}
                                tool_call_id = tool_call.get("id") or f"groq_{tool_name}"
                                assistant_tool_message["tool_calls"].append(
                                    {
                                        "id": tool_call_id,
                                        "type": "function",
                                        "function": {
                                            "name": tool_name,
                                            "arguments": json.dumps(tool_args),
                                        },
                                    }
                                )
                            working_messages.append(assistant_tool_message)
                            for tool_call in tool_calls:
                                tool_name = tool_call.get("function", {}).get("name")
                                tool_args = tool_call.get("function", {}).get("arguments") or {}
                                tool_call_id = tool_call.get("id") or f"groq_{tool_name}"
                                yield f"data: {json.dumps({'tool_start': {'name': tool_name, 'input': tool_args}})}\n\n"
                                tool_result = run_tool(tool_name, tool_args)
                                yield f"data: {json.dumps({'tool_end': {'name': tool_name, 'result': tool_result}})}\n\n"
                                working_messages.append(
                                    {
                                        "role": "tool",
                                        "tool_call_id": tool_call_id,
                                        "content": json.dumps(tool_result),
                                    }
                                )
                    except Exception as exc:
                        mark_backend_failed("groq")
                        notice = (
                            "Groq limit reached - switching to local Ollama"
                            if is_quota_error(exc)
                            else "Groq unavailable - switching to Ollama"
                        )
                        yield f"data: {json.dumps({'notice': notice})}\n\n"

                if backend_ready("ollama"):
                    yield f"data: {json.dumps({'backend_info': 'Ollama (backup)'})}\n\n"
                    try:
                        while True:
                            result = call_ollama(working_messages)
                            if result["content"]:
                                yield f"data: {json.dumps({'text': result['content']})}\n\n"
                            tool_calls = result.get("tool_calls") or []
                            if not tool_calls:
                                mark_backend_success("ollama")
                                yield f"data: {json.dumps({'done': True, 'backend': 'ollama'})}\n\n"
                                return

                            assistant_tool_message = {
                                "role": "assistant",
                                "content": result["content"],
                                "tool_calls": [],
                            }
                            for tool_call in tool_calls:
                                tool_name = tool_call.get("function", {}).get("name")
                                tool_args = tool_call.get("function", {}).get("arguments") or {}
                                tool_call_id = tool_call.get("id") or f"ollama_{tool_name}"
                                assistant_tool_message["tool_calls"].append(
                                    {
                                        "id": tool_call_id,
                                        "type": "function",
                                        "function": {
                                            "name": tool_name,
                                            "arguments": json.dumps(tool_args),
                                        },
                                    }
                                )
                            working_messages.append(assistant_tool_message)
                            for tool_call in tool_calls:
                                tool_name = tool_call.get("function", {}).get("name")
                                tool_args = tool_call.get("function", {}).get("arguments") or {}
                                tool_call_id = tool_call.get("id") or f"ollama_{tool_name}"
                                yield f"data: {json.dumps({'tool_start': {'name': tool_name, 'input': tool_args}})}\n\n"
                                tool_result = run_tool(tool_name, tool_args)
                                yield f"data: {json.dumps({'tool_end': {'name': tool_name, 'result': tool_result}})}\n\n"
                                working_messages.append(
                                    {
                                        "role": "tool",
                                        "tool_call_id": tool_call_id,
                                        "content": json.dumps(tool_result),
                                    }
                                )
                    except Exception as exc:
                        mark_backend_failed("ollama")
                        yield f"data: {json.dumps({'error': f'All backends failed: {exc}'})}\n\n"
                        return

                yield f"data: {json.dumps({'error': 'No available backend: configure Gemini, Groq, or Ollama.'})}\n\n"
                return

        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/clear", methods=["POST"])
def clear():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("\nGEMINI_API_KEY not set.")
        print("Run in PowerShell: $env:GEMINI_API_KEY='your-key-here'\n")
    else:
        print("Gemini API key loaded.")
        if TAVILY_API_KEY:
            print("Tavily API key loaded.")
        else:
            print("Tavily API key not set. Web search tool will be unavailable.")

    print(f"{APP_NAME} at http://localhost:5000")
    print(f"Model: {MODEL_NAME}")
    print(f"Workspace: {AGENT_WORKDIR}")
    app.run(
        debug=os.environ.get("APP_DEBUG") == "1",
        port=5000,
        threaded=True,
    )
