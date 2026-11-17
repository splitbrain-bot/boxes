#!/bin/sh
# Starts the opencode build that fits the CPU of the host. On x86_64, the
# default build needs AVX2, and the baseline build runs on every CPU. The check
# runs at each start, because the image can run on a host that differs from
# the build host.
set -eu

builds=/usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode

case "$(uname -m)" in
  x86_64)
    if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
      build=cli-linux-x64
    else
      build=cli-linux-x64-baseline
    fi
    ;;
  aarch64) build=cli-linux-arm64 ;;
  *)
    echo "opencode: no build for $(uname -m)" >&2
    exit 1
    ;;
esac

exec "$builds/$build/bin/opencode" "$@"
