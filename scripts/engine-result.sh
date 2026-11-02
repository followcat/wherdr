#!/bin/sh
set -eu
[ "$CHANGES" = success ] || exit 1
case "$NEEDED:$ENGINE" in
  false:skipped) echo "No engine input changed." ;;
  true:success) echo "Every engine check passed." ;;
  *) echo "Engine checks did not pass: needed=$NEEDED, result=$ENGINE"; exit 1 ;;
esac
