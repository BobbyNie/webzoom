#!/usr/bin/env bash
# CI runs on Linux AMD64. Verify the pinned binary before execution.
set -euo pipefail
version=0.75.0
checksum=c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f
mkdir -p "$1"
cd "$1"
archive="trivy_${version}_Linux-64bit.tar.gz"
curl --fail --location --silent --show-error --retry 3 \
  "https://github.com/aquasecurity/trivy/releases/download/v${version}/${archive}" -o "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check -
tar -xzf "$archive" trivy
./trivy --version
