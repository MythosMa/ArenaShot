# ArenaShot 服务端构建脚本
#
# 注意：本机是 macOS (Darwin 25) + Go 1.22.2，
# 默认内部链接会产生缺少 LC_UUID 的 Mach-O，运行时报
# "missing LC_UUID load command" 并 abort。
# 因此统一使用外部链接模式构建。

GO      ?= go
BIN     := bin/server
CONFIG  ?= config/game.json
ADDR    ?= :8080
LDFLAGS := -linkmode=external

.PHONY: build run dev tidy test clean

build:
	$(GO) build -ldflags="$(LDFLAGS)" -o $(BIN) ./cmd/server

run: build
	./$(BIN) -config $(CONFIG) -addr $(ADDR)

# 开发时直接编译再运行（同样需要外部链接）
dev:
	$(GO) build -ldflags="$(LDFLAGS)" -o $(BIN) ./cmd/server && ./$(BIN) -config $(CONFIG) -addr $(ADDR)

tidy:
	$(GO) mod tidy

test:
	$(GO) test ./...

clean:
	rm -rf bin
