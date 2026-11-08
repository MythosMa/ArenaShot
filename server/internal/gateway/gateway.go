// Package gateway 提供 WebSocket 接入层：握手、会话、消息路由与连接生命周期。
//
// 每个连接有独立的读/写 goroutine：读循环解析客户端消息并投递给房间，
// 写循环把房间广播放入发送队列的消息真正写到网络。慢客户端只会在自己的
// 发送队列里丢帧，不会阻塞房间 tick。
package gateway

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"arena/server/internal/config"
	"arena/server/internal/game"
	"arena/server/internal/protocol"
	"arena/server/internal/session"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = 25 * time.Second
	maxMessageSize = 4096
	sendQueueSize  = 128
	maxNameRunes   = 16
)

// Gateway 持有接入层依赖，并作为 gin 路由的处理入口。
type Gateway struct {
	cfg      *config.Config
	room     *game.Room
	codec    protocol.Codec
	sessions *session.Manager
	upgrader websocket.Upgrader
}

// New 创建 WebSocket 网关。
func New(cfg *config.Config, room *game.Room, codec protocol.Codec, sessions *session.Manager) *Gateway {
	return &Gateway{
		cfg:      cfg,
		room:     room,
		codec:    codec,
		sessions: sessions,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 4096,
			// 开发阶段允许任意来源；部署时按域名收紧。
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}
}

// Register 将 WebSocket 入口挂载到 gin 路由。
func (g *Gateway) Register(router *gin.Engine) {
	router.GET("/ws", g.Handle)
}

// Handle 是 WebSocket 握手入口。
func (g *Gateway) Handle(c *gin.Context) {
	conn, err := g.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("[gateway] WebSocket 升级失败: %v", err)
		return
	}
	newClient(g, conn).run()
}

// Client 表示一条 WebSocket 连接，实现 game.Peer。
type Client struct {
	g    *Gateway
	conn *websocket.Conn

	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once
	outSeq    atomic.Uint64

	mu      sync.RWMutex
	sess    *session.Session
	joined  bool
	playing bool
}

func newClient(g *Gateway, conn *websocket.Conn) *Client {
	return &Client{
		g:    g,
		conn: conn,
		send: make(chan []byte, sendQueueSize),
		done: make(chan struct{}),
	}
}

// Send 实现 game.Peer：把已编码消息放入发送队列。
// 队列满时丢弃最旧的一帧并保留最新状态，保证快照始终是新的。
func (c *Client) Send(raw []byte) {
	select {
	case <-c.done:
		return
	default:
	}

	select {
	case c.send <- raw:
	default:
		select {
		case <-c.send:
		default:
		}
		select {
		case c.send <- raw:
		default:
		}
	}
}

func (c *Client) run() {
	go c.writeLoop()
	c.readLoop()
	c.shutdown()
	log.Printf("[gateway] 连接关闭 player=%s", c.playerIDOrUnknown())
}

// readLoop 持续读取并路由客户端消息，直到连接出错或被关闭。
func (c *Client) readLoop() {
	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("[gateway] 读取异常: %v", err)
			}
			return
		}

		env, err := c.g.codec.Decode(raw)
		if err != nil {
			c.sendError(400, "协议解析失败")
			continue
		}
		c.handle(env)
	}
}

// writeLoop 负责所有网络写出，避免房间 goroutine 被慢连接阻塞。
func (c *Client) writeLoop() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case <-c.done:
			return
		case raw := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, raw); err != nil {
				c.shutdown()
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				c.shutdown()
				return
			}
		}
	}
}

// shutdown 保证只执行一次：通知房间离开、关闭底层连接。
func (c *Client) shutdown() {
	c.closeOnce.Do(func() {
		close(c.done)

		sess, joined := c.identity()
		if sess != nil {
			if joined {
				// 战斗/观战中掉线：保留战斗实体，等待重连超时后再释放。
				c.g.room.Disconnect(sess.PlayerID, c)
			} else {
				// 只是登录过就断开，直接回收会话，避免会话泄漏。
				c.g.sessions.Delete(sess.ID)
			}
		}
		_ = c.conn.Close()
	})
}

func (c *Client) handle(env *protocol.Envelope) {
	switch env.Type {
	case protocol.C2SLogin:
		c.handleLogin(env)
	case protocol.C2SJoin:
		c.handleJoin(env)
	case protocol.C2SSpectate:
		c.handleSpectate(env)
	case protocol.C2SInput:
		c.handleInput(env)
	case protocol.C2SPing:
		c.handlePing(env)
	case protocol.C2SLeave:
		c.handleLeave(env)
	default:
		c.sendError(404, "未知消息类型: "+env.Type)
	}
}

