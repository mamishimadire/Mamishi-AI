# MAMISHI AI

`MAMISHI AI` is a personal local AI assistant for Mamishi Tonny Madire.

This project now runs on:

- `Node.js` for the web server
- `Ollama` for the model runtime
- a local tool loop for commands, file reading, file writing, and directory listing

## Run

Make sure Ollama is running and a model is available. The current default model is:

```text
gpt-oss:120b-cloud
```

Start the app:

```bash
node server.js
```

Then open:

```text
http://localhost:5000
```

## Features

- `MAMISHI AI` branding across the interface
- founder-aware identity for Mamishi Tonny Madire
- General, Audit, Build, and Agent modes
- streaming chat responses
- local tool calling through Ollama
- modern responsive UI

## Founder Identity

If someone asks who Mamishi Tonny Madire is, the assistant answers with the approved founder biography defined in the system prompt.

## Notes

- `app.py` remains in the project as the earlier Flask version.
- `server.js` is the active runtime for this machine because Node.js and Ollama are already available locally.
