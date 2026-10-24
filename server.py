"""TEAM POST STUDIO local server.

The bundled PhotoCraft / VectorCraft editors are WebAssembly apps: they must be served over
http://localhost (not opened as file://) and from the same origin as index.html so the page can
hand images to them and read their exports back.

    python server.py            -> http://localhost:8765/
"""
import http.server
import mimetypes
import socketserver
import sys
import webbrowser
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = Path(__file__).resolve().parent

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("font/ttf", ".ttf")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        if self.path.endswith((".html", "/", "parts.txt", "photocraft-web.js")):
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    url = f"http://localhost:{PORT}/"
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        print(f"TEAM POST STUDIO: {url}  (Ctrl+C で終了)")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
