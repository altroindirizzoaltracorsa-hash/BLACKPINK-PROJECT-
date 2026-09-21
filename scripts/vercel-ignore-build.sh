#!/usr/bin/env bash
# Vercel "Ignored Build Step" — cuts wasted rebuilds.
#
# Set this as the project's Ignored Build Step (Vercel → Project → Settings → Git
# → Ignored Build Step):
#     bash scripts/vercel-ignore-build.sh
#
# Vercel convention: exit 0 = SKIP the deploy, exit 1 (any non-zero) = BUILD.
#
# The site's chart/data files under data/ (K-Charts, iTunes/Apple/YouTube chart
# positions, girl-group streams, pre-releases) are auto-committed ~20×/day and are
# read by the frontend straight from raw.githubusercontent.com/.../main/data/*.json
# — NOT from the Vercel deployment. So a rebuild triggered by a data-only commit
# produces a byte-identical site and just burns Build CPU minutes. This skips the
# build when a commit changed ONLY data/ ; any code change still deploys normally.
set -u

prev="${VERCEL_GIT_PREVIOUS_SHA:-}"

# No known previous successful deploy (first build), or it's outside our shallow
# clone's history → build, to be safe. Better to waste one build than skip a real
# code change.
if [ -z "$prev" ] || ! git cat-file -e "${prev}^{commit}" 2>/dev/null; then
  echo "no usable VERCEL_GIT_PREVIOUS_SHA — building"
  exit 1
fi

# git diff --quiet exits 0 when there is NO diff in the given paths, 1 when there is.
# Paths = everything EXCEPT data/. So exit 0 (skip) iff nothing outside data/ changed.
if git diff --quiet "$prev" HEAD -- . ':(exclude)data' ':(exclude)data/**'; then
  echo "only data/ changed since ${prev} — skipping deploy (data is served from GitHub raw, not Vercel)"
  exit 0
fi

echo "code changed since ${prev} — building"
exit 1
