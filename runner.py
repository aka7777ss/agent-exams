#!/usr/bin/env python3
"""Terminal runner for Agent Arena.

The script uses only Python standard-library modules so it can be copied to
local or cloud agents without project dependencies.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.request


DEFAULT_BASE_URL = ""


def request_json_with_curl(base_url: str, path: str, method: str = "GET", payload: object | None = None) -> dict:
    url = base_url.rstrip("/") + path
    data = None
    command = [
        "curl",
        "-sS",
        "--max-time",
        "60",
        "-X",
        method,
        "-H",
        "accept: application/json",
        "-w",
        "\n%{http_code}",
        url,
    ]

    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        command[4:4] = ["-H", "content-type: application/json", "--data-binary", "@-"]

    completed = subprocess.run(command, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    stdout = completed.stdout.decode("utf-8", errors="replace")
    stderr = completed.stderr.decode("utf-8", errors="replace").strip()

    if completed.returncode != 0:
        raise RuntimeError(f"curl could not reach {url}: {stderr or f'exit {completed.returncode}'}")

    body, separator, status_text = stdout.rpartition("\n")
    if not separator or not status_text.isdigit():
        raise RuntimeError(f"Unexpected curl response from {path}: {stdout[:500]}")

    status = int(status_text)
    if status >= 400:
        raise RuntimeError(f"HTTP {status} from {path}: {body}")

    return json.loads(body or "{}")


def request_json(base_url: str, path: str, method: str = "GET", payload: object | None = None) -> dict:
    if shutil.which("curl"):
        return request_json_with_curl(base_url, path, method, payload)

    data = None
    headers = {"accept": "application/json"}

    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["content-type"] = "application/json"

    request = urllib.request.Request(base_url.rstrip("/") + path, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code} from {path}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Could not reach {base_url}: {error.reason}") from error


def print_task(task_payload: dict) -> None:
    task = task_payload["task"]
    print("\n" + "=" * 72)
    print(f"Run: {task_payload['id']}")
    print(f"Progress: {task_payload['submitted']} / {task_payload['total_tasks']}")
    print(f"Task: {task_payload['index']} / {task_payload['total']}  {task['id']}  {task['type']}")
    print("-" * 72)
    print(json.dumps(task, ensure_ascii=False, indent=2))
    print("-" * 72)

    if task["type"] == "single_choice":
        print("Answer format: B")
    elif task["type"] == "multiple_choice":
        print('Answer format: A,C  or  ["A","C"]')
    elif task["type"] == "json":
        print('Answer format: valid JSON, for example {"key":"value"}')
    elif task["type"] == "number":
        print("Answer format: number, for example 42")
    elif task["type"] == "percentage":
        print("Answer format: percentage, for example 30%, 30, or 0.3")
    else:
        print("Answer format: plain text")


def parse_answer(raw: str, task_type: str) -> object:
    value = raw.strip()

    if task_type == "multiple_choice":
        if value.startswith("["):
            parsed = json.loads(value)
            if not isinstance(parsed, list):
                raise ValueError("Multiple-choice JSON input must be an array.")
            return [str(item).strip() for item in parsed if str(item).strip()]
        return [item.strip() for item in value.split(",") if item.strip()]

    if task_type == "json":
        return json.loads(value)

    if task_type == "number":
        return value

    return value


def prompt_answer(task_type: str) -> object:
    while True:
        raw = input("Your answer> ")
        try:
            return parse_answer(raw, task_type)
        except (json.JSONDecodeError, ValueError) as error:
            print(f"Invalid answer: {error}", file=sys.stderr)


def print_intro(base_url: str, agent_name: str, run: dict) -> None:
    print("\nAgent Arena default terminal runner")
    print("=" * 72)
    print(f"Agent: {agent_name}")
    print(f"Base URL: {base_url}")
    print(f"Created run: {run['id']}")
    print(f"Web URL: {base_url}{run['next_url']}")
    print("-" * 72)
    print("How it works:")
    print("1. The script fetches one task at a time.")
    print("2. Read the task JSON printed below.")
    print("3. Type exactly one answer after 'Your answer>'.")
    print("4. The script submits it and moves to the next task.")
    print("Press Ctrl+C to stop before completion.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run an Agent Arena evaluation from the terminal.")
    parser.add_argument("agent_name_pos", nargs="?", help="Agent name, for short pipe commands.")
    parser.add_argument("--base", default=DEFAULT_BASE_URL, help="Base URL, for example http://localhost:4173")
    parser.add_argument("--agent-name", default="", help="Name stored with the run.")
    args = parser.parse_args()

    base_url = args.base.rstrip("/")
    if not base_url:
        parser.error("--base is required when runner.py is not served from /r.")
    agent_name = args.agent_name or args.agent_name_pos or "terminal-agent"
    run = request_json(base_url, "/api/runs", "POST", {"agent_name": agent_name})
    run_id = run["id"]

    print_intro(base_url, agent_name, run)

    while True:
        next_payload = request_json(base_url, f"/api/runs/{run_id}/next")
        task = next_payload.get("task")

        if not task:
            break

        print_task(next_payload)
        answer = prompt_answer(task["type"])
        submit = request_json(
            base_url,
            f"/api/runs/{run_id}/answers",
            "POST",
            {"task_id": task["id"], "answer": answer},
        )
        print(f"Submitted {task['id']}: correct={submit['correct']} score={submit['score']}")

    result = request_json(base_url, f"/api/runs/{run_id}/result")
    print("\n" + "=" * 72)
    print("Complete")
    print(f"Score: {result['score']} / {result['total_tasks']}")
    print(f"Accuracy: {result['accuracy']:.2%}")
    print(f"Result JSON: {base_url}/api/runs/{run_id}/result")
    print(f"Result page: {base_url}/run/{run_id}/result")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
