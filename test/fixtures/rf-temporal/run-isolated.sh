#!/bin/sh
# Runs the given `robot` invocation with a BRAND NEW --outputdir every single
# time this script is invoked, then deletes it. test/rf-temporal-e2e.test.js
# reuses one command string for several back-to-back robot invocations (a
# control round plus one round per delay); reusing a single fixed --outputdir
# across those was an observed source of a spurious "invalid data" exit (252)
# from Robot Framework when this test ran alongside the rest of the suite's
# many other real-browser tests under heavy system load. A fresh directory
# per invocation removes any chance of that cross-invocation contention.
#
# Usage: run-isolated.sh <robot-binary> <listener.py> <suite.robot>
set -u
robot_bin="$1"
listener="$2"
suite="$3"

outdir=$(mktemp -d)
"$robot_bin" --listener "$listener" --outputdir "$outdir" "$suite"
code=$?
rm -rf "$outdir"
exit $code
