# wash: wash-web (container), washd (user shell manager), wash (CLI).
LDFLAGS := -s -w
GO ?= go
IMAGE ?= localhost/wash-web:latest
PODMAN ?= podman
PORT ?= 8443

all: bin/wash bin/washd bin/wash-web

bin/%: FORCE
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o $@ ./cmd/$*

test:
	$(GO) test ./...
	node --test web/test/term/*.test.mjs web/test/wash/*.test.mjs web/test/wosh/*.test.mjs

# Image from the locally built static binary (no base image to pull).
image: bin/wash-web
	$(PODMAN) build -t $(IMAGE) -f Containerfile .

# Local test of the production quadlet as the current user (deploy/README.md).
run:
	deploy/dev.sh install
	deploy/dev.sh start

# Install the user side (CLI + manager) into ~/.local/bin.
install: bin/wash bin/washd
	install -Dm755 bin/wash $(HOME)/.local/bin/wash
	install -Dm755 bin/washd $(HOME)/.local/bin/washd

clean:
	rm -rf bin

.PHONY: all test image run install clean FORCE
