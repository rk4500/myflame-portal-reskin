#!/usr/bin/env bash
# Native-autobook test build: apktool touches only the manifest
# (decompiled-native-test/, a copy of decompiled-persistent with
# AutobookReceiver + alarm permissions added to AndroidManifest.xml — see
# HANDOFF.md, "Native background autobook"). The compiled receiver itself
# is never decompiled to smali; it's merged in afterward as its own
# classes5.dex at the zip level, sidestepping baksmali entirely (no
# maintained prebuilt jar was findable for it — see HANDOFF trap list).
set -euo pipefail
cd "$(dirname "$0")"

DECOMPILED=decompiled-native-test
OUT=flame-native-test.apk
KEYSTORE="venv/lib/python3.14/site-packages/objection/utils/assets/objection.jks"

export PATH="$PWD/build-tools/android-14:$PWD/venv/bin:$PATH"
export JAVA_TOOL_OPTIONS="-Xmx6g"

cp hook.compiled.js "$DECOMPILED/lib/arm64-v8a/libfrida-gadget.script.so"

rm -f rebuilt.apk rebuilt.withdex.apk rebuilt.aligned.apk
apktool build "$DECOMPILED" -j 1 -o rebuilt.apk

cp rebuilt.apk rebuilt.withdex.apk
zip -j rebuilt.withdex.apk native-out/classes5.dex

zipalign -p 4 rebuilt.withdex.apk rebuilt.aligned.apk
apksigner sign --ks "$KEYSTORE" --ks-pass pass:basil-joule-bug --ks-key-alias objection rebuilt.aligned.apk

mv rebuilt.aligned.apk "$OUT"
[ -f rebuilt.aligned.apk.idsig ] && mv rebuilt.aligned.apk.idsig "$OUT.idsig"
rm -f rebuilt.apk rebuilt.withdex.apk
echo "native-test-build done: $OUT"
