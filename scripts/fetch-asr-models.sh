#!/usr/bin/env bash
# Fetch the on-device ASR model files into DATA_DIR/models/.
# Run once per deployment (files survive redeploys — the route /models/** reads
# them from disk, they are not part of the npm tarball).
#
#   DATA_DIR=/home/followcat/wherdr/data scripts/fetch-asr-models.sh
#
# Source: the official sherpa-onnx release tarball (HF direct links are gated
# in some networks). Extracts model.int8.onnx + tokens.txt only.
set -euo pipefail

DEST="${DATA_DIR:-$(pwd)/data}/models/sensevoice-zh-en-ja-ko-yue"
TARBALL="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${TARBALL}.tar.bz2"

mkdir -p "$DEST"
if [ -s "$DEST/model.int8.onnx" ] && [ -s "$DEST/tokens.txt" ]; then
  echo "have model files -> $DEST"; exit 0
fi

TMP="$DEST/${TARBALL}.tar.bz2.tmp"
echo "fetch $URL"
# -C - resumes the .tmp; --retry alone would restart from zero.
for try in 1 2 3 4 5; do
  curl -fL -C - --retry 3 -o "$TMP" "$URL" && break
  echo "retry $try"; sleep 2
done
[ -s "$TMP" ] || { echo "FAILED download" >&2; exit 1; }

mv "$TMP" "$DEST/${TARBALL}.tar.bz2"
tar -xjf "$DEST/${TARBALL}.tar.bz2" -C "$DEST" --strip-components=1 \
  "${TARBALL}/model.int8.onnx" "${TARBALL}/tokens.txt"
rm -f "$DEST/${TARBALL}.tar.bz2"

[ -s "$DEST/model.int8.onnx" ] && [ -s "$DEST/tokens.txt" ] \
  && echo "done -> $DEST" || { echo "FAILED extract" >&2; exit 1; }
