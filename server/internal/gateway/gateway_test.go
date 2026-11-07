package gateway

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"arena/server/internal/config"
	"arena/server/internal/game"
	"arena/server/internal/protocol"
	"arena/server/internal/session"
)

func loadTestConfig(t *testing.T) *config.Config {
	t.Helper()
	cfg, err := config.Load("../../config/game.json")
	if err != nil {
		t.Fatalf("加载测试配置失败: %v", err)
	}
	return cfg
}

func mustDial(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("连接 WebSocket 失败: %v", err)
	}
	return conn
}

func writeEnv(t *testing.T, conn *websocket.Conn, codec protocol.Codec, msgType string, seq uint64, data any) {
	t.Helper()
	raw, err := codec.Encode(msgType, seq, data)
	if err != nil {
		t.Fatalf("编码 %s 失败: %v", msgType, err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, raw); err != nil {
		t.Fatalf("发送 %s 失败: %v", msgType, err)
	}
}

// waitFor 持续读取直到出现指定类型并满足条件；skip 为 nil 时不筛类型以外的内容。
func waitFor(t *testing.T, conn *websocket.Conn, codec protocol.Codec, msgType string, timeout time.Duration, check func(json.RawMessage) bool) json.RawMessage {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		_ = conn.SetReadDeadline(deadline)
		_, raw, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("等待 %s 超时/失败: %v", msgType, err)
		}
		env, err := codec.Decode(raw)
		if err != nil || env.Type != msgType {
			continue
		}
		if check == nil || check(env.Data) {
			return env.Data
		}
	}
}

func loginAndJoin(t *testing.T, conn *websocket.Conn, codec protocol.Codec, name string) {
	t.Helper()

	writeEnv(t, conn, codec, protocol.C2SLogin, 1, protocol.LoginRequest{Name: name})
	waitFor(t, conn, codec, protocol.S2CLoginOK, 2*time.Second, nil)

	writeEnv(t, conn, codec, protocol.C2SJoin, 2, struct{}{})
	data := waitFor(t, conn, codec, protocol.S2CJoinResult, 2*time.Second, nil)
	var res protocol.JoinResult
	if err := json.Unmarshal(data, &res); err != nil {
		t.Fatalf("解析加入结果失败: %v", err)
	}
	if !res.Success || res.Spectator {
		t.Fatalf("%s 应成功加入战斗: %+v", name, res)
	}
}

func TestTwoClientsSeeEachOtherMove(t *testing.T) {
	cfg := loadTestConfig(t)
	codec := protocol.NewJSONCodec()

	room := game.NewRoom(cfg, codec)
	go room.Run()
	defer room.Stop()

	gin.SetMode(gin.TestMode)
	router := gin.New()
	New(cfg, room, codec, session.NewManager()).Register(router)

	srv := httptest.NewServer(router)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	alice := mustDial(t, wsURL)
	defer alice.Close()
	bob := mustDial(t, wsURL)
	defer bob.Close()

	loginAndJoin(t, alice, codec, "Alice")
	loginAndJoin(t, bob, codec, "Bob")

	// 双方都应看到 2 名玩家。
	first := waitSnapshot(t, alice, codec, func(s protocol.Snapshot) bool { return len(s.Players) == 2 }, 3*time.Second)
	waitSnapshot(t, bob, codec, func(s protocol.Snapshot) bool { return len(s.Players) == 2 }, 3*time.Second)

	var startX float64
	found := false
	for _, p := range first.Players {
		if p.Name == "Alice" {
			startX, found = p.X, true
		}
	}
	if !found {
		t.Fatal("快照中找不到 Alice")
	}

	// Alice 持续向右移动，Bob 应能通过快照看到位置变化。
	for i := 0; i < 3; i++ {
		writeEnv(t, alice, codec, protocol.C2SInput, uint64(10+i), protocol.InputRequest{MoveX: 1})
		time.Sleep(40 * time.Millisecond)
	}

	moved := waitSnapshot(t, bob, codec, func(s protocol.Snapshot) bool {
		for _, p := range s.Players {
			if p.Name == "Alice" {
				return p.X > startX+1
			}
		}
		return false
	}, 3*time.Second)

	for _, p := range moved.Players {
		if p.Name == "Alice" && p.X <= startX {
			t.Fatalf("Alice 位置未更新: start=%v now=%v", startX, p.X)
		}
	}
}

