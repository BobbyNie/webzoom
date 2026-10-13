# syntax=docker/dockerfile:1
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS frontend
RUN apk add --no-cache 'zlib>=1.3.2-r1' && npm install --global npm@12.2.0 && npm cache clean --force
# Replace bundled npm dependencies with the audited, integrity-locked upstream packages.
COPY .github/security/npm/package.json .github/security/npm/package-lock.json /usr/local/lib/node_modules/npm/
RUN npm ci --prefix /usr/local/lib/node_modules/npm --ignore-scripts && npm cache clean --force
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm test && npm run build

FROM golang:1.26.9-alpine@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS backend
RUN apk add --no-cache 'zlib>=1.3.2-r1'
ENV CGO_ENABLED=0
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
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["/app/webzoom"]
