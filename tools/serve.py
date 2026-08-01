#!/usr/bin/env python3
"""serve.py — one-line static server for the M5 UI (docs/backlog/M5-ui.md).

Opening index.html directly via file:// breaks ES module imports (CORS).
This is the "建議啟動方式" AGENTS.md/M5 promises: zero dependencies, stdlib
only, serves the repo root so index.html's relative paths (data/, src/,
vendor/, styles/) all resolve normally.

Usage:
    python tools/serve.py [port]   # default port 8000
"""
import http.server
import socketserver
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = http.server.SimpleHTTPRequestHandler
    with socketserver.TCPServer(("", port), lambda *a, **kw: handler(*a, directory=str(REPO_ROOT), **kw)) as httpd:
        print(f"Serving {REPO_ROOT} at http://localhost:{port}/  (Ctrl+C to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
