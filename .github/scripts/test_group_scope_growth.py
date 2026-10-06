"""A re-seed must not disappear into a normal daily delta.

Run: python3 .github/scripts/test_group_scope_growth.py

fetch_group_streams already refuses a FALLING total loudly — that is the
BABYMONSTER re-scope, and storing it would corrupt every later delta. The
opposite direction had no guard at all: a track added to the pinned catalogue
arrives carrying its whole back catalogue, and the entire figure lands in one
day's delta looking like an unusually good day.

The case that prompted this is real. kworb began listing Bye Bye Inhibitions
(Alok x NAYEON x TWICE) on TWICE's page on 2026-10-05 — asterisked as a feature
but inside kworb's own total, confirmed by the seeder reconciling 330 rows
against kworb's summary to the digit. Re-seeding moves ~780k of back catalogue
into TWICE's total in a single day.
"""
import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))

# The module imports httpx and spotify_scraper at the top for the live fetch.
# Neither is needed to exercise a pure function, and requiring them would make
# this test only runnable where the job itself runs.
for name, attrs in (("httpx", {}), ("spotify_scraper", {"SpotifyClient": object})):
    if name not in sys.modules:
        m = types.ModuleType(name)
        for k, v in attrs.items():
            setattr(m, k, v)
        m.HTTPError = type("HTTPError", (Exception,), {})
        sys.modules[name] = m

spec = importlib.util.spec_from_file_location(
    "fgs", os.path.join(HERE, "fetch_group_streams.py"))
fgs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fgs)

fails = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)


print("--- an ordinary day")
known = {"a": 100, "b": 200, "c": 300}
got = {"a": 110, "b": 205, "c": 330}
fresh, added = fgs.scope_growth(got, known)
check(fresh == [] and added == 0,
      f"every track was already counted, so nothing is flagged ({fresh}, {added})")

print("\n--- the TWICE re-seed")
# Bye Bye Inhibitions enters with its whole history behind it.
known = {"a": 1_000_000, "b": 2_000_000}
got = {"a": 1_010_000, "b": 2_020_000, "0uI8zAUhinOJDIfWYam8lX": 783_063}
fresh, added = fgs.scope_growth(got, known)
check(fresh == ["0uI8zAUhinOJDIfWYam8lX"], f"the new track is named ({fresh})")
check(added == 783_063, f"with the full figure it brings, not its daily ({added:,})")
# The point of the number: the day's delta is 30,000 of real listening and
# 783,063 of back catalogue, and without the note the row reads as 813,063.
day_delta = sum(got.values()) - sum(known.values())
check(day_delta == 813_063 and day_delta - added == 30_000,
      f"so the real gain is {day_delta - added:,}, not the {day_delta:,} the delta shows")

print("\n--- a first-ever record is not a scope change")
fresh, added = fgs.scope_growth({"a": 5, "b": 6}, {})
check(fresh == [] and added == 0,
      "with no baseline every track is new, which must not be reported as growth")

print("\n--- a track that failed today is not new")
# A failed fetch is carried forward from `known` before this runs, so the id is
# present in `got` with its last-known value. It must not count as added.
known = {"a": 100, "b": 200}
got = {"a": 110, "b": 200}
fresh, added = fgs.scope_growth(got, known)
check(fresh == [] and added == 0, "a carried-forward value is not catalogue growth")

print("\n--- a track dropped from the catalogue")
# The reverse direction is handled by the refuse-on-fall guard, not here; this
# just pins that scope_growth stays quiet rather than reporting something odd.
fresh, added = fgs.scope_growth({"a": 110}, {"a": 100, "b": 200})
check(fresh == [] and added == 0, "a removal is the fall guard's business, not this one")

print("\n--- several at once, as a live album re-seed would be")
known = {"a": 1}
got = {"a": 2, "n1": 10, "n2": 20, "n3": 30}
fresh, added = fgs.scope_growth(got, known)
check(sorted(fresh) == ["n1", "n2", "n3"] and added == 60,
      f"all of them, summed ({len(fresh)} tracks, {added})")

print(f"\nFAILURES: {len(fails)}")
for f in fails:
    print("  - " + f)
sys.exit(1 if fails else 0)
