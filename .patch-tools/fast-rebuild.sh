#!/usr/bin/env bash
# Fast-path rebuild: swaps the compiled hook script into the *already
# decompiled and injected* persistent directory (decompiled-persistent/,
# a one-time `objection patchapk -k` output moved here — see HANDOFF)
# and only re-runs apktool build + zipalign + sign, skipping apktool's
# decompile step entirely. Only valid as long as flame-merged.apk (the
# base) hasn't changed — if it has, decompiled-persistent/ is stale and
# must be regenerated via a normal `objection patchapk -k` run.
#
# Commands and the keystore/pass/alias below are copied verbatim from
# objection's own utils/patchers/android.py (build_apk/zipalign_apk/
# sign_apk) so the output matches what objection would have produced.
set -euo pipefail
cd "$(dirname "$0")"

DECOMPILED=decompiled-persistent
OUT=flame-merged.objection.apk
KEYSTORE="venv/lib/python3.14/site-packages/objection/utils/assets/objection.jks"

export PATH="$PWD/build-tools/android-14:$PWD/venv/bin:$PATH"
export JAVA_TOOL_OPTIONS="-Xmx6g"

cp hook.compiled.js "$DECOMPILED/lib/arm64-v8a/libfrida-gadget.script.so"

rm -f rebuilt.apk rebuilt.aligned.apk
apktool build "$DECOMPILED" -j 1 -o rebuilt.apk
zipalign -p 4 rebuilt.apk rebuilt.aligned.apk
apksigner sign --ks "$KEYSTORE" --ks-pass pass:basil-joule-bug --ks-key-alias objection rebuilt.aligned.apk

mv rebuilt.aligned.apk "$OUT"
[ -f rebuilt.aligned.apk.idsig ] && mv rebuilt.aligned.apk.idsig "$OUT.idsig"
rm -f rebuilt.apk
echo "fast-rebuild done: $OUT"
