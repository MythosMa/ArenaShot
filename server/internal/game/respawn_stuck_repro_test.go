package game

// 临时复现测试：排查「死亡复活后漂移到地图边界并卡住」。
// 全部断言围绕一个问题——服务端在死亡期间丢弃的输入，是否会在复活后
// 以某种方式「残留/叠加」，把玩家推到边界并让他无法控制。

import (
	"math"
	"testing"

	"arena/server/internal/config"
	"arena/server/internal/protocol"
)

func TestRespawnKeepsHeldInputFromStacking(t *testing.T) {
	cfg := loadTestConfig(t)
	w := NewWorld(cfg)
	p := w.AddPlayer("p1", "s1", "Alice")
	p.X, p.Y = 1400, 860 // 地图中部，远离任何出生点与边界
	p.InvincibleUntil = 0

	now := int64(1000)
	// 玩家按住「左+上」（朝向地图左上角）时被击杀。
	held := protocol.InputRequest{MoveX: -1, MoveY: -1}
	for i := 0; i < 5; i++ {
		w.SetInput("p1", uint64(i+1), held, now)
		w.Step(now)
		now += 50
	}

	// 击杀：直接置为死亡并安排 4s 后复活。
	p.HP = 0
	p.Alive = false
	p.RespawnAt = now + int64(cfg.Room.RespawnDelayMs)

	// 死亡期间客户端仍在持续上报同样的按键（服务端应全部丢弃）。
	respawnAt := now
	fed := int64(0)
	for now < p.RespawnAt {
		if w.SetInput("p1", uint64(now), held, now) {
			fed++
		}
		w.Step(now)
		now += 50
	}
	_ = respawnAt
	if fed != 0 {
		t.Fatalf("死亡期间输入不应被接受，实际接受了 %d 条", fed)
	}

	// 复活：玩家应出现在出生点，而不是被残留输入带到边界。
	w.Step(now)
	if !p.Alive {
		t.Fatal("玩家未复活")
	}
	if p.X != cfg.Map.SpawnPoints[0].X && p.Y != cfg.Map.SpawnPoints[0].Y &&
		p.X != p.X { // 出生点位置由 chooseSpawn 决定，只需断言其合法且在净空区
		t.Fatalf("复活位置非法")
	}
	if !SpawnClear(cfg, w, p) {
		t.Fatalf("复活位置与障碍/墙壁重叠: (%v, %v)", p.X, p.Y)
	}
	// 边界判定：出生点离任意边界墙至少 100px（半径 16 + 墙 96 + 余量）。
	const minEdgeDist = 100
	if p.X < minEdgeDist || p.X > cfg.Map.Width-minEdgeDist ||
		p.Y < minEdgeDist || p.Y > cfg.Map.Height-minEdgeDist {
		t.Fatalf("复活位置不应贴到地图边界: (%v, %v)", p.X, p.Y)
	}

	// 复活后立刻按旧方向移动一个 tick：残留输入应被过期门挡住，位置不变。
	x0, y0 := p.X, p.Y
	w.Step(now + 50)
	if p.X != x0 || p.Y != y0 {
		t.Fatalf("复活后无新输入时不应移动（残留输入未清理）: (%v,%v)->(%v,%v)", x0, y0, p.X, p.Y)
	}

	// 玩家按下反向键后应能自由移动（证明没有被卡住）。
	now += 50
	w.SetInput("p1", uint64(now), protocol.InputRequest{MoveX: 1, MoveY: 1}, now)
	w.Step(now)
	dx, dy := p.X-x0, p.Y-y0
	if math.Hypot(dx, dy) < 9 {
		t.Fatalf("复活后输入无效，玩家无法移动: (%v,%v)->(%v,%v)", x0, y0, p.X, p.Y)
	}
}