func (c *Client) handleLogin(env *protocol.Envelope) {
	if _, ok := c.session(); ok {
		c.sendError(409, "已登录")
		return
	}

	var req protocol.LoginRequest
	if !decodeData(env, &req) {
		c.sendError(400, "登录数据格式错误")
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" || len([]rune(name)) > maxNameRunes {
		c.sendError(400, "名字长度需为 1~16 个字符")
		return
	}

	// 带 sessionId 且会话仍有效时复用原身份，实现断线重连。
	var sess *session.Session
	reconnected := false
	if req.SessionID != "" {
		if s, ok := c.g.sessions.Get(req.SessionID); ok {
			sess = s
			reconnected = true
		}
	}
	if sess == nil {
		sess = c.g.sessions.Create(name)
	}
	c.setIdentity(sess)

	c.sendMsg(protocol.S2CLoginOK, protocol.LoginResponse{
		PlayerID:      sess.PlayerID,
		SessionID:     sess.ID,
		ConfigVersion: c.g.cfg.Version,
		ServerTime:    time.Now().UnixMilli(),
	})
	if reconnected {
		log.Printf("[gateway] 重连登录: %s(%s)", sess.Name, sess.PlayerID)
	} else {
		log.Printf("[gateway] 登录成功: %s(%s)", name, sess.PlayerID)
	}
}

func (c *Client) handleJoin(env *protocol.Envelope) {
	sess, ok := c.session()
	if !ok {
		c.sendError(401, "请先登录")
		return
	}
	if c.isJoined() {
		c.sendError(409, "已在房间中")
		return
	}

	res, info := c.g.room.Join(c, sess.PlayerID, sess.ID, sess.Name)
	c.sendMsg(protocol.S2CJoinResult, res)
	if !res.Success {
		return
	}
	c.markJoined(!res.Spectator)
	c.sendMsg(protocol.S2CRoomInfo, info)
}

func (c *Client) handleSpectate(env *protocol.Envelope) {
	sess, ok := c.session()
	if !ok {
		c.sendError(401, "请先登录")
		return
	}
	if c.isJoined() {
		c.sendError(409, "请先离开战斗")
		return
	}

	res, info := c.g.room.Spectate(c, sess.PlayerID, sess.ID, sess.Name)
	c.sendMsg(protocol.S2CJoinResult, res)
	if !res.Success {
		return
	}
	c.markJoined(false)
	c.sendMsg(protocol.S2CRoomInfo, info)
}

func (c *Client) handleInput(env *protocol.Envelope) {
	sess, ok := c.session()
	if !ok || !c.isPlaying() {
		return // 观战者或未登录连接不接受输入
	}

	var req protocol.InputRequest
	if !decodeData(env, &req) {
		c.sendError(400, "输入数据格式错误")
		return
	}
	c.g.room.Input(sess.PlayerID, env.Seq, req)
}

func (c *Client) handlePing(env *protocol.Envelope) {
	var req protocol.PingRequest
	if !decodeData(env, &req) {
		req = protocol.PingRequest{}
	}
	c.sendMsg(protocol.S2CPong, protocol.PongResponse{
		ClientTime: req.ClientTime,
		ServerTime: time.Now().UnixMilli(),
	})
}

func (c *Client) handleLeave(env *protocol.Envelope) {
	sess, ok := c.session()
	if !ok {
		c.sendError(401, "请先登录")
		return
	}
	if !c.isJoined() {
		c.sendError(409, "未加入房间")
		return
	}

	info := c.g.room.Leave(sess.PlayerID)
	c.markLeft()
	c.sendMsg(protocol.S2CRoomInfo, info)
}

// ---------------- 发送与身份访问 ----------------

func (c *Client) sendMsg(msgType string, data any) {
	raw, err := c.g.codec.Encode(msgType, c.outSeq.Add(1), data)
	if err != nil {
		log.Printf("[gateway] 消息编码失败 type=%s: %v", msgType, err)
		return
	}
	c.Send(raw)
}

func (c *Client) sendError(code int, message string) {
	c.sendMsg(protocol.S2CError, protocol.ErrorMessage{Code: code, Message: message})
}

func (c *Client) session() (*session.Session, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.sess, c.sess != nil
}

func (c *Client) setIdentity(sess *session.Session) {
	c.mu.Lock()
	c.sess = sess
	c.mu.Unlock()
}

func (c *Client) identity() (*session.Session, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.sess, c.joined
}

func (c *Client) markJoined(playing bool) {
	c.mu.Lock()
	c.joined = true
	c.playing = playing
	c.mu.Unlock()
}

// markLeft 在主动离开房间后清除加入状态，允许同一连接重新加入/观战。
func (c *Client) markLeft() {
	c.mu.Lock()
	c.joined = false
	c.playing = false
	c.mu.Unlock()
}

func (c *Client) isJoined() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.joined
}

func (c *Client) isPlaying() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.joined && c.playing
}

// SetPlaying 实现 game.PromotePeer：观战者被补位为战斗玩家后放开输入。
func (c *Client) SetPlaying(playing bool) {
	c.mu.Lock()
	c.joined = true
	c.playing = playing
	c.mu.Unlock()
}

func (c *Client) playerIDOrUnknown() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.sess == nil {
		return "-"
	}
	return c.sess.PlayerID
}

func decodeData(env *protocol.Envelope, dst any) bool {
	if len(env.Data) == 0 {
		return false
	}
	return json.Unmarshal(env.Data, dst) == nil
}
