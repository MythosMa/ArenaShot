// ArenaShot 服务端入口。
//
// 职责：加载配置、装配 HTTP（健康检查/配置接口）、启动 WebSocket 网关，
// 并运行共享同一份配置的房间。当前阶段只提供 HTTP 接口，WebSocket 网关在 P2 接入。
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"arena/server/internal/config"
)

var version = "0.1.0" // 构建时可用 -ldflags 覆盖

func main() {
	configPath := flag.String("config", "config/game.json", "配置文件路径")
	addr := flag.String("addr", ":8080", "HTTP 监听地址")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("[main] 配置加载失败: %v", err)
	}
	log.Printf("[main] 配置加载成功 (version=%d, maxPlayers=%d, tickRate=%d)",
		cfg.Version, cfg.Room.MaxPlayers, cfg.Room.TickRate)

	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery())

	registerHTTP(router, cfg)

	srv := &http.Server{
		Addr:    *addr,
		Handler: router,
	}

	// 优雅退出：收到 SIGINT/SIGTERM 后等待正在处理的请求完成再退出。
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig

		log.Println("[main] 收到退出信号，正在优雅关闭...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("[main] 关闭出错: %v", err)
		}
	}()

	log.Printf("[main] HTTP 服务启动: %s", *addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[main] 服务异常退出: %v", err)
	}
	log.Println("[main] 已退出")
}

// registerHTTP 注册所有 HTTP 接口。
func registerHTTP(router *gin.Engine, cfg *config.Config) {
	router.GET("/api/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":   "ok",
			"version":  version,
			"tickRate": cfg.Room.TickRate,
			"time":     time.Now().UnixMilli(),
		})
	})
	router.GET("/api/config", func(c *gin.Context) {
		c.JSON(http.StatusOK, cfg)
	})
}