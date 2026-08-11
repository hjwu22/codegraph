#!/usr/bin/env bash
# Keep AOSP's own code-search tooling out of BOTH eval arms. Companion to
# no-cli-shim.sh; source it after that one.
#
#   . "$HARNESS/no-cli-shim.sh"
#   . "$HARNESS/aosp-env-shim.sh"
#   cg_no_cli_setup "$OUT"        # -> $ARM_PATH, $ARM_SETTINGS
#   aosp_no_env_setup "$OUT"      # -> extends $ARM_SETTINGS
#   PATH="$ARM_PATH" claude … --settings "$ARM_SETTINGS"
#
# Why this exists
#
# `source build/envsetup.sh` defines a set of shell FUNCTIONS that are grep
# specialised for an AOSP tree — mgrep/jgrep/cgrep/sgrep/resgrep/sepgrep search
# only the relevant file types, and godir jumps by filename. `repo grep` fans a
# search across the 1000+ projects in parallel. None of them are binaries on
# PATH, so no-cli-shim.sh's PATH substitution cannot see them.
#
# They break the A/B in BOTH directions:
#
#   without-arm has them   The baseline is no longer "plain grep over 846k
#   files" but a tool tuned for exactly this tree, which UNDERSTATES codegraph.
#
#   only one arm has them  Whichever arm sourced envsetup is measuring a
#   different search substrate, so the delta is not attributable to codegraph.
#
# Because they are functions, the guard is a PreToolUse hook on the invocation
# (and on sourcing envsetup at all) rather than a PATH edit.
#
# `atest` deserves its own mention: it answers "which tests cover this module"
# directly from module-info, which is the same question one of the canonical
# AOSP flows asks. Leaving it available lets the without-arm answer that flow
# with a single command that has nothing to do with grep OR codegraph.
#
# m/mm/mmm/mma/lunch are blocked too. They would fail without a configured
# build env anyway, and an agent that manages to start a real AOSP build inside
# an eval run costs hours of wall clock.
#
# Prevention is best-effort, same as the CLI shim: report the counter, do not
# trust the block. Any Bash command naming these tools should be counted and
# surfaced next to the CLI-contamination row.

# Command-position match only: `grep mgrep notes.txt` is looking, not using.
AOSP_CMD_RE='(^|[;&|(]|&&|\|\||\$\(|`)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*(mgrep|jgrep|cgrep|sgrep|resgrep|sepgrep|rsgrep|ktgrep|treegrep|godir|croot|atest|aidegen|lunch|m|mm|mmm|mma|mmma|refreshmod|allmod|gomod|pathmod|outmod|installmod)([[:space:]]|$)'
# `source build/envsetup.sh` / `. build/envsetup.sh` in any form.
AOSP_ENVSETUP_RE='(^|[;&|(]|&&|\|\||\$\(|`)[[:space:]]*(source|\.)[[:space:]]+[^[:space:];&|]*envsetup\.sh'
# `repo grep` / `repo forall` fan a search across every project in the manifest.
AOSP_REPO_RE='(^|[;&|(]|&&|\|\||\$\(|`)[[:space:]]*repo[[:space:]]+(grep|forall)([[:space:]]|$)'

aosp_no_env_setup() {
  local out="${1:?aosp_no_env_setup <out-dir>}"
  command -v jq >/dev/null || { echo "jq is required for the AOSP env hook — install it or the arms will be contaminated"; return 1; }

  cat > "$out/aosp-env-hook.sh" <<HOOK
#!/usr/bin/env bash
# Deny AOSP envsetup search/build tooling so both arms search the same way.
set -uo pipefail
cmd="\$(cat | jq -r '.tool_input.command // empty' 2>/dev/null)"
if printf '%s' "\$cmd" | grep -Eq '$AOSP_CMD_RE|$AOSP_ENVSETUP_RE|$AOSP_REPO_RE'; then
  msg="AOSP build/search tooling (envsetup.sh helpers, repo grep, atest, m/mm) is not available in this session. Use the tools you have."
  jq -n --arg m "\$msg" '{reason:\$m, hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:\$m}}'
fi
exit 0
HOOK
  chmod +x "$out/aosp-env-hook.sh"

  # Compose with whatever no-cli-shim.sh already wrote, rather than replacing it.
  local settings="${ARM_SETTINGS:-$out/hook-settings.json}"
  local merged="$out/hook-settings-aosp.json"
  if [ -f "$settings" ]; then
    jq --arg c "bash $out/aosp-env-hook.sh" \
      '.hooks.PreToolUse[0].hooks += [{type:"command", command:$c}]' "$settings" > "$merged" || return 1
  else
    jq -n --arg c "bash $out/aosp-env-hook.sh" \
      '{hooks:{PreToolUse:[{matcher:"Bash", hooks:[{type:"command", command:$c}]}]}}' > "$merged" || return 1
  fi
  ARM_SETTINGS="$merged"

  # Prove the hook denies real invocations and lets mere mentions through.
  aosp_probe() { printf '{"tool_input":{"command":%s}}' "$2" | bash "$1/aosp-env-hook.sh" | grep -c deny; }
  [ "$(aosp_probe "$out" '"mgrep IVibrator"')" = 1 ]                        || { echo "hook fails to block mgrep"; return 1; }
  [ "$(aosp_probe "$out" '"source build/envsetup.sh && lunch aosp_arm64"')" = 1 ] || { echo "hook fails to block envsetup"; return 1; }
  [ "$(aosp_probe "$out" '"repo grep -n IVibrator"')" = 1 ]                 || { echo "hook fails to block repo grep"; return 1; }
  [ "$(aosp_probe "$out" '"atest VtsHalVibratorTargetTest"')" = 1 ]         || { echo "hook fails to block atest"; return 1; }
  [ "$(aosp_probe "$out" '"grep -rn IVibrator hardware/"')" = 0 ]           || { echo "hook over-blocks plain grep"; return 1; }
  [ "$(aosp_probe "$out" '"cat notes-about-mgrep.txt"')" = 0 ]              || { echo "hook over-blocks a mere mention"; return 1; }
  [ "$(aosp_probe "$out" '"ls modules/"')" = 0 ]                            || { echo "hook over-blocks an unrelated command"; return 1; }
  return 0
}
