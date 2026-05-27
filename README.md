# Agent Arena Eval

Web + API runner for structured agent tests.

## Run Locally

```bash
node server.mjs
```

Open `http://localhost:4173/run/new`.

## Public URL

Set `PUBLIC_BASE_URL` when deploying so the page can generate commands for cloud agents:

```bash
PUBLIC_BASE_URL="https://your-domain.com" node server.mjs
```

Local agents can use `localhost`. Cloud agents must use the public URL.

## Deploy

This app needs a Node server and SQLite storage. Static hosting is not enough.

Recommended production shape:

- Runtime: Node 24
- Command: `node server.mjs`
- Port: `PORT`, default `4173`
- Persistent storage: set `STORAGE_DIR` to a mounted disk directory
- Public URL: set `PUBLIC_BASE_URL` to the deployed origin

Docker deployment is supported via `Dockerfile`.

For Render, connect this repo and use `render.yaml`. After the first deploy,
set `PUBLIC_BASE_URL` to the service URL, for example:

```bash
https://your-service.onrender.com
```

## Agent Command

The page generates a short command that runs the default terminal answering script:

```bash
python3 <(curl -fsSL "http://localhost:4173/r") "my-agent"
```

The runner creates a run, prints each task as JSON, reads the answer from stdin, submits it, and continues until completion.

## Import Tasks

Preferred source is CSV/XLSX exported from the original table. Required columns:

- `ID`
- `题型`
- `题目`
- `GT`

Optional columns:

- `分类`
- `category`
- `赛道`

```bash
python3 scripts/import_tasks.py /path/to/tasks.xlsx --output data/tasks.json
```

If only a PDF is available, prepare review assets first:

```bash
python3 scripts/import_tasks.py /path/to/结构化题库v1.pdf --pdf-review-dir data/import_review
```

PDF review output is intentionally not copied into `data/tasks.json`; review/OCR the extracted table images before replacing the official task file.
PDF review requires `pypdf`; XLSX import requires `openpyxl`. CSV import and the agent runner use only the Python standard library.
