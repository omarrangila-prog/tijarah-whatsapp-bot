"""Prints the agent's reply from a /api/agent/simulate response."""
import sys, json

try:
    data = json.load(sys.stdin)
except Exception:
    print("(no response from the server)")
    raise SystemExit(0)

if data.get("text"):
    print(data["text"])
elif data.get("statusCode"):
    # Surface a real HTTP error rather than dressing it up as silence.
    print(f"[HTTP {data['statusCode']}] {data.get('message')}")
else:
    print("(silent — not authorised, or ignored by policy)")
