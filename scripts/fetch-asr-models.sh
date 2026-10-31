#!/usr/bin/env bash
# Fetch the on-device ASR model files into DATA_DIR/models/.
# Run once per deployment (files survive redeploys — the route /models/** reads
# them from disk, they are not part of the npm tarball).
#
#   DATA_DIR=/home/followcat/wherdr/data scripts/fetch-asr-models.sh [model|all]
#
# Sources: the official sherpa-onnx release tarballs (HF direct links are
# gated in some networks). SenseVoice is the default; the rest are options —
# "all" fetches ~2.9 GB.
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

fetch_tar() { # fetch_tar <dir> <tarball-name> <members...> — extract members strip-components=1
  local dest="$MODELS_DIR/$1" tar="$2"; shift 2
  mkdir -p "$dest"
  dl "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${tar}.tar.bz2" "$dest/${tar}.tar.bz2.tmp"
  mv "$dest/${tar}.tar.bz2.tmp" "$dest/${tar}.tar.bz2"
  local members=(); for f in "$@"; do members+=("${tar}/${f}"); done
  tar -xjf "$dest/${tar}.tar.bz2" -C "$dest" --strip-components=1 "${members[@]}"
  rm -f "$dest/${tar}.tar.bz2"
}

fetch_sensevoice() {
  local d=sensevoice-zh-en-ja-ko-yue-2025-09
  if [ -s "$MODELS_DIR/$d/model.int8.onnx" ]; then echo "have $d"; return 0; fi
  fetch_tar "$d" sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09 model.int8.onnx tokens.txt
}

fetch_qwen3() {
  local d=qwen3-asr-0.6b-int8
  if [ -s "$MODELS_DIR/$d/decoder.int8.onnx" ]; then echo "have $d"; return 0; fi
  fetch_tar "$d" sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25 conv_frontend.onnx encoder.int8.onnx decoder.int8.onnx tokenizer
}

fetch_funasr() {
  local d=funasr-nano-int8
  if [ -s "$MODELS_DIR/$d/llm.int8.onnx" ]; then echo "have $d"; return 0; fi
  fetch_tar "$d" sherpa-onnx-funasr-nano-int8-2025-12-30 encoder_adaptor.int8.onnx llm.int8.onnx embedding.int8.onnx Qwen3-0.6B
}

fetch_wsyue() {
  local d=wenetspeech-yue-u2pp-int8
  if [ -s "$MODELS_DIR/$d/model.int8.onnx" ]; then echo "have $d"; return 0; fi
  fetch_tar "$d" sherpa-onnx-wenetspeech-yue-u2pp-conformer-ctc-zh-en-cantonese-int8-2025-09-10 model.int8.onnx tokens.txt
}

fetch_firered2() {
  local d=fire-red-asr2-ctc-int8
  if [ -s "$MODELS_DIR/$d/model.int8.onnx" ]; then echo "have $d"; return 0; fi
  fetch_tar "$d" sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25 model.int8.onnx tokens.txt
}

fetch_omnilingual() {
  local d=omnilingual-300m-ctc-int8
  if [ -s "$MODELS_DIR/$d/model.int8.onnx" ]; then echo "have $d"; return 0; fi
  fetch_tar "$d" sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-int8-2025-11-12 model.int8.onnx tokens.txt
}

fetch_dolphin() {
  local d=dolphin-base-ctc-int8
  if [ -s "$MODELS_DIR/$d/model.int8.onnx" ]; then echo "have $d"; return 0; fi
  fetch_tar "$d" sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02 model.int8.onnx tokens.txt
}

case "$WHICH" in
  sensevoice|qwen3|funasr|wsyue|firered2|omnilingual|dolphin) "fetch_$WHICH" ;;
  all) for m in sensevoice qwen3 funasr wsyue firered2 omnilingual dolphin; do "fetch_$m"; done ;;
  *) echo "usage: $0 [sensevoice|qwen3|funasr|wsyue|firered2|omnilingual|dolphin|all]" >&2; exit 2 ;;
esac
