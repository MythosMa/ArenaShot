# ArenaShot 服务端镜像
# 目标环境：CentOS 宿主机 + Docker，容器内监听 3000，由宿主机 nginx 反代。

# ---- 构建阶段 ----
# 在构建机原生平台编译，用 GOOS/GOARCH 交叉编译成 linux/amd64 静态二进制。
FROM --platform=$BUILDPLATFORM golang:1.22.3-alpine3.20 AS builder

# 设置工作目录
WORKDIR /app

# 将 go.mod 和 go.sum 文件复制到工作目录
COPY go.mod go.sum ./

# 下载依赖
RUN go mod download

# 将项目的所有文件复制到工作目录
COPY . .

ARG TARGETOS=linux
ARG TARGETARCH=amd64
# 版本号由 deploy.sh 统一传参，不在此处维护默认值
ARG VERSION

# 编译 Go 应用程序（静态链接，避免宿主机 libc 依赖）
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" \
    -o /arena-shot-server ./cmd/server

# ---- 运行阶段 ----
# 目标平台由 deploy.sh 的 --platform=linux/amd64 决定，这里不再写死
FROM ccr.ccs.tencentyun.com/mythosma/alpine:3.20

# 安装必要的依赖；时区便于日志按国内时间输出
RUN apk --no-cache add ca-certificates tzdata \
    && addgroup -S app \
    && adduser -S -G app -u 10001 app

# 设置工作目录（不能用 /root：非 root 用户 app 无权限进入）
WORKDIR /app

# 将编译好的二进制文件从构建阶段复制到这个镜像
COPY --from=builder /arena-shot-server .

# 服务端默认读取 config/game.json，必须一并放进镜像
COPY --from=builder /app/config ./config

# 设置环境变量
ENV PORT=3000 \
    TZ=Asia/Shanghai

# 用非 root 用户运行
USER app

# 暴露端口
EXPOSE 3000

# 容器的 sh 不支持 source，且 .env 未打入镜像；直接以命令行参数启动
CMD ["./arena-shot-server", "-config", "config/game.json", "-addr", ":3000"]
