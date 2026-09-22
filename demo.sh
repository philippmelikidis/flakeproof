#!/usr/bin/env bash
# Runs flakeproof end to end against the repository's own fixture pages, so you
# can see a real verdict and a real report without wiring up your own project.
#
#   ./demo.sh            writes demo-report.html and opens it
#   ./demo.sh --no-open  writes it without opening
set -euo pipefail
cd "$(dirname "$0")"

PORT_GREEN=8401
PORT_NEW=8402
OUT=demo-report.html

for p in "$PORT_GREEN" "$PORT_NEW"; do
  if lsof -ti ":$p" >/dev/null 2>&1; then
    echo "port $p is in use; free it or edit demo.sh" >&2
    exit 1
  fi
done

# Job control off, so killing the server on exit does not print a
# "Terminated" line over the report.
set +m

node -e '
const http=require("http"),fs=require("fs"),path=require("path");
function serve(dir,port){http.createServer((q,s)=>{
  const f=path.join(dir, q.url==="/"?"index.html":q.url.slice(1));
  fs.readFile(f,(e,d)=>{ if(e){s.writeHead(404);s.end("not found");return;}
    s.writeHead(200,{"content-type":f.endsWith(".svg")?"image/svg+xml":"text/html"});s.end(d);});
}).listen(port);}
serve("test/fixtures/page", '"$PORT_GREEN"');
serve("test/fixtures/page-v2", '"$PORT_NEW"');
' 2>/dev/null &
SERVERS=$!

WORK="$(mktemp -d)"
cleanup() {
  kill "$SERVERS" 2>/dev/null || true
  wait "$SERVERS" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

sleep 1.5

echo "1. Record a baseline while the build is green."
node bin/flakeproof.js snapshot "http://127.0.0.1:$PORT_GREEN/" --out "$WORK/baseline.json"

echo
echo "2. The build ships. A test that pinned a build-generated class now fails:"
cat > "$WORK/error.txt" <<'ERR'
locator.click: Timeout 1500ms exceeded.
Call log:
  - waiting for locator('li.css-1a2b3c')
ERR
sed 's/^/     /' "$WORK/error.txt"

echo
echo "3. Triage it against the new build."
node bin/flakeproof.js triage \
  --baseline "$WORK/baseline.json" \
  --error-file "$WORK/error.txt" \
  --current-url "http://127.0.0.1:$PORT_NEW/"

node bin/flakeproof.js triage \
  --baseline "$WORK/baseline.json" \
  --error-file "$WORK/error.txt" \
  --current-url "http://127.0.0.1:$PORT_NEW/" \
  --out "$OUT" >/dev/null

echo
echo "Full report written to $OUT"
if [ "${1:-}" != "--no-open" ] && command -v open >/dev/null 2>&1; then
  open "$OUT"
fi
