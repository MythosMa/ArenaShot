# ArenaShot 服务端

Go 实现的权威游戏服务端：HTTP 接口 + WebSocket 长连接 + 房间固定 Tick 循环。

## 环境要求

- Go 1.22+
- 依赖：Gin（HTTP）、gorilla/websocket（长连接，P2 接入）

## 快速开始

```bash
cd server
make run          # 编译并启动，默认 :8080
curl http://localhost:8080/api/health
```

或手动：

```bash
go build -ldflags="-linkmode=external" -o bin/server ./cmd/server
./bin/server -config config/game.json -addr :8080
```

### macOS 上的链接说明

本机 macOS（Darwin 25）+ Go 1.22.2 默认内部链接生成的二进制会报：

```
dyld: missing LC_UUID load command
signal: abort trap
```

因此 **所有构建都必须加 `-linkmode=external`**，Makefile 已固化该参数。
`go run` 同样会失败，请使用 `make run` 或先编译再执行。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查：状态、版本、tickRate |
| GET | `/api/config` | 下发完整游戏配置（客户端也可静态加载同一份） |

## 目录

```
cmd/server/         入口：装配配置、HTTP、未来的 WS 网关与房间
internal/config/    配置结构体与加载校验
internal/protocol/  消息定义、封套、JSON 编解码（可替换 Protobuf）
config/game.json    与服务端客户端共用的数值配置
```

## 当前进度

- [x] P0：配置加载、HTTP 健康检查/配置接口、优雅退出
- [ ] P2：WebSocket 网关、会话、房间 Tick 循环
- [ ] P3：战斗模拟、快照广播、事件
- [ ] P4：重连、观战排队

详细设计见仓库根目录 `01-技术架构设计.md`。
