package game

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"arena/server/internal/protocol"
)

// fakePeer 用带缓冲 channel 模拟一个连接。
type fakePeer struct {
	ch chan []byte
}

func newFakePeer() *fakePeer {
	return &fakePeer{ch: make(chan []byte, 512)}
}

func (p *fakePeer) Send(raw []byte) {
	select {
	case p.ch <- raw:
	default:
	}
}

func decode[T any](t *testing.T, raw []byte) (string, T) {
	t.Helper()
	var env protocol.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("解析封套失败: %v", err)
	}
	var data T
	if len(env.Data) > 0 {
		if err := json.Unmarshal(env.Data, &data); err != nil {
			t.Fatalf("解析 %s 负载失败: %v", env.Type, err)
		}
	}
	return env.Type, data
}

// waitForType 从 peer 的消息流中找到指定类型的消息，跳过快照等无关消息。
func waitForType[T any](t *testing.T, p *fakePeer, msgType string, timeout time.Duration) T {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case raw := <-p.ch:
			typ, data := decode[T](t, raw)
			if typ == msgType {
				return data
			}
		case <-deadline:
			t.Fatalf("等待消息 %s 超时", msgType)
		}
	}
}

func TestSpectatorQueueAndPromotion(t *testing.T) {
	cfg := loadTestConfig(t)
	room := NewRoom(cfg, protocol.NewJSONCodec())
	go room.Run()
	defer room.Stop()

	peers := make([]*fakePeer, cfg.Room.MaxPlayers)
	for i := range peers {
		peers[i] = newFakePeer()
		res, info := room.Join(peers[i], fmt.Sprintf("p_%d", i), fmt.Sprintf("s_%d", i), fmt.Sprintf("玩家%d", i))
		if !res.Success || res.Spectator {
			t.Fatalf("第 %d 个玩家应成功加入战斗: %+v", i, res)
		}
		if info.PlayerCount != i+1 {
			t.Fatalf("房间人数 = %d，期望 %d", info.PlayerCount, i+1)
		}
	}

	// 第 5 人应进入观战队列。
	extra := newFakePeer()
	res, info := room.Join(extra, "p_4", "s_4", "观战者")
	if !res.Success || !res.Spectator {
		t.Fatalf("满员后应进入观战: %+v", res)
	}
	if res.QueuePos != 1 {
		t.Fatalf("排队位置 = %d，期望 1", res.QueuePos)
	}
	if info.SpectatorCount != 1 {
		t.Fatalf("观战人数 = %d，期望 1", info.SpectatorCount)
	}

	// 一名玩家离开后，观战者应被补位并收到成功加入结果。
	room.Leave("p_0")

	joinResult := waitForType[protocol.JoinResult](t, extra, protocol.S2CJoinResult, 2*time.Second)
	if !joinResult.Success || joinResult.Spectator {
		t.Fatalf("补位结果异常: %+v", joinResult)
	}

	// 剩余玩家应收到离开事件。
	leave := waitForType[protocol.PlayerLeaveEvent](t, peers[1], protocol.S2CPlayerLeave, 2*time.Second)
	if leave.ID != "p_0" {
		t.Fatalf("离开事件 ID = %s，期望 p_0", leave.ID)
	}
}

// TestSpectatorQueuePositionsRefresh 回归：前面的观战者离开后，
// 剩余观战者应收到更新后的排队序号。
func TestSpectatorQueuePositionsRefresh(t *testing.T) {
	cfg := loadTestConfig(t)
	room := NewRoom(cfg, protocol.NewJSONCodec())
	go room.Run()
	defer room.Stop()

	for i := 0; i < cfg.Room.MaxPlayers; i++ {
		room.Join(newFakePeer(), fmt.Sprintf("p_%d", i), fmt.Sprintf("s_%d", i), fmt.Sprintf("玩家%d", i))
	}
	a := newFakePeer()
	b := newFakePeer()
	resA, _ := room.Join(a, "p_a", "s_a", "A")
	resB, _ := room.Join(b, "p_b", "s_b", "B")
	if resA.QueuePos != 1 || resB.QueuePos != 2 {
		t.Fatalf("初始排队位置异常: A=%d B=%d", resA.QueuePos, resB.QueuePos)
	}

	room.Leave("p_a")

	upd := waitForType[protocol.JoinResult](t, b, protocol.S2CJoinResult, 2*time.Second)
	if !upd.Success || !upd.Spectator || upd.QueuePos != 1 {
		t.Fatalf("剩余观战者序号应更新为 1: %+v", upd)
	}
}

func TestSnapshotsAreBroadcast(t *testing.T) {
	cfg := loadTestConfig(t)
	room := NewRoom(cfg, protocol.NewJSONCodec())
	go room.Run()
	defer room.Stop()

	a, b := newFakePeer(), newFakePeer()
	room.Join(a, "p_a", "s_a", "Alice")
	room.Join(b, "p_b", "s_b", "Bob")

	snapA := waitForType[protocol.Snapshot](t, a, protocol.S2CSnapshot, 2*time.Second)
	snapB := waitForType[protocol.Snapshot](t, b, protocol.S2CSnapshot, 2*time.Second)
	if len(snapA.Players) != 2 || len(snapB.Players) != 2 {
		t.Fatalf("快照玩家数异常: A=%d B=%d", len(snapA.Players), len(snapB.Players))
	}
}
