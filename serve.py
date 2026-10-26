"""
spoutyModel server - serves the viewer and keeps every open page in step.

    python serve.py            (port 8010)
    python serve.py 8020       (another port)

Pages:
    http://localhost:8010/                      operator view (this PC, or the tablet via this PC's IP)
    http://localhost:8010/index.html?view=igloo  Igloo web layer (4096 x 2048, Dynamic Resolution off)

Models you upload from the page are saved in the models folder. Only Python's standard library is used.
"""
import json
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(ROOT, "models")
STATE_FILE = os.path.join(ROOT, "state.json")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8010
MODEL_EXT = {".glb", ".gltf", ".obj", ".fbx", ".stl"}
MAX_UPLOAD = 500 * 1024 * 1024

# Windows can map .js to text/plain from the registry, which stops module scripts loading.
for ext, typ in {".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
                 ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".json": "application/json"}.items():
    mimetypes.add_type(typ, ext)

lock = threading.Lock()
state, rev, dirty = None, 0, False
try:
    with open(STATE_FILE, encoding="utf-8") as fh:
        state = json.load(fh)
        rev = 1
except (OSError, ValueError):
    pass


def saver():
    global dirty
    while True:
        time.sleep(2)
        with lock:
            if not dirty:
                continue
            snap, dirty = json.dumps(state), False
        try:
            with open(STATE_FILE, "w", encoding="utf-8") as fh:
                fh.write(snap)
        except OSError:
            pass


def find_main(folder):
    """The model file inside an unpacked folder (Sketchfab zips hold scene.gltf + scene.bin + textures/)."""
    best = None
    for dirpath, _, files in os.walk(folder):
        for f in sorted(files):
            ext = os.path.splitext(f)[1].lower()
            if ext in MODEL_EXT:
                rank = [".glb", ".gltf", ".fbx", ".obj", ".stl"].index(ext)
                depth = os.path.relpath(dirpath, folder).count(os.sep)
                key = (depth, rank)
                if best is None or key < best[0]:
                    best = (key, os.path.join(dirpath, f))
    return best[1] if best else None


def unpack_zip(path):
    """Unpack an uploaded zip into models/<zip name>/, refusing paths that try to escape it."""
    base = os.path.splitext(os.path.basename(path))[0]
    folder = os.path.join(MODELS, base)
    n = 2
    while os.path.exists(folder):
        folder = os.path.join(MODELS, f"{base}_{n}")
        n += 1
    os.makedirs(folder)
    root = os.path.realpath(folder)
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            target = os.path.realpath(os.path.join(folder, info.filename))
            if not target.startswith(root + os.sep):
                continue
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as src, open(target, "wb") as dst:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    dst.write(chunk)
    return folder


def list_models():
    os.makedirs(MODELS, exist_ok=True)
    out = []
    for f in sorted(os.listdir(MODELS)):
        full = os.path.join(MODELS, f)
        if os.path.isfile(full) and os.path.splitext(f)[1].lower() in MODEL_EXT:
            out.append({"src": f"models/{urllib.parse.quote(f)}", "name": nice_name(f)})
        elif os.path.isdir(full):
            main = find_main(full)
            if main:
                rel = os.path.relpath(main, ROOT).replace(os.sep, "/")
                out.append({"src": urllib.parse.quote(rel), "name": nice_name(f)})
    return out


def nice_name(fn):
    base = os.path.splitext(fn)[0].replace("_", " ").replace("-", " ").strip()
    return base[:1].upper() + base[1:]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/" not in (self.path or ""):
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/state":
            since = int(urllib.parse.parse_qs(u.query).get("since", ["-1"])[0] or -1)
            with lock:
                if state is None or rev <= since:
                    self.send_response(204)
                    self.end_headers()
                    return
                out = {"rev": rev, "state": state}
            return self.send_json(out)
        if u.path == "/api/models":
            return self.send_json(list_models())
        return super().do_GET()

    def do_POST(self):
        global state, rev, dirty
        u = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        if u.path == "/api/state":
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self.send_json({"error": "bad json"}, 400)
            with lock:
                rev += 1
                state, dirty = body, True
                state["rev"] = rev
                out = {"rev": rev}
            return self.send_json(out)
        if u.path == "/api/upload":
            name = urllib.parse.parse_qs(u.query).get("name", ["model.glb"])[0]
            name = re.sub(r"[^\w.\- ]", "_", os.path.basename(name)).strip() or "model.glb"
            ext = os.path.splitext(name)[1].lower()
            if ext not in MODEL_EXT and ext != ".zip":
                return self.send_json({"error": "unsupported file type"}, 400)
            if length <= 0 or length > MAX_UPLOAD:
                return self.send_json({"error": "file too large"}, 413)
            os.makedirs(MODELS, exist_ok=True)
            path = os.path.join(MODELS, name)
            with open(path + ".part", "wb") as fh:
                left = length
                while left:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    fh.write(chunk)
                    left -= len(chunk)
            os.replace(path + ".part", path)
            if ext == ".zip":
                try:
                    folder = unpack_zip(path)
                finally:
                    os.remove(path)
                main = find_main(folder)
                if not main:
                    return self.send_json({"error": "no .glb/.gltf/.obj/.fbx/.stl inside the zip"}, 400)
                rel = os.path.relpath(main, ROOT).replace(os.sep, "/")
                return self.send_json({"src": urllib.parse.quote(rel), "name": nice_name(os.path.basename(folder))})
            return self.send_json({"src": f"models/{urllib.parse.quote(name)}", "name": nice_name(name)})
        self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


if __name__ == "__main__":
    threading.Thread(target=saver, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    ip = lan_ip()
    print("spoutyModel is running.\n")
    print(f"  Operator view:     http://localhost:{PORT}/")
    if ip:
        print(f"  Tablet / phone:    http://{ip}:{PORT}/   (same network; allow Python through the firewall if asked)")
    print(f"  Igloo web layer:   http://localhost:{PORT}/index.html?view=igloo   (4096 x 2048, Dynamic Resolution off)\n")
    print("Close this window to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
