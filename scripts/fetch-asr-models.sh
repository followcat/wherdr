#!/usr/bin/env bash
# Fetch the on-device ASR model files into DATA_DIR/models/.
# Run once per deployment (files survive redeploys — the route /models/** reads
# them from disk, they are not part of the npm tarball).
#
#   DATA_DIR=~/wherdr/data scripts/fetch-asr-models.sh [model|all]
#
# Sources: the official sherpa-onnx release tarballs, except the WebGPU
# Qwen3-ASR export which is a Hugging Face repo (HF direct links are gated
# in some networks — HF_ENDPOINT selects a mirror). SenseVoice is the
# default; the rest are options — "all" fetches ~3.6 GB. Only models in
# the app's ASR_MODELS list are fetched; retired exports have no branch.
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

# The WebGPU-native Qwen3-ASR export (list #2 in Settings) is not a sherpa
# tarball — it is jiangzhuo9357/Qwen3-ASR-0.6B-ONNX on Hugging Face, layout
# v2. HF_ENDPOINT lets a mirror stand in where huggingface.co is gated.
fetch_qwen3q4f16() {
  local d=qwen3-asr-0.6b-q4f16
  if [ -s "$MODELS_DIR/$d/decoder_weights.q4f16.data" ]; then echo "have $d"; return 0; fi
  mkdir -p "$MODELS_DIR/$d"
  local hf="${HF_ENDPOINT:-https://huggingface.co}/jiangzhuo9357/Qwen3-ASR-0.6B-ONNX/resolve/main"
  local f
  for f in encoder.fp16.onnx decoder_init.q4f16.onnx decoder_step.q4f16.onnx \
           decoder_weights.q4f16.data embed_tokens.int8.bin embed_scales.f32.bin \
           prompt_config.json mel_filters.json tokenizer.json \
           tokenizer_config.json vocab.json added_tokens.json config.json; do
    dl "$hf/$f" "$MODELS_DIR/$d/$f.tmp"
    mv "$MODELS_DIR/$d/$f.tmp" "$MODELS_DIR/$d/$f"
  done
}

fetch_funasr() {
  local d=funasr-nano-int8
  if [ -s "$MODELS_DIR/$d/llm.int8.onnx" ]; then echo "have $d"; return 0; fi
  fetch_tar "$d" sherpa-onnx-funasr-nano-int8-2025-12-30 encoder_adaptor.int8.onnx llm.int8.onnx embedding.int8.onnx Qwen3-0.6B
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
  sensevoice|qwen3q4f16|funasr|firered2|omnilingual|dolphin) "fetch_$WHICH" ;;
  all) for m in sensevoice qwen3q4f16 funasr firered2 omnilingual dolphin; do "fetch_$m"; done ;;
  *) echo "usage: $0 [sensevoice|qwen3q4f16|funasr|firered2|omnilingual|dolphin|all]" >&2; exit 2 ;;
esac
