"""
MAMISHI AI — Python SDK
Use this in any Python project to call your AI.

Usage:
    from mamishi_sdk import MamishiAI
    ai = MamishiAI(api_key="your-key")
    answer = ai.ask("What is IFRS 16?")
    print(answer)
"""

import requests


class MamishiAI:
    def __init__(self, api_key="mamishi-dev-key", base_url="http://localhost:5001", timeout=30):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.history = []
        self.headers = {
            "Content-Type": "application/json",
            "x-api-key": api_key,
        }

    def _post(self, path, body):
        try:
            res = requests.post(
                f"{self.base_url}{path}",
                json=body,
                headers=self.headers,
                timeout=self.timeout,
            )
            data = res.json()
        except requests.RequestException as exc:
            raise RuntimeError(f"Could not connect to Mamishi API: {exc}") from exc
        except ValueError as exc:
            raise RuntimeError("Mamishi API returned invalid JSON.") from exc

        if not res.ok:
            raise RuntimeError(data.get("error", f"HTTP {res.status_code}"))

        return data

    def health(self):
        """Check if the API is running."""
        res = requests.get(f"{self.base_url}/api/health", timeout=self.timeout)
        return res.json()

    def ask(self, question: str, context: str = "") -> str:
        """Simple one-shot question -> answer."""
        data = self._post("/api/ask", {"question": question, "context": context})
        return data.get("answer", "")

    def chat(self, message: str) -> str:
        """Multi-turn chat - remembers conversation history."""
        self.history.append({"role": "user", "content": message})
        data = self._post("/api/chat", {"messages": self.history})
        reply = data.get("message", {}).get("content", "")
        self.history.append({"role": "assistant", "content": reply})
        return reply

    def chat_once(self, message: str, system: str = "") -> str:
        """Single message with no memory."""
        body = {"messages": [{"role": "user", "content": message}]}
        if system:
            body["system"] = system
        data = self._post("/api/chat", body)
        return data.get("message", {}).get("content", "")

    def audit_help(self, question: str) -> str:
        """Audit-specific question."""
        return self.ask(question, "Apply South African auditing standards and ACCA knowledge.")

    def code_help(self, question: str, language: str = "Python") -> str:
        """Coding question - returns working code."""
        return self.ask(
            question,
            f"This is a {language} coding question. Provide working code with comments.",
        )

    def clear_history(self):
        """Clear conversation memory."""
        self.history = []

    def summarize(self, text: str) -> str:
        """Summarize a block of text."""
        return self.ask(f"Summarize the following:\n\n{text}")

    def analyze_data(self, data_description: str) -> str:
        """Ask for data analysis insights."""
        return self.ask(
            data_description,
            "Provide data analysis insights, patterns, and recommendations.",
        )
