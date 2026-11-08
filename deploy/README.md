# ArenaShot 部署指南

目标拓扑：

```
浏览器 ──HTTPS/WSS──> Nginx ──静态文件──> /var/www/arenashot
                        └──/ws 反代──> Go 服务 127.0.0.1:8080
```

Go 服务只监听回环地址，对外入口统一走 Nginx；客户端在生产环境会按页面协议自动选择
`wss://<host>/ws`（见 `client/assets/scripts/net/NetClient.ts` 的 `defaultWsUrl`）。

## 1. 构建服务端

在开发机交叉编译 Linux 二进制：

```bash
cd server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags "-s -w" -o bin/server ./cmd/server
```

> 本地 macOS 直接 `make run` 时需要 `-linkmode=external`，交叉编译到 Linux 不涉及。
> 保持 go1.22.2 工具链，不要升级。

## 2. 上传到服务器

```bash
ssh user@game.example.com 'sudo mkdir -p /opt/arenashot/bin /opt/arenashot/config /var/www/arenashot'

# 服务端二进制 + 数值配置
rsync -avz server/bin/server server/config/game.json \
  user@game.example.com:/tmp/arenashot/
ssh user@game.example.com 'sudo mv /tmp/arenashot/server /opt/arenashot/bin/server \
  && sudo mv /tmp/arenashot/game.json /opt/arenashot/config/game.json \
  && sudo chmod +x /opt/arenashot/bin/server'
```

数值配置以 `server/config/game.json` 为唯一来源；改动后先在本地 `bash scripts/sync-config.sh`
同步到客户端，再按上面步骤重新上传。

## 3. 安装 systemd 服务

```bash
sudo cp deploy/systemd/arenashot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now arenashot
sudo systemctl status arenashot
curl http://127.0.0.1:8080/api/health
```

日志：`journalctl -u arenashot -f`。

## 4. 构建并发布客户端

1. 用 Cocos Creator 3.8.8 打开 `client/`，构建平台选 **Web Mobile**，构建目录 `client/build`。
2. 发布静态产物：

```bash
rsync -avz --delete client/build/web-mobile/ user@game.example.com:/var/www/arenashot/
```

3. 确认构建产物里入口 URL 与站点域名匹配（首屏加载的 `index.html` 走相对路径即可）。

## 5. 配置 Nginx 与证书

```bash
sudo cp deploy/nginx/arenashot.conf /etc/nginx/conf.d/arenashot.conf
# 编辑 server_name / ssl_certificate 路径

# 首次申请证书（webroot 方式；80 端口需已放行）
sudo certbot certonly --webroot -w /var/www/arenashot -d game.example.com

sudo nginx -t && sudo systemctl reload nginx
```

要点：

- `/ws` 必须带 `Upgrade` / `Connection` 头并延长 `proxy_read_timeout`，否则长连接会被 Nginx 提前切断。
- 静态资源带哈希可长缓存；`index.html` 不缓存，保证发版后拿到新入口。
- 防火墙只需放行 80 / 443，8080 不对外。

## 6. 验证

```bash
curl -I https://game.example.com/            # 200 + index.html
curl https://game.example.com/api/health     # 服务端健康检查
# 浏览器打开站点，登录 → 进入战斗，观察右上角 RTT 与观战提示
```

断线重连验证：进入对局后用浏览器 DevTools 切 Offline，约 6s 内出现「网络断开，正在重连」，
恢复网络后自动回到原位置（15s 内）或进入观战排队。

## 反向代理与 WebSocket 的常见坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 握手 400/426 | 未转发 `Upgrade` 头 | 检查 `/ws` 的 `proxy_set_header` |
| 连接 60s 后被断开 | Nginx 默认超时 | `proxy_read_timeout 3600s` |
| 浏览器报混合内容 | 页面 HTTPS 却连 `ws://` | 生产走同源 `wss://`，见 `defaultWsUrl` |
| 发版后仍是旧页面 | `index.html` 被缓存 | 对该路径 `Cache-Control: no-cache` |
