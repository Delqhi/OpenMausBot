#!/usr/bin/env bash
# OpenMausBot update with local patch preservation.
#
# This deployment carries TWO local commits on top of upstream main:
#   1. feat(drivers): openai-compat native tool loop + real-chrome bridge
#      (glm drives real Chrome + host desktop without codex)
#   2. fix(openai-compat): one cold-start retry on MCP tools/call timeout
#
# Update strategy: rebase those commits onto the new upstream main.
# Conflicts are expected ONLY in:
#   server/drivers/openai-compat.ts   (upstream may rewrite the chat path)
#   server/index.ts                   (upstream may move browserIntegration)
# New files (server/drivers/browser-bridge.ts, server/real-chrome-window.ts)
# survive clean unless upstream adds same-named files.
#
# Usage: bash update.sh            # interactive update
#        bash update.sh --check    # only report, change nothing
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

UPSTREAM_REMOTE="origin"          # milind-soni/OpenMausBot
FORK_REMOTE="fork"                # Delqhi/OpenMausBot — patch branch home
PATCH_BRANCH="openmausbot-real-chrome-patches"

step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
fail() { printf '\033[1;31mFEHLER: %s\033[0m\n' "$*" >&2; exit 1; }

step "1/8 Status prüfen"
[ -d .git ] || fail "nicht ein Git-Repository: $ROOT"
git diff --quiet || fail "Arbeitsverzeichnis hat uncommittete Änderungen — erst 'git stash' oder commit"
command -v pnpm >/dev/null || fail "pnpm nicht gefunden"
command -v node >/dev/null || fail "node nicht gefunden"

step "2/8 Upstream holen"
git fetch "$UPSTREAM_REMOTE" main 2>&1 | tail -1

BEHIND=$(git rev-list --count HEAD.."$(git rev-parse "$UPSTREAM_REMOTE/main")")
if [ "$BEHIND" = "0" ] && [ "${1:-}" != "--force" ]; then
  echo "Bereits aktuell (0 neue Upstream-Commits). Nichts zu tun."
  exit 0
fi
echo "$BEHIND neue Upstream-Commits"

if [ "${1:-}" = "--check" ]; then
  echo "--check: keine Änderungen vorgenommen. Nächste Schritte manuell:"
  echo "  git rebase $UPSTREAM_REMOTE/main   # Konflikte in openai-compat.ts / index.ts auflösen"
  echo "  pnpm install && bash scripts/prepare-cua.mjs && launchctl kickstart -k gui/\$(id -u)/com.openmausbot.harness"
  exit 0
fi

step "3/8 Rebase auf neuen Upstand-main"
if ! git rebase "$UPSTREAM_REMOTE/main"; then
  echo ""
  fail "Rebase-Konflikt. Auflösen: git status → Dateien fixen (unsere Marker: browser-bridge.ts Einbindung, real-chrome-window.ts Hook, openai-compat Tool-Loop) → git add … → git rebase --continue. Abbruch: git rebase --abort"
fi

step "4/8 Patch-Branch auf den Fork spiegeln"
git push -f "$FORK_REMOTE" "HEAD:$PATCH_BRANCH" 2>&1 | tail -1 || echo "(fork push fehlgeschlagen — patch-branch ist nicht kritisch für den Betrieb)"

step "5/8 Dependencies"
pnpm install 2>&1 | tail -2

step "6/8 CUA-Driver restagen (Version kann sich ändern)"
node scripts/prepare-cua.mjs 2>&1 | tail -1 || echo "(prepare-cua fehlgeschlagen — Host-Control braucht ggf. das neue Binary, siehe scripts/prepare-cua.mjs)"

step "7/8 Smoke: Module laden + Syntax"
node --experimental-strip-types --check server/index.ts
node --experimental-strip-types --check server/drivers/browser-bridge.ts
node --experimental-strip-types --check server/real-chrome-window.ts

step "8/8 Harness neu starten"
launchctl kickstart -k gui/$(id -u)/com.openmausbot.harness 2>/dev/null || true
sleep 6
curl -s -m 5 -o /dev/null http://127.0.0.1:8799/api/bots && echo "harness up ✓" || {
  echo "harness antwortet nicht — Logs: ~/.openmausbot/logs/harness.err.log"
  exit 1
}

echo ""
echo "FERTIG. Smoke-Tests: ~/.local/share/sin-runtime/openmausbot/verify-gates.sh G1/G2/G5"
echo "Browser-/Host-Control-Turn im UI gegen den Bot 'GLM Chrome' fahren."
