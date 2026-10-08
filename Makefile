.PHONY: test build check frontend

test:
	go test -race ./...
	cd web && npm test

frontend:
	cd web && npm ci && npm run build

build: frontend
	mkdir -p bin
	go build -trimpath -o bin/webzoom ./cmd/webzoom

check:
	go vet ./...
	cd web && npm run typecheck
