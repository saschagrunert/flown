#!/usr/bin/env python3
"""Simple HTTP server for serving the generated site."""

import http.server
import os
import sys

PORT = int(os.environ.get("PORT", "8000"))
BIND_HOST = os.environ.get("BIND_HOST", "127.0.0.1")
# Where a browser reaches the server: in a container that is the host's
# address and port, which `make serve` passes, not the ones bound inside
OPEN_URL = os.environ.get("OPEN_URL") or f"http://localhost:{PORT}/"


class Handler(http.server.SimpleHTTPRequestHandler):
    # The signature of the method it overrides, whose path it does not need
    def list_directory(self, path: str | os.PathLike[str]) -> None:  # noqa: ARG002
        # The site is addressed by its files; a listing of the data directory
        # is nothing a page needs
        self.send_error(404, "Directory listing not supported")

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        # A data file must not be read as a script or a page by type sniffing
        self.send_header("X-Content-Type-Options", "nosniff")
        # As the page's meta tag has it. A worker takes its policy from the
        # header of its script, not from the page: with same-origin here the
        # MapLibre worker would fetch the CARTO tiles without a Referer, which
        # a key restricted to the site's domain refuses.
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        return super().end_headers()


class Server(http.server.ThreadingHTTPServer):
    """Serve requests concurrently and allow an immediate restart on the port."""

    allow_reuse_address = True
    daemon_threads = True


# The directory the image mounts the site at; DATA_DIR points elsewhere, as
# tests/test_serve.py does
DATA_DIR = os.environ.get("DATA_DIR", "/data")


def main() -> int:
    if not os.path.isdir(DATA_DIR):
        print(f"Error: {DATA_DIR} does not exist. Are you running inside Docker?")
        return 1
    os.chdir(DATA_DIR)
    with Server((BIND_HOST, PORT), Handler) as httpd:
        # The port bound, which PORT=0 leaves to the system (the tests)
        print(f"Starting HTTP server on {BIND_HOST}:{httpd.server_port}...")
        print(f"Serving files from: {os.getcwd()}")
        print(f"Open {OPEN_URL} in your browser", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
