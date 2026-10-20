#!/usr/bin/env bash
# Phase 06 convergence — superseded by the live acceptance harness.
#
# The old script established goals by writing controller rows directly and then
# sent the model its own prompt. That proves the model can do a task; it does
# not prove the plugin drives one. The acceptance gate is stricter:
#
#   set a goal once, then do not prompt the model again.
#
# `scripts/parity.sh` exercises that through the public session API and server
# RPC, including post-completion goals and generation-checked replacement.
#
# Kept as a stable entry point for existing callers.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bash "$ROOT/scripts/parity.sh" "$@"
