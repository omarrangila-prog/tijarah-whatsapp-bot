"""Renders the agent's audit trail as a table for the demonstration."""
import sys, json

rows = json.load(sys.stdin)
print(f"  {'WHO':<8} {'ROLE':<9} {'OUTCOME':<9} {'MESSAGE':<38} DECISIONS")
print("  " + "-" * 92)
for turn in reversed(rows):
    actions = turn.get("actions") or []
    decisions = (
        "; ".join(f"{a['tool']}->{a['decision']}" for a in actions)
        if isinstance(actions, list) else ""
    )
    if turn.get("injectionFlag"):
        decisions = (decisions + "  [INJECTION FLAGGED]").strip()
    who = (turn.get("sender") or "")[-6:]
    message = (turn.get("inbound") or "")[:36]
    print(f"  {who:<8} {turn['role']:<9} {turn['outcome']:<9} {message:<38} {decisions}")
