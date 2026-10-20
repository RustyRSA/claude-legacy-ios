#!/usr/bin/env bash
# tools/update.sh - one command from an update patch to the app on the iPhone.
#
#   bash tools/update.sh [update.patch]   apply, commit, push, build, check, install
#   bash tools/update.sh --build-only     build (or reuse a build of) what is pushed
#   bash tools/update.sh --no-install     stop after downloading and checking the IPA
#   bash tools/update.sh --rebuild        always start a fresh build
#
# Without a patch path it uses the newest claude-legacy-*.patch in ~/Downloads.
# Run it from Git Bash inside the repository. Needs: git, GitHub CLI (gh, signed
# in with the workflow scope), and SSH access to the jailbroken iPhone.
#
# Everything runs inside main(), which bash reads in full before starting, so an
# update that changes this script cannot disturb the copy that is running.

main() {
  set -euo pipefail

  local WORKFLOW="build-ipa.yml"
  local ARTIFACT="ClaudeLegacy-ipa"
  local PHONE_FILE="$HOME/.claude-legacy-phone"
  local REMOTE_IPA="/var/mobile/Documents/ClaudeLegacy.ipa"

  local APPLY=1 INSTALL=1 REBUILD=0 PATCH="" arg
  for arg in "$@"; do
    case "$arg" in
      --build-only) APPLY=0 ;;
      --no-install) INSTALL=0 ;;
      --rebuild) REBUILD=1 ;;
      -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}"; return 0 ;;
      -*) die "unknown option: $arg" ;;
      *) PATCH="$arg" ;;
    esac
  done

  local REPO_DIR
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$REPO_DIR"

  local tool
  for tool in git gh ssh scp sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' was not found. See the setup steps."
  done
  gh auth status >/dev/null 2>&1 || die "GitHub CLI is not signed in. Run: gh auth login --scopes workflow"

  # Point every gh command at this fork explicitly; for a fork gh will not guess.
  local ORIGIN
  ORIGIN="$(git remote get-url origin)"
  export GH_REPO
  GH_REPO="$(printf '%s' "$ORIGIN" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
  case "$GH_REPO" in
    */*) ;;
    *) die "Could not work out the GitHub repository from origin ($ORIGIN)." ;;
  esac

  local BRANCH
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"

  # Commits are made as you, with GitHub's private no-reply address (this
  # repository only), so your personal email never appears in the public history.
  if [ -z "$(git config --local user.email || true)" ]; then
    local GH_LOGIN GH_ID
    GH_LOGIN="$(gh api user --jq .login)"
    GH_ID="$(gh api user --jq .id)"
    git config --local user.name "$(gh api user --jq '.name // .login')"
    git config --local user.email "${GH_ID}+${GH_LOGIN}@users.noreply.github.com"
    echo "Commits in this repository will use ${GH_ID}+${GH_LOGIN}@users.noreply.github.com"
  fi

  # -------------------------------------------------------------- 1. update
  if [ "$APPLY" = 1 ]; then
    if [ -z "$PATCH" ]; then
      PATCH="$(ls -t "$HOME"/Downloads/claude-legacy-*.patch 2>/dev/null | head -n 1 || true)"
      [ -n "$PATCH" ] || die "No patch given, and no claude-legacy-*.patch found in ~/Downloads."
    fi
    [ -f "$PATCH" ] || die "Patch not found: $PATCH"

    # The patch's Subject line (it may be folded over several lines), without "[PATCH]".
    local SUBJECT
    SUBJECT="$(awk '/^Subject: / {
        s = $0; sub(/^Subject: *(\[[^]]*\] *)?/, "", s)
        while ((getline n) > 0 && n ~ /^[ \t]/) { sub(/^[ \t]+/, " ", n); s = s n }
        print s; exit
      }' "$PATCH")"
    [ -n "$SUBJECT" ] || SUBJECT="Update from $(basename "$PATCH")"
    step "Update: $SUBJECT"

    if tree_is_clean; then
      git pull --ff-only -q origin "$BRANCH" || die "Could not bring $BRANCH up to date with GitHub."
    fi

    if git apply --check "$PATCH" 2>/dev/null; then
      tree_is_clean || die "There are uncommitted changes. Commit or stash them first."
      git apply --index "$PATCH"
      echo "Applied $(basename "$PATCH")."
    elif git apply --reverse --check "$PATCH" 2>/dev/null; then
      echo "This update is already applied here; committing it."
      local file
      git apply --numstat "$PATCH" | cut -f3 | while IFS= read -r file; do git add -- "$file"; done
    else
      die "$(basename "$PATCH") does not apply to this checkout. Send Claude the output of: git log --oneline -3"
    fi

    if git diff --cached --quiet; then
      echo "Nothing new to commit."
    else
      git commit -q -m "$SUBJECT"
      echo "Committed $(git rev-parse --short HEAD)."
    fi

    step "Pushing to GitHub"
    git push -q origin "$BRANCH" || die "Push failed. If GitHub mentions the workflow scope, run: gh auth refresh -s workflow"
  fi

  # -------------------------------------------------------------- 2. build
  local HEAD_SHA RUN_ID="" line sha id
  HEAD_SHA="$(git rev-parse HEAD)"

  # Reuse a build that is running or succeeded for the same app code: changes
  # that only touch tools/ do not change the app, so they need no new build.
  if [ "$REBUILD" = 0 ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      id="${line%% *}"
      sha="${line##* }"
      [ -n "$id" ] && [ -n "$sha" ] || continue
      git cat-file -e "${sha}^{commit}" 2>/dev/null || continue
      if git diff --quiet "$sha" HEAD -- . ':(exclude)tools'; then
        RUN_ID="$id"
        step "Using build run $RUN_ID (commit ${sha:0:7}, same app code)"
        break
      fi
    done < <(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --limit 10 \
               --json databaseId,headSha,status,conclusion \
               --jq '.[] | select(.status != "completed" or .conclusion == "success") | "\(.databaseId) \(.headSha)"')
  fi

  if [ -z "$RUN_ID" ]; then
    step "Building on GitHub (commit ${HEAD_SHA:0:7})"
    local SINCE
    SINCE="$(date -u -d '-60 seconds' +%Y-%m-%dT%H:%M:%SZ)"
    gh workflow run "$WORKFLOW" --ref "$BRANCH" >/dev/null
    local _
    for _ in $(seq 1 40); do
      RUN_ID="$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --limit 10 \
        --json databaseId,headSha,createdAt \
        --jq "[.[] | select(.headSha == \"$HEAD_SHA\" and .createdAt >= \"$SINCE\")][0].databaseId // empty")"
      [ -n "$RUN_ID" ] && break
      sleep 3
    done
    [ -n "$RUN_ID" ] || die "The build did not show up on GitHub. Check the Actions tab."
  fi

  if ! gh run watch "$RUN_ID" --exit-status --interval 15; then
    echo
    gh run view "$RUN_ID" --log-failed 2>/dev/null | tail -n 60 || true
    die "The build failed (run $RUN_ID). Send Claude the lines above."
  fi

  # -------------------------------------------------------------- 3. check
  step "Downloading and checking the IPA"
  local OUT_DIR="$REPO_DIR/build/ipa"   # build/ is git-ignored
  rm -rf "$OUT_DIR"
  mkdir -p "$OUT_DIR"
  gh run download "$RUN_ID" --name "$ARTIFACT" --dir "$OUT_DIR"
  local IPA="$OUT_DIR/ClaudeLegacy.ipa"
  [ -f "$IPA" ] || die "The download did not contain ClaudeLegacy.ipa."

  local EXPECTED ACTUAL
  EXPECTED="$(gh run view "$RUN_ID" --log | grep -o 'IPA SHA-256: [0-9a-f]\{64\}' | head -n 1 | awk '{print $3}')"
  ACTUAL="$(sha256sum "$IPA" | awk '{print $1}')"
  [ -n "$EXPECTED" ] || die "Could not read the build's SHA-256 from its log."
  [ "$EXPECTED" = "$ACTUAL" ] || die "SHA-256 mismatch: the build reported $EXPECTED but the download is $ACTUAL."
  echo "SHA-256 matches the build: $ACTUAL"

  if [ "$INSTALL" = 0 ]; then
    echo
    echo "IPA saved to $IPA"
    return 0
  fi

  # -------------------------------------------------------------- 4. install
  local PHONE="${PHONE_IP:-$(cat "$PHONE_FILE" 2>/dev/null || true)}"
  if [ -z "$PHONE" ]; then
    read -r -p "iPhone IP address (Settings > Wi-Fi > (i)): " PHONE
    [ -n "$PHONE" ] || die "No IP address given."
    echo "$PHONE" > "$PHONE_FILE"
  fi

  step "Copying to the iPhone at $PHONE (password: the phone's mobile user)"
  scp -q "$IPA" "mobile@$PHONE:$REMOTE_IPA" || die "Copy failed. Is the phone awake, on the same network, with SSH running?"

  step "Installing with TrollStore (sudo may ask for the same password)"
  if ssh -t "mobile@$PHONE" "helper=\$(sudo find /var/containers/Bundle/Application -maxdepth 3 -name trollstorehelper | head -n 1); \
      [ -n \"\$helper\" ] || { echo 'TrollStore helper not found'; exit 1; }; \
      sudo \"\$helper\" install $REMOTE_IPA && rm -f $REMOTE_IPA"; then
    echo
    echo "Done: the new build is installed. Open Claude on the phone."
  else
    echo
    echo "Automatic install did not work. The IPA is on the phone at $REMOTE_IPA:"
    echo "open it in Filza and choose TrollStore."
  fi
}

die() { echo; echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
tree_is_clean() { git diff --quiet && git diff --cached --quiet; }

main "$@"; exit
