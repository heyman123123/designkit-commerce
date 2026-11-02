.PHONY: dev test build run worker fmt tidy

dev:
	cd apps/api && DB_DRIVER=sqlite AUTO_MIGRATE=true go run ./cmd/api

run: dev

worker:
	cd apps/api && DB_DRIVER=sqlite go run ./cmd/worker

test:
	cd apps/api && go test -race -count=1 ./...

build:
	cd apps/api && go build -o ../../bin/api ./cmd/api && go build -o ../../bin/worker ./cmd/worker

fmt:
	cd apps/api && gofmt -w .

tidy:
	cd apps/api && go mod tidy

up:
	docker compose up --build

down:
	docker compose down
