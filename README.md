# ArenaShot

2D 俯视角多人实时射击对战 Demo。

客户端使用 Cocos Creator 3.8.8 + TypeScript，服务端使用 Go。网络模型为**服务器权威的状态同步**：客户端只上报操作意图，位置、命中、伤害与胜负全部由服务端计算。

## 功能

- 最多 4 人同房间混战，满员后进入观战队列，空位按顺序补位
- 20Hz 固定 Tick 模拟与全量快照广播
- 可破坏障碍（定时恢复）、随机刷新道具（治疗 / 威力 / 移速）
- 击杀 / 死亡统计与实时排行榜
- 断线重连（超时后释放位置）
- 协议层可替换：当前 JSON，预留 Protobuf 接口

> 当前进度：P1 单机战斗、P2 网关/会话/20Hz 房间循环、P3 战斗闭环、P4 断线重连与网络体验优化
> 均已完成并通过验收（Go 单测 + 四组 WebSocket 端到端冒烟）。P5 打磨与作品集进行中：
> 生产环境日志降级、WSS 同源连接、Nginx/systemd 部署配置已完成，角色程序化动效已加入。

## 架构

```
浏览器（Cocos web）                    服务器
┌──────────────────────────┐      ┌────────────────────────────┐
│ 输入采集 20Hz             │      │ Nginx：静态站点 + /ws 反代   │
│      ↓                   │      │      ↓ 127.0.0.1:8080       │
│ NetClient ──── WSS ──────┼─────▶│ Gateway → Session → Room    │
│      ↑                   │      │              │ 20Hz tick    │
│ 快照/事件                 │      │           World（权威模拟）  │
│      ↓                   │      │              ↓               │
│ GameState → 视图插值      │      │        全量快照广播           │
└──────────────────────────┘      └────────────────────────────┘
```

数据流：客户端只上报操作意图 → 服务端在固定 Tick 内计算移动、碰撞、命中、伤害与胜负 →
广播全量快照 → 客户端插值渲染。断线期间服务端保留离线实体 15s，客户端带 `sessionId`
自动重连；超时释放位置并由观战队列补位。

## 技术栈

| 模块 | 技术 |
| --- | --- |
| 客户端 | Cocos Creator 3.8.8、TypeScript |
| 服务端 | Go 1.22、Gin、gorilla/websocket |
| 通信 | WebSocket + JSON 统一封套 |
| 同步 | 服务器权威状态同步、快照广播 |
| 部署 | Nginx 静态资源 + WSS 反向代理 |

## 目录结构

```
ArenaShot/
├── client/                 Cocos Creator 客户端
│   └── assets/
│       ├── scripts/
│       │   ├── core/       事件总线、日志、对象池
│       │   ├── config/     配置加载
│       │   ├── net/        协议类型与编解码
│       │   ├── game/       数据中心、实体视图、输入、世界控制
│       │   └── ui/         HUD、击杀播报、提示、登录
│       └── resources/config/game.json
├── server/                 Go 服务端
│   ├── cmd/server/         入口
│   ├── internal/
│   │   ├── config/         配置加载与校验
│   │   ├── protocol/       消息定义与编解码
│   │   ├── session/        会话与身份
│   │   ├── gateway/        WebSocket 接入
│   │   └── game/           房间循环与世界模拟
│   └── config/game.json    客户端与服务端共用的数值配置
├── scripts/                配置同步、类型检查脚本
├── deploy/                 Nginx 站点配置、systemd 单元、部署指南
└── 01-技术架构设计.md       架构与同步设计说明
```

## 快速开始

服务端：

```bash
cd server
make run
# 默认监听 :8080
curl http://localhost:8080/api/health
```

客户端：

用 Cocos Creator 3.8.8 打开 `client/` 目录运行。数值配置以 `server/config/game.json` 为唯一来源，修改后执行：

```bash
bash scripts/sync-config.sh
```

## 部署

```bash
cd server
make test                                 # 单测
make build                                # 构建二进制
# 交叉编译、Nginx/WSS、systemd、静态资源发布见 deploy/README.md
```

## 文档

- [01-技术架构设计.md](01-技术架构设计.md)：架构与同步设计说明
- [deploy/README.md](deploy/README.md)：生产部署步骤与常见坑
