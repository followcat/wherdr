#!/bin/sh
# Build canto-hk-g2p 2.6.1 for wasm32-unknown-unknown and generate the
# wasm-bindgen glue used by public/workers/canto-tts-worker.js.
#
# The crate comes from the pinned PyPI sdist, not from a git checkout. The
# patch fixes wasm-bindgen to 0.2.130, makes the native-only dependencies
# target-specific, and adds Dict::from_bytes + the WasmPipeline wrapper.
#
#   CANTO_G2P_SDIST=/path/to/canto_hk_g2p-2.6.1.tar.gz
#   WASM_BINDGEN=/path/to/wasm-bindgen-0.2.130 ./scripts/build-canto-g2p-wasm.sh
#
# The outputs are committed as code; the data (.bin files) is a fetch set.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SRC=${CANTO_G2P_SDIST:-$ROOT/../canto-assets/ref/sdist-2.6.1/canto_hk_g2p-2.6.1.tar.gz}
BINDGEN=${WASM_BINDGEN:-wasm-bindgen}
OUT=$ROOT/public/workers/canto
WORK=${TMPDIR:-/tmp}/canto-g2p-wasm-build

rm -rf "$WORK"
mkdir -p "$WORK"
tar -xzf "$SRC" -C "$WORK"
cd "$WORK/canto_hk_g2p-2.6.1"
patch -p1 < "$ROOT/scripts/canto-g2p-wasm.patch"

cargo build --target wasm32-unknown-unknown --release --locked \
  --no-default-features --features wasm

rm -rf "$OUT"
mkdir -p "$OUT"
"$BINDGEN" --target no-modules --out-dir "$OUT" \
  target/wasm32-unknown-unknown/release/canto_g2p.wasm
rm -f "$OUT"/*.d.ts

echo "built $OUT/canto_g2p.js and $OUT/canto_g2p_bg.wasm"
sha256sum "$OUT/canto_g2p.js" "$OUT/canto_g2p_bg.wasm"
wc -c "$OUT/canto_g2p.js" "$OUT/canto_g2p_bg.wasm"
