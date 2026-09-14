#!/usr/bin/env python3
"""
Seeds the demonstration's people.

Runs against the throwaway demo database after the server has booted once, so the migrations
have already created the tables. Everything here is fictional: two administrators who can
instruct the agent, and three customers linked to the mock ledger's accounts.

The `ledgerId` custom field is the link between a WhatsApp number and an account in the
accounting system. It is deliberately explicit — the agent will not guess which account a
number belongs to by matching a name, so a customer with no `ledgerId` is told their number
could not be matched rather than being read someone else's balance.
"""
import json
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "agent.sqlite")

ADMINS = [
    ("923001111111", "Ahmed (owner)", "admin"),
    ("923002222222", "Manager", "admin"),
]

# phone, display name, company, ledger account in the mock accounting system
CUSTOMERS = [
    ("923214455667", "Ali Accounts", "Ali Textiles", "CUST-ALI"),
    ("923009988776", "Bilal Sheikh", "Bilal Fabrics", "CUST-BILAL"),
    ("923455566778", "Dawood Khan", "Dawood Trading", "CUST-DAWOOD"),
]


def main() -> int:
    if not os.path.exists(DB):
        print(f"no demo database at {DB} — start the server once first", file=sys.stderr)
        return 1

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    c = sqlite3.connect(DB, timeout=10)

    for phone, label, role in ADMINS:
        if c.execute("SELECT 1 FROM agent_admin_numbers WHERE phoneE164=?", (phone,)).fetchone():
            continue
        c.execute(
            "INSERT INTO agent_admin_numbers (id, phoneE164, label, role, isActive, createdAt) "
            "VALUES (?,?,?,?,1,?)",
            (str(uuid.uuid4()), phone, label, role, now),
        )

    for phone, name, company, ledger_id in CUSTOMERS:
        fields = json.dumps({"ledgerId": ledger_id})
        row = c.execute("SELECT id FROM cc_customer_profiles WHERE phone=?", (phone,)).fetchone()
        if row:
            c.execute("UPDATE cc_customer_profiles SET customFields=? WHERE id=?", (fields, row[0]))
            continue
        c.execute(
            "INSERT INTO cc_customer_profiles "
            "(id, waId, phone, displayName, company, customFields, createdAt, updatedAt) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), f"{phone}@c.us", phone, name, company, fields, now, now),
        )

    c.commit()
    admins = c.execute("SELECT COUNT(*) FROM agent_admin_numbers").fetchone()[0]
    customers = c.execute("SELECT COUNT(*) FROM cc_customer_profiles").fetchone()[0]
    print(f"seeded: {admins} administrators, {customers} customers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
