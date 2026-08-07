"""
Read-only verification of the overnight canary poller's first live night.
Pulls from the live /api/streams:
  1. Per-track campaign history + _debug (errors, keyCounts, prev dates)
  2. The canary attempt log (?action=canary-log) — the overnight poll trail
  3. Catalog history (?catalog=1) — to confirm the canary->catalog trigger fired
"""
import os, json, httpx

BASE = "https://www.blinksunited.com/api/streams"
KEY = os.environ.get("ADMIN_KEY", "")

def num(v):
    return f"{v:,}" if isinstance(v, int) else str(v)

with httpx.Client(timeout=60, follow_redirects=True) as c:
    r = c.get(BASE, params={"_poll": "verify"})
    print(f"HTTP {r.status_code}\n")
    data = r.json()
    dbg = data.get("_debug", {})
    print("=== _debug ===")
    print("  live:", dbg.get("live"), " keyCounts:", dbg.get("keyCounts"))
    print("  errors:", dbg.get("errors") or "(none)")
    print("  prev:", dbg.get("prev"))

    print("\n=== per-track history (last 6) + Aug-6 (06/08) check ===")
    for name in ["jump", "shutdown", "ddududu", "go"]:
        b = data.get(name) or {}
        hist = b.get("history") or []
        print(f"\n--- {name} ---  total={num(b.get('total'))}  prev={b.get('prev')}")
        for h in hist[-6:]:
            note = f"  [{h['note']}]" if h.get("note") else ""
            print(f"    {h.get('date')}  {num(h.get('streams')):>13}{note}")
        aug6 = next((h for h in hist if h.get("date") == "06/08"), None)
        if aug6:
            verdict = "CLEAN single-day ✅" if not aug6.get("note") else f"LUMPED ⚠ ({aug6['note']})"
            print(f"    -> 06/08 entry: {num(aug6['streams'])}  {verdict}")
        else:
            print("    -> 06/08 entry: MISSING")

    print("\n=== canary attempt log (newest first) ===")
    rl = c.get(BASE, params={"action": "canary-log", "key": KEY, "n": 90})
    if rl.is_error:
        print("  error:", rl.status_code, rl.text[:200])
    else:
        log = rl.json()
        print(f"  {log.get('count')} entries:")
        for e in log.get("entries", []):
            flag = "  <== CAUGHT BUMP (fresh)" if e.get("fresh") else ""
            print(f"    {e.get('at')}  {str(e.get('trig')):7} got={num(e.get('got')):>13} prev={num(e.get('prev')):>13}{flag}")

    print("\n=== catalog history (?catalog=1) ===")
    rc = c.get(BASE, params={"catalog": "1"})
    if rc.is_error:
        print("  error:", rc.status_code, rc.text[:200])
    else:
        print(json.dumps(rc.json(), indent=1)[:1800])