// TestShootProducesBullet 验证 P3 的射击输入能走通网关 -> 房间 -> 世界，
// 并出现在下一帧快照里。
func TestShootProducesBullet(t *testing.T) {
	cfg := loadTestConfig(t)
	codec := protocol.NewJSONCodec()

	room := game.NewRoom(cfg, codec)
	go room.Run()
	defer room.Stop()

	gin.SetMode(gin.TestMode)
	router := gin.New()
	New(cfg, room, codec, session.NewManager()).Register(router)
	srv := httptest.NewServer(router)
	defer srv.Close()

	alice := mustDial(t, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws")
	defer alice.Close()
	loginAndJoin(t, alice, codec, "Alice")

	waitSnapshot(t, alice, codec, func(s protocol.Snapshot) bool { return len(s.Players) == 1 }, 2*time.Second)

	for i := 0; i < 4; i++ {
		writeEnv(t, alice, codec, protocol.C2SInput, uint64(10+i), protocol.InputRequest{Aim: 0, Fire: true})
		time.Sleep(50 * time.Millisecond)
	}

	snap := waitSnapshot(t, alice, codec, func(s protocol.Snapshot) bool { return len(s.Bullets) > 0 }, 2*time.Second)
	b := snap.Bullets[0]
	if b.Owner == "" || b.VX == 0 || b.VY != 0 {
		t.Fatalf("子弹数据异常: %+v", b)
	}
}

// TestPromotedSpectatorCanMove 回归：满员后进入观战队列的玩家，在有人离开被补位后
// 必须能上报输入并移动（此前网关的 playing 标志不会随补位更新，输入被一直丢弃）。
func TestPromotedSpectatorCanMove(t *testing.T) {
	cfg := loadTestConfig(t)
	codec := protocol.NewJSONCodec()

	room := game.NewRoom(cfg, codec)
	go room.Run()
	defer room.Stop()

	gin.SetMode(gin.TestMode)
	router := gin.New()
	New(cfg, room, codec, session.NewManager()).Register(router)

	srv := httptest.NewServer(router)
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	players := make([]*websocket.Conn, 0, cfg.Room.MaxPlayers)
	for i := 0; i < cfg.Room.MaxPlayers; i++ {
		c := mustDial(t, wsURL)
		defer c.Close()
		loginAndJoin(t, c, codec, fmt.Sprintf("P%d", i))
		players = append(players, c)
	}

	// 第 5 人：登录后加入，应进入观战队列。
	late := mustDial(t, wsURL)
	defer late.Close()
	writeEnv(t, late, codec, protocol.C2SLogin, 1, protocol.LoginRequest{Name: "Late"})
	waitFor(t, late, codec, protocol.S2CLoginOK, 2*time.Second, nil)
	writeEnv(t, late, codec, protocol.C2SJoin, 2, struct{}{})
	queuedData := waitFor(t, late, codec, protocol.S2CJoinResult, 2*time.Second, nil)
	var queued protocol.JoinResult
	if err := json.Unmarshal(queuedData, &queued); err != nil {
		t.Fatalf("解析观战结果失败: %v", err)
	}
	if !queued.Success || !queued.Spectator {
		t.Fatalf("满员后应进入观战: %+v", queued)
	}

	// 一名玩家离开，Late 应被补位。
	writeEnv(t, players[0], codec, protocol.C2SLeave, 3, struct{}{})
	waitFor(t, late, codec, protocol.S2CJoinResult, 2*time.Second, func(raw json.RawMessage) bool {
		var res protocol.JoinResult
		return json.Unmarshal(raw, &res) == nil && res.Success && !res.Spectator
	})

	// 补位后连续上报右移输入，快照中自身位置应发生变化。
	start := waitSnapshot(t, late, codec, func(s protocol.Snapshot) bool {
		for _, p := range s.Players {
			if p.Name == "Late" {
				return true
			}
		}
		return false
	}, 2*time.Second)
	var startX float64
	for _, p := range start.Players {
		if p.Name == "Late" {
			startX = p.X
		}
	}

	for i := 0; i < 3; i++ {
		writeEnv(t, late, codec, protocol.C2SInput, uint64(10+i), protocol.InputRequest{MoveX: 1})
		time.Sleep(40 * time.Millisecond)
	}

	moved := waitSnapshot(t, late, codec, func(s protocol.Snapshot) bool {
		for _, p := range s.Players {
			if p.Name == "Late" {
				return p.X > startX+1
			}
		}
		return false
	}, 3*time.Second)
	for _, p := range moved.Players {
		if p.Name == "Late" && p.X <= startX {
			t.Fatalf("补位后未移动: start=%v now=%v", startX, p.X)
		}
	}
}

// TestLeaveAllowsRejoin 回归：主动离开后同一连接应能重新加入。
// 此前 markJoined 恒定置 true，导致 leave 后 join/spectate 一直被判定为「已在房间中」。
func TestLeaveAllowsRejoin(t *testing.T) {
	cfg := loadTestConfig(t)
	codec := protocol.NewJSONCodec()

	room := game.NewRoom(cfg, codec)
	go room.Run()
	defer room.Stop()

	gin.SetMode(gin.TestMode)
	router := gin.New()
	New(cfg, room, codec, session.NewManager()).Register(router)

	srv := httptest.NewServer(router)
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	conn := mustDial(t, wsURL)
	defer conn.Close()
	loginAndJoin(t, conn, codec, "Alice")

	writeEnv(t, conn, codec, protocol.C2SLeave, 3, struct{}{})
	waitFor(t, conn, codec, protocol.S2CRoomInfo, 2*time.Second, nil)

	writeEnv(t, conn, codec, protocol.C2SJoin, 4, struct{}{})
	data := waitFor(t, conn, codec, protocol.S2CJoinResult, 2*time.Second, nil)
	var res protocol.JoinResult
	if err := json.Unmarshal(data, &res); err != nil {
		t.Fatalf("解析重新加入结果失败: %v", err)
	}
	if !res.Success || res.Spectator {
		t.Fatalf("离开后应能重新加入战斗: %+v", res)
	}
}

func waitSnapshot(t *testing.T, conn *websocket.Conn, codec protocol.Codec, pred func(protocol.Snapshot) bool, timeout time.Duration) protocol.Snapshot {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		_ = conn.SetReadDeadline(deadline)
		_, raw, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("等待快照超时/失败: %v", err)
		}
		env, err := codec.Decode(raw)
		if err != nil || env.Type != protocol.S2CSnapshot {
			continue
		}
		var snap protocol.Snapshot
		if err := json.Unmarshal(env.Data, &snap); err != nil {
			t.Fatalf("解析快照失败: %v", err)
		}
		if pred(snap) {
			return snap
		}
	}
}
