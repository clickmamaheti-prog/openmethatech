#!/usr/bin/env python3
"""MethaTech CLI live API probe (part 1: catalog + account endpoints).
BORE SIDE ONLY. Reads the tuyul test token from the live DB into memory.
The key is NEVER printed, logged, or written anywhere except a 0600
curl config that is deleted immediately after use. Read-only DB access.
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
cur.execute(
    "SELECT id, name, key FROM tokens WHERE user_id=10 AND id=16 AND status=1"
)
row = cur.fetchone()
db.close()
if not row:
    print("NO usable tuyul token found")
    sys.exit(1)
token_id, token_name, key = row
print(f"using tuyul token id={token_id} name={token_name} (key NOT shown)")

cfg = tempfile.NamedTemporaryFile("w", delete=False, prefix="mtcli-cfg-")
cfg.write(f'header = "Authorization: Bearer {key}"\n')
cfg.close()
os.chmod(cfg.name, 0o600)

def curl(args):
    r = subprocess.run(
        ["curl", "-s", "-K", cfg.name, "--max-time", "20"] + args,
        capture_output=True, text=True, timeout=30,
    )
    return r.stdout

try:
    print("\n=== GET /v1/models ===")
    out = curl(["https://api.methatech.eu.org/v1/models"])
    print(out[:1500])
    print("\n=== GET /v1/dashboard/billing/subscription ===")
    out = curl(["https://api.methatech.eu.org/v1/dashboard/billing/subscription"])
    print(out[:1500])
    print("\n=== GET /v1/dashboard/billing/usage (alt) ===")
    out = curl(["https://api.methatech.eu.org/v1/dashboard/billing/usage"])
    print(out[:800])
finally:
    os.unlink(cfg.name)
    print("\n(curl config deleted)")
