#!/usr/bin/env python3
"""Dev server for local jscreensaver work.

Like `python3 -m http.server 8000`, except every response carries
`Cache-Control: no-store`, so the browser never caches a hack module. A plain
reload (Cmd+R) always fetches the latest edit -- no hard-reload smashing, no
stale `import()`ed modules. Run from the repo root:

    python3 tools/serve.py            # serves . on http://localhost:8000
    python3 tools/serve.py 8001       # ...on a different port

(Stop any existing `http.server` on the port first, or pass another port.)
"""
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
    print(f"serving . on http://localhost:{PORT}  (no-store; a plain reload picks up edits)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
