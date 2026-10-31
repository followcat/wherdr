#!/usr/bin/env bash
# Fetch the on-device ASR model files into DATA_DIR/models/.
# Run once per deployment (files survive redeploys — the route /models/** reads
# them from disk, they are not part of the npm tarball).
#
#   DATA_DIR=/home/followcat/wherdr/data scripts/fetch-asr-models.sh
#
# Sources: the official sherpa-onnx release tarballs (HF direct links are
# gated in some networks). SenseVoice is the default; Qwen3-ASR is the heavy
# high-accuracy option — pass "qwen3" or "all" to fetch it too (~1 GB).
set -euo pipefail

WHICH="${1:-sensevoice}"
MODELS_DIR="${DATA_DIR:-$(pwd)/data}/models"

dl() { # dl <url> <dest>
  local url="$1" tmp="$2"
  echo "fetch $url"
  # -C - resumes a .tmp; --retry alone would restart from zero.
  for try in 1 2 3 4 5; do
    curl -fL -C - --retry 3 -o "$tmp" "$url" && return 0
    echo "retry $try"; sleep 2
  done
  echo "FAILED download $url" >&2; return 1
}

fetch_sensevoice() {
  local dest="$MODELS_DIR/sensevoice-zh-en-ja-ko-yue"
  local tar="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
  mkdir -p "$dest"
  if [ -s "$dest/model.int8.onnx" ] && [ -s "$dest/tokens.txt" ]; then
    echo "have model files -> $dest"; return 0
  fi
  dl "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${tar}.tar.bz2" "$dest/${tar}.tar.bz2.tmp"
  mv "$dest/${tar}.tar.bz2.tmp" "$dest/${tar}.tar.bz2"
  tar -xjf "$dest/${tar}.tar.bz2" -C "$dest" --strip-components=1 \
    "${tar}/model.int8.onnx" "${tar}/tokens.txt"
  rm -f "$dest/${tar}.tar.bz2"
  [ -s "$dest/model.int8.onnx" ] && [ -s "$dest/tokens.txt" ] \
    && echo "done -> $dest" || { echo "FAILED extract" >&2; return 1; }
}

fetch_qwen3() {
  local dest="$MODELS_DIR/qwen3-asr-0.6b-int8"
  local tar="sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25"
  mkdir -p "$dest"
  if [ -s "$dest/decoder.int8.onnx" ] && [ -s "$dest/tokenizer/vocab.json" ]; then
    echo "have model files -> $dest"; return 0
  fi
  dl "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${tar}.tar.bz2" "$dest/${tar}.tar.bz2.tmp"
  mv "$dest/${tar}.tar.bz2.tmp" "$dest/${tar}.tar.bz2"
  tar -xjf "$dest/${tar}.tar.bz2" -C "$dest" --strip-components=1 \
    "${tar}/conv_frontend.onnx" "${tar}/encoder.int8.onnx" "${tar}/decoder.int8.onnx" "${tar}/tokenizer"
  rm -f "$dest/${tar}.tar.bz2"
  [ -s "$dest/decoder.int8.onnx" ] && [ -s "$dest/tokenizer/vocab.json" ] \
    && echo "done -> $dest" || { echo "FAILED extract" >&2; return 1; }
}

case "$WHICH" in
  sensevoice) fetch_sensevoice ;;
  qwen3) fetch_qwen3 ;;
  all) fetch_sensevoice; fetch_qwen3 ;;
  *) echo "usage: $0 [sensevoice|qwen3|all]" >&2; exit 2 ;;
esac
