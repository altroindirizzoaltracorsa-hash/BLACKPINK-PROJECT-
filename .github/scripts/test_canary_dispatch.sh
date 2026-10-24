#!/usr/bin/env bash
# The canary's branch of fetch-spotify-artists.yml, run with both network calls
# stubbed.
#
# The canary used to do the refresh itself: two 74-country bursts 75 seconds
# apart. Spotify rate-limits on a rolling window, the list is always walked in
# the same order, so the budget ran out in the same place every time and the
# tail of the alphabet — Thailand, Taiwan, Ukraine, the United States, Vietnam
# — was never fetched at all. It now hands the sweep to charts-full-sweep.yml,
# which paces it.
#
# What is worth testing is the handover, because every way it can go wrong is
# quiet: dispatching when the chart has not changed (wasted sweep), not
# dispatching when it has (no refresh at all), and — the one that bites —
# treating a refused dispatch as success, which looks exactly like a healthy
# canary that found nothing.
set -u
cd "$(dirname "$0")/../.."
WF=.github/workflows/fetch-spotify-artists.yml
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

python3 - "$WF" "$TMP/canary.sh" <<'PY' || { echo "  FAIL could not extract the canary step (PyYAML missing?)"; exit 1; }
import re, sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
s = wf['jobs']['fetch']['steps'][0]['run']
# Replace the two network calls. Each substitution is asserted, because a
# silent miss would leave the real curl in and test nothing.
s, n1 = re.subn(r'code=\$\(curl[\s\S]*?\$1"\)', 'code=$(bash "$STUBS/hit_stub.sh" "$1")', s)
s, n2 = re.subn(r"dc=\$\(curl[\s\S]*?'\) \|\| dc=000", 'dc=$(bash "$STUBS/dispatch_stub.sh") || dc=000', s)
assert n1 == 1, f'hit substitution matched {n1} times'
assert n2 == 1, f'dispatch substitution matched {n2} times'
assert 'curl' not in s, 'a curl survived the substitution'
open(sys.argv[2], 'w').write(s)
PY

cat > "$TMP/hit_stub.sh" <<'EOF'
echo "{\"changed\":${CHANGED:-false}}" > /tmp/out.json; echo 200
EOF
cat > "$TMP/dispatch_stub.sh" <<'EOF'
echo '{"message":"stub"}' > /tmp/dispatch.json; echo "${DISPATCH_CODE:-204}"
EOF

fails=0
run() {  # run <description> <want-exit> <want-dispatch: yes|no> [env...]
  desc="$1"; want="$2"; wantd="$3"; shift 3
  out="$TMP/out.log"
  env "$@" STUBS="$TMP" SCHED='0 */2 * * *' INPUT_TYPE='' PROBE='' \
      ADMIN_KEY=x BASE=http://fake GH_TOKEN=t GITHUB_REPOSITORY=o/r \
      bash "$TMP/canary.sh" > "$out" 2>&1
  got=$?
  gotd=no; grep -q 'dispatching charts-full-sweep' "$out" && gotd=yes
  if [ "$got" = "$want" ] && [ "$gotd" = "$wantd" ]; then
    echo "  ok   $desc"
  else
    echo "  FAIL $desc (exit $got want $want; dispatched $gotd want $wantd)"
    sed 's/^/        /' "$out" | head -4
    fails=$((fails+1))
  fi
}

echo "--- the canary hands its refresh over ---"
run "chart unchanged: no sweep is dispatched"            0 no  CHANGED=false
run "chart changed: the chunked sweep is dispatched"     0 yes CHANGED=true DISPATCH_CODE=204
# The quiet one. A 403 (token without actions:write) must not pass as success,
# or the canary reports green while no refresh ever ran.
run "dispatch refused 403: the run fails"                1 yes CHANGED=true DISPATCH_CODE=403
run "dispatch unreachable: the run fails"                1 yes CHANGED=true DISPATCH_CODE=000
run "dispatch 404 (workflow renamed): the run fails"     1 yes CHANGED=true DISPATCH_CODE=404

echo
[ "$fails" -eq 0 ] && echo "all good" || echo "$fails failure(s)"
exit $((fails > 0))
