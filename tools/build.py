"""Build the Asset Record web app.

  python3 tools/build.py <seed.json>

Outputs
  dist/web/       installable PWA (host on any HTTPS server; iPhone, Android, PC)
  dist/artifact.html  single-file test build (no <head>; for the claude.ai test link)
  dist/demo-master.json  the demo master that is embedded in both

The demo master holds only Class&Units taxonomy (location classes, asset classes, units,
a few manufacturers) plus an invented DEMO facility. No workbook users, facilities,
locations or assets are embedded.
"""
import json, os, sys, shutil, datetime
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, DIST = os.path.join(ROOT, "src"), os.path.join(ROOT, "dist")
seed = json.load(open(sys.argv[1], encoding="utf-8"))
today = datetime.date.today().strftime("%d.%m.%Y")

# ---------------------------------------------------------------- demo master
cls = {c["name"].upper(): c for c in seed["locClasses"]}
FAC = "F99 DEMO"
def loc(fl, desc, local, parent_fl, parent_code, final, seq, level):
    c = cls[desc.upper()]
    return [fl, desc, local, parent_fl, FAC, "demo", today, c["locCode"], c["secondCode"], c["g"], c["a"], c["g"],
            parent_code, c["cls"], final, str(seq), str(level)]
locations = [
    loc("F900001", "Facility", "DEMO_SITE", "F100001", "", "DEMO", 1, 1),
    loc("F900002", "Area", "Demo Compound", "F900001", "DEMO", "DEMO-SA001", 1, 2),
    loc("F900003", "Building", "Demo Admin Block", "F900002", "DEMO-SA001", "DEMO-SA001-B001", 1, 3),
    loc("F900004", "Ground Floor", "Admin Block", "F900003", "DEMO-SA001-B001", "DEMO-SA001-B001-GF00", 1, 4),
]
types = {t["name"].upper(): t for t in seed["assetTypes"]}
def asset(tag, desc, fl_row, mfg, unit, cap):
    t = types.get(desc.upper())
    r = [""] * 45
    r[0], r[1], r[2], r[7], r[8], r[9], r[10], r[12] = tag, desc, mfg, "Site Survey", fl_row[0], fl_row[14], "1", "31.12.9999"
    r[5], r[6], r[20], r[43] = (t["systemCode"], t["system"], t["category"], t["categoryCode"]) if t else ("NCA", "Class not assigned", "Class not assigned", "NCA")
    r[14], r[15], r[16], r[17], r[18], r[19], r[21], r[22] = unit, cap, "demo", today, "demo", today, "Good", "Asset"
    parts = fl_row[14].split("-")
    by_final = {l[14]: l for l in locations}
    for i in range(min(len(parts), 6)):
        code = "-".join(parts[: i + 1]); r[23 + i] = code
        l = by_final.get(code); r[29 + i] = (l[1] + " " + l[2]).strip() if l else ""
    r[37], r[40], r[41] = "No", "In Use", FAC
    return r
first_types = [t["name"] for t in seed["assetTypes"]][:2]
assets = [asset("EQP900001", first_types[0], locations[3], "DEMO BRAND", "", ""),
          asset("EQP900002", first_types[1], locations[3], "DEMO BRAND", "", "")]
demo = {
    "version": "demo-" + datetime.date.today().strftime("%Y%m%d"), "demo": True,
    "users": [{"name": "demo", "id": "1", "password": "demo", "role": "Admin"}, {"name": "viewer", "id": "2", "password": "viewer", "role": "Viewer"}],
    "facilities": [{"code": FAC, "name": "Demo Facility"}],
    "locClasses": seed["locClasses"], "assetTypes": seed["assetTypes"], "units": seed["units"],
    "manufacturers": seed["manufacturers"][:40], "models": [], "receivedFrom": seed["receivedFrom"],
    "locations": locations, "assets": assets,
}
os.makedirs(DIST, exist_ok=True)
demo_json = json.dumps(demo, ensure_ascii=False, separators=(",", ":"))
open(os.path.join(DIST, "demo-master.json"), "w", encoding="utf-8").write(demo_json)

