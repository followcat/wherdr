#!/usr/bin/env bash
# Fetch the on-device ASR model files into DATA_DIR/models/.
# Run once per deployment (files survive redeploys — the route /models/** reads
# them from disk, they are not part of the npm tarball).
#
#   DATA_DIR=/home/followcat/wherdr/data scripts/fetch-asr-models.sh
set -euo pipefail

DEST="${DATA_DIR:-$(pwd)/data}/models/asr-zipformer-zh-en"
REPO="pkufool/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
BASE="https://modelscope.cn/api/v1/models/${REPO}/repo?FilePath="

mkdir -p "$DEST"
dl() { # $1 remote name, $2 local name
  if [ -s "$DEST/$2" ]; then echo "have $2"; return; fi
  echo "fetch $1 -> $2"
  curl -fL --retry 3 -o "$DEST/$2.tmp" "${BASE}$1" && mv "$DEST/$2.tmp" "$DEST/$2"
}
dl "encoder-epoch-99-avg-1.int8.onnx"  "encoder.int8.onnx"
dl "decoder-epoch-99-avg-1.int8.onnx"  "decoder.int8.onnx"
dl "joiner-epoch-99-avg-1.int8.onnx"   "joiner.int8.onnx"
dl "tokens.txt"                        "tokens.txt"
echo "done -> $DEST"
