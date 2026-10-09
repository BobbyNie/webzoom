# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS frontend
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm test && npm run build

FROM golang:1.26.9-bookworm@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/webzoom/ ./cmd/webzoom/
COPY internal/ ./internal/
RUN go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /webzoom ./cmd/webzoom

FROM scratch
COPY --from=backend /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=backend --chmod=0555 /webzoom /app/webzoom
COPY --from=frontend /src/web/dist /app/web
ENV LISTEN_ADDR=:8080 STATIC_DIR=/app/web
USER 65532:65532
COPY LICENSE THIRD_PARTY_NOTICES.md /app/licenses/
COPY licenses/ /app/licenses/
COPY --from=backend /usr/share/doc/ca-certificates/copyright /app/licenses/ca-certificates.txt
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["/app/webzoom"]
