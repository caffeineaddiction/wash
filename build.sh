#!/bin/sh
# Same targets as the Makefile, for hosts without make.
#   ./build.sh [all|test|image|run|install]  (run = deploy/dev.sh)
set -eu
cd "$(dirname "$0")"
GO=${GO:-go}
IMAGE=${IMAGE:-localhost/wash-web:latest}
PORT=${PORT:-8443}
bins() {
	for b in wash washd wash-web; do
		CGO_ENABLED=0 $GO build -trimpath -ldflags="-s -w" -o bin/$b ./cmd/$b
	done
}
case "${1:-all}" in
all) bins ;;
test) $GO test ./... && node --test web/test/term/*.test.mjs web/test/wash/*.test.mjs web/test/wosh/*.test.mjs ;;
image) bins && podman build -t "$IMAGE" -f Containerfile . ;;
run) exec deploy/dev.sh "${2:-start}" ;;  # local test = the real quadlet, see deploy/README.md
install)
	bins
	install -Dm755 bin/wash "$HOME/.local/bin/wash"
	install -Dm755 bin/washd "$HOME/.local/bin/washd" ;;
*) echo "usage: $0 [all|test|image|run|install]  (run = deploy/dev.sh)" >&2; exit 2 ;;
esac
