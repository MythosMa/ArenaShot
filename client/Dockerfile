# 使用官方 Node.js 镜像作为基础镜像
FROM --platform=linux/amd64 node:alpine

# 创建工作目录
WORKDIR /app

# 复制 必须文件
COPY build/web-mobile ./build

RUN npm install -g serve

# 暴露端口
EXPOSE 3000

# 启动实例
CMD [ "serve", "-s", "build" ]