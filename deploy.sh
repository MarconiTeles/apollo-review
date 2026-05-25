#!/usr/bin/env bash
# Build the viewer and publish dist/ to the gh-pages branch of `origin`.
# GitHub Pages serves that branch at https://<user>.github.io/apollo-review/.
#
# Usage:  ./deploy.sh
#
# (We deploy the pre-built dist/ to a branch instead of using a GitHub Actions
# workflow because the local gh token lacks the `workflow` scope. To switch to
# auto-deploy on push, run `gh auth refresh -s workflow` and add a Pages action.)
set -euo pipefail
cd "$(dirname "$0")"

npm run build

REMOTE="$(git remote get-url origin)"
cd dist
git init -q -b gh-pages
git add -A
git -c user.email="deploy@local" -c user.name="deploy" commit -q -m "deploy $(date -u +%FT%TZ)"
git push -f -q "$REMOTE" gh-pages
rm -rf .git
echo "Deployed dist/ → gh-pages. Pages: https://<user>.github.io/apollo-review/"
