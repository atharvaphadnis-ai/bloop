FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
# go.sum is generated on first build inside this container:
RUN go mod download github.com/dgraph-io/badger/v4 || true
COPY main.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -o /badger-sidecar .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates wget
COPY --from=build /badger-sidecar /badger-sidecar
VOLUME /data/badger
ENV BADGER_DATA_DIR=/data/badger BADGER_PORT=8089
EXPOSE 8089
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://localhost:8089/health || exit 1
ENTRYPOINT ["/badger-sidecar"]