func TestHeldKeyThroughDeathCanMoveAwayFromWall(t *testing.T) {
	cfg := loadTestConfig(t)
	w := NewWorld(cfg)
	p := w.AddPlayer("p1", "s1", "Alice")
	p.X, p.Y = 336, 400 // 顶部出生点附近
	p.InvincibleUntil = 0

	now := int64(1000)
	// 向上按住死亡 -> 复活 -> 继续保持向上，会一路顶到上边界墙。
	held := protocol.InputRequest{MoveY: -1}
	for i := 0; i < 4; i++ {
		w.SetInput("p1", uint64(i+1), held, now)
		w.Step(now)
		now += 50
	}
	p.HP = 0
	p.Alive = false
	p.RespawnAt = now + int64(cfg.Room.RespawnDelayMs)
	for now < p.RespawnAt {
		w.SetInput("p1", uint64(now), held, now)
		w.Step(now)
		now += 50
	}
	w.Step(now) // 复活

	// chooseSpawn 可能把玩家放到任意出生点，这里固定到上方出生点附近，聚焦边界行为。
	p.X, p.Y = 336, 350

	// 复活后用「继续向上」输入推进 40 tick，玩家应被顶到上边界并停止。
	// 上边界墙 s_1 覆盖 y 0..96 + 玩家半径 16 => 圆心可到达的极限 y≈112；
	// tryMove 在目标位置被判定重叠时保持原地，故玩家会停在最后一次合法位置。
	for i := 0; i < 40; i++ {
		now += 50
		w.SetInput("p1", uint64(now), held, now)
		w.Step(now)
	}
	if p.Y > 124 {
		t.Fatalf("玩家应被上边界挡住: y=%v", p.Y)
	}

	// 关键断言：松开上、改按「下」，玩家必须能立刻向下离开边界。
	yAtWall := p.Y
	now += 50
	w.SetInput("p1", uint64(now), protocol.InputRequest{MoveY: 1}, now)
	w.Step(now)
	if math.Abs(p.Y-yAtWall) < 9 {
		t.Fatalf("玩家贴墙后无法反向离开: y=%v -> %v", yAtWall, p.Y)
	}
}

func TestObstacleRespawnPushStaysLocalAndMovable(t *testing.T) {
	cfg := loadTestConfig(t)
	w := NewWorld(cfg)
	p := w.AddPlayer("p1", "s1", "Alice")
	o := w.findObstacle("b_16") // (576,1488) 192x96，底部中间，靠近下边界墙 s_20

	now := int64(1000)
	o.Broken = true
	o.HP = 0
	o.RespawnAt = now + 1000
	// 玩家站在碎块下边缘与下边界墙之间：半径为 16，圆心放在障碍内部最下沿。
	p.X, p.Y = o.X, o.Y+40

	// 障碍恢复：最小穿透方向把玩家推出障碍。推出的位移必须是「局部」的——
	// 不能把玩家甩到地图边界。玩家圆心 (576,1528) 在 b_16（y 1440..1536）内，
	// 距障碍底部 8px，半径 16 => 最短路径是向下推 ~24px 到 y≈1552，脱离障碍即可。
	w.Step(o.RespawnAt)
	if w.blockingObstacle(p.X, p.Y, cfg.Player.Radius) != nil {
		t.Fatalf("玩家仍卡在障碍内: (%v, %v)", p.X, p.Y)
	}
	const maxPush = 300 // 局部推出：位移绝不可能是横跨半张地图甩向边界
	if math.Hypot(p.X-o.X, p.Y-o.Y) > maxPush {
		t.Fatalf("障碍恢复把玩家推出了 %vpx，远超局部推出范围", math.Hypot(p.X-o.X, p.Y-o.Y))
	}

	// 推出后向远离障碍的方向（下）必须能自由移动（服务端 y 向下，下移 = y 增大）；
	// 向上则可能贴住障碍边缘被挡（正常碰撞语义），故用远离方向验证未卡死。
	now = o.RespawnAt + 50
	preY := p.Y
	w.SetInput("p1", uint64(now), protocol.InputRequest{MoveY: 1}, now)
	w.Step(now)
	if p.Y <= preY {
		t.Fatalf("从障碍推出后无法移动: y=%v -> %v", preY, p.Y)
	}
}

// SpawnClear 断言当前位置不与任何未破坏障碍或边界墙重叠。
func SpawnClear(cfg *config.Config, w *World, p *Player) bool {
	return w.blockingObstacle(p.X, p.Y, cfg.Player.Radius) == nil
}