# ---------------------------------------------------------------- page body (shared)
css = open(os.path.join(SRC, "styles.css"), encoding="utf-8").read()
logic = open(os.path.join(SRC, "logic.js"), encoding="utf-8").read() + "\n" + open(os.path.join(SRC, "xlsread.js"), encoding="utf-8").read()
appjs = open(os.path.join(SRC, "app.js"), encoding="utf-8").read()
safe_demo = demo_json.replace("</", "<\\/")
body = f"""<div id="app"></div>
<script type="application/json" id="demo-master">{safe_demo}</script>
<script>{logic}</script>
<script>{appjs}</script>"""

# test build for the claude.ai link (skeleton adds doctype/head/body)
open(os.path.join(DIST, "artifact.html"), "w", encoding="utf-8").write(
    f"<title>Asset Record</title>\n<style>{css}</style>\n{body}\n")

# ---------------------------------------------------------------- PWA
web = os.path.join(DIST, "web")
shutil.rmtree(web, ignore_errors=True); os.makedirs(web)
version = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
sw_reg = """<script>
if ("serviceWorker" in navigator && !window.Capacitor && (location.protocol === "https:" || location.hostname === "localhost"))
  navigator.serviceWorker.register("sw.js").catch(function () {});
</script>"""
html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Asset Record</title>
<meta name="theme-color" content="#2B2825">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="Asset Record">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon-192.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<style>{css}
:root {{ padding-top: env(safe-area-inset-top, 0px); }} .bar {{ top: 0; }}</style>
</head>
<body>
{body}
{sw_reg}
</body>
</html>
"""
open(os.path.join(web, "index.html"), "w", encoding="utf-8").write(html)
json.dump({
    "name": "Asset Record", "short_name": "Asset Record", "start_url": "./", "scope": "./", "display": "standalone",
    "background_color": "#F5F6F7", "theme_color": "#2B2825", "orientation": "any",
    "icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
              {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
              {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}],
}, open(os.path.join(web, "manifest.webmanifest"), "w"), indent=2)
open(os.path.join(web, "sw.js"), "w").write(f"""// offline app shell, version {version}
const CACHE = "asset-record-{version}";
const SHELL = ["./", "index.html", "xlsx.full.min.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
self.addEventListener("install", (e) => {{ e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); }});
self.addEventListener("activate", (e) => {{ e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); }});
self.addEventListener("fetch", (e) => {{
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  // network first for the page so updates arrive; cache fallback offline
  e.respondWith(fetch(e.request).then((r) => {{ const c = r.clone(); caches.open(CACHE).then((ca) => ca.put(e.request, c)); return r; }})
    .catch(() => caches.match(e.request).then((m) => m || caches.match("index.html"))));
}});
""")

def icon(size, path):
    s = 4
    im = Image.new("RGBA", (size * s, size * s), (0, 112, 242, 255))
    d = ImageDraw.Draw(im)
    try: f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", int(size * s * 0.36))
    except Exception: f = ImageFont.load_default()
    d.text((size * s / 2, size * s / 2), "AR", fill="white", font=f, anchor="mm")
    im.resize((size, size), Image.LANCZOS).convert("RGB").save(path)
shutil.copy(os.path.join(ROOT, "vendor", "xlsx.full.min.js"), os.path.join(web, "xlsx.full.min.js"))
shutil.copy(os.path.join(ROOT, "vendor", "xlsx.full.min.js"), os.path.join(DIST, "xlsx.full.min.js"))
icon(192, os.path.join(web, "icon-192.png")); icon(512, os.path.join(web, "icon-512.png")); icon(180, os.path.join(web, "apple-touch-icon.png"))
print("built", {k: os.path.getsize(os.path.join(DIST, k)) for k in ["artifact.html", "demo-master.json"]}, os.listdir(web))
