#!/usr/bin/env python3
"""MethaTech CLI live API probe (part 2: chat + user endpoints).
BORE SIDE ONLY. Reads the tuyul test token (id 16, "Tes") from the live DB
into memory. The key is NEVER printed, logged, or written anywhere except a
0600 curl config that is deleted immediately after use. Read-only DB access.
One short call per model only (max_tokens 20).
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile

DB = "/var/lib/donehub/done-hub.db"

db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
cur = db.cursor()
cur.execute("SELECT id, name, key FROM tokens WHERE user_id=10 AND id=16 AND status=1")
row = cur.fetchone()
db.close()
if not row:
    print("NO token id=16")
    sys.exit(1)
token_id, token_name, key = row
print(f"using tuyul token id={token_id} name={token_name} (key NOT shown)")

cfg = tempfile.NamedTemporaryFile("w", delete=False, prefix="mtcli-cfg-")
cfg.write(f'header = "Authorization: Bearer {key}"\n')
cfg.close()
os.chmod(cfg.name, 0o600)

def curl_json(method, url, body=None):
    args = ["curl", "-s", "-K", cfg.name, "--max-time", "25", "-X", method]
    if body is not None:
        args += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    r = subprocess.run(args + [url], capture_output=True, text=True, timeout=35)
    return r.stdout

def curl_raw(method, url, body=None):
    return curl_json(method, url, body)

try:
    print("\n=== GET /v1/user/self ===")
    print(curl_json("GET", "https://api.methatech.eu.org/v1/user/self")[:600])

    prompt = "What is 2+2? Answer in one word."
    print("\n=== POST chat non-stream glm-5.3-flash (FREE) ===")
    out = curl_json("POST", "https://api.methatech.eu.org/v1/chat/completions",
                    {"model": "glm-5.3-flash",
                     "messages": [{"role": "user", "content": prompt}],
                     "max_tokens": 20})
    print(out[:1200])

    print("\n=== POST chat STREAM glm-5.3-flash + include_usage ===")
    out = curl_raw("POST", "https://api.methatech.eu.org/v1/chat/completions",
                   {"model": "glm-5.3-flash",
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 20, "stream": True,
                    "stream_options": {"include_usage": True}})
    print(out[:2000])

    print("\n=== POST chat non-stream claude-sonnet-4-6 (PAID) ===")
    out = curl_json("POST", "https://api.methatech.eu.org/v1/chat/completions",
                    {"model": "claude-sonnet-4-6",
                     "messages": [{"role": "user", "content": prompt}],
                     "max_tokens": 20})
    print(out[:1200])
finally:
    os.unlink(cfg.name)
    print("\n(curl config deleted)")
