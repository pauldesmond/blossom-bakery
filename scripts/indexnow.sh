#!/usr/bin/env bash
# Ping IndexNow so Bing / Yandex / DuckDuckGo / Seznam re-crawl updated URLs.
#
# Usage:
#   scripts/indexnow.sh <url> [<url>...]      # submit specific URLs
#   scripts/indexnow.sh --all                 # submit every URL in sitemap.xml
#
# Submits one URL per HTTP GET (streaming mode). Bing Webmaster Tools flags
# batch JSON urlList submissions as suboptimal — streaming gives faster
# reflection and lower server overhead.
#
# Key file lives at myblossombakery.com/dd9a1d12954e66976fda393be7069391.txt and must stay in the
# repo root for IndexNow to trust this host.

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <url>... | --all" >&2
  exit 1
fi

python3 - "$@" <<'PY'
import sys, re, time, urllib.request, urllib.error, urllib.parse
from pathlib import Path

KEY = "dd9a1d12954e66976fda393be7069391"
HOST = "myblossombakery.com"

args = sys.argv[1:]
if args == ["--all"]:
    urls = re.findall(r'<loc>([^<]+)</loc>', Path('sitemap.xml').read_text())
else:
    urls = args

print(f"Submitting {len(urls)} URL(s) to IndexNow (streaming, one per request)...", flush=True)
ok = fail = 0
for url in urls:
    qs = urllib.parse.urlencode({"url": url, "key": KEY})
    req = urllib.request.Request(f"https://api.indexnow.org/IndexNow?{qs}", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            ok += 1
            if len(urls) <= 5:
                print(f"  OK {r.status}: {url}")
    except urllib.error.HTTPError as e:
        fail += 1
        body = e.read().decode(errors='replace') if e.fp else ''
        print(f"  FAIL {e.code}: {url} — {body[:120]}", file=sys.stderr)
    except Exception as e:
        fail += 1
        print(f"  FAIL: {url} — {e}", file=sys.stderr)
    if len(urls) > 10:
        time.sleep(0.05)

print(f"Done — {ok} ok, {fail} failed.")
sys.exit(0 if fail == 0 else 1)
PY
