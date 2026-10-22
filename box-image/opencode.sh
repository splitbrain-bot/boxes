#!/bin/sh
# Starts the opencode build that fits the CPU of the host. On x86_64, the
# default build needs AVX2, and the baseline build runs on every CPU. The check
# runs at each start, because the image can run on a host that differs from
# the build host.
set -eu

builds=/usr/local/lib/node_modules/opencode-ai/node_modules

case "$(uname -m)" in
  x86_64)
    if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
      build=opencode-linux-x64
    else
      build=opencode-linux-x64-baseline
    fi
    ;;
  aarch64) build=opencode-linux-arm64 ;;
  *)
    echo "opencode: no build for $(uname -m)" >&2
    exit 1
    ;;
esac

exec "$builds/$build/bin/opencode" "$@"
