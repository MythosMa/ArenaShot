package game

import (
	"fmt"
	"math"
	"testing"

	"arena/server/internal/config"
	"arena/server/internal/protocol"
)

func loadTestConfig(t *testing.T) *config.Config {
	t.Helper()
	cfg, err := config.Load("../../config/game.json")
	if err != nil {
		t.Fatalf("加载测试配置失败: %v", err)
	}
	return cfg
}

func TestMoveAppliesInput(t *testing.T) {
	w := NewWorld(loadTestConfig(t))
	p := w.AddPlayer("p1", "s1", "Alice")
	p.X, p.Y = 300, 300

	if !w.SetInput("p1", 1, protocol.InputRequest{MoveX: 1}, 1000) {
		t.Fatal("输入应被接受")
	}
	w.Step(1050)

	// 20Hz 下每 tick 位移 = 220 * 0.05 = 11。
	if got := p.X - 300; math.Abs(got-11) > 0.001 {
		t.Fatalf("向右移动距离 = %v，期望 11", got)
	}
	if p.Y != 300 {
		t.Fatalf("Y 不应变化，实际 %v", p.Y)
	}
}

func TestDiagonalInputIsNormalized(t *testing.T) {
	w := NewWorld(loadTestConfig(t))
	p := w.AddPlayer("p1", "s1", "Alice")
	p.X, p.Y = 300, 300

	w.SetInput("p1", 1, protocol.InputRequest{MoveX: 1, MoveY: 1}, 1000)
	w.Step(1050)

	dist := math.Hypot(p.X-300, p.Y-300)
	if math.Abs(dist-11) > 0.001 {
		t.Fatalf("斜向位移 = %v，期望等于单 tick 速度 11（不应因斜向变快）", dist)
	}
}

func TestObstacleBlocksAndSlides(t *testing.T) {
	w := NewWorld(loadTestConfig(t))
	p := w.AddPlayer("p1", "s1", "Alice")

	// s_7 是中心 (480,624)、384x96 的实心障碍，左边缘 x=288。
	// 玩家半径 16，最多移动到 x=272。
	p.X, p.Y = 200, 624

	now := int64(1000)
	for i := 0; i < 40; i++ {
		now += 50
		w.SetInput("p1", uint64(i+1), protocol.InputRequest{MoveX: 1}, now)
		w.Step(now)
	}

	if p.X > 272.001 {
		t.Fatalf("玩家穿过了障碍: x=%v（上限 272）", p.X)
	}
	if p.X < 258 {
		t.Fatalf("玩家未能贴近障碍: x=%v", p.X)
	}
}

func TestStaleInputStopsMovement(t *testing.T) {
	w := NewWorld(loadTestConfig(t))
	p := w.AddPlayer("p1", "s1", "Alice")
	p.X, p.Y = 300, 300

	w.SetInput("p1", 1, protocol.InputRequest{MoveX: 1}, 1000)
	w.Step(1600) // 距离上次输入 600ms，已超过 500ms 的有效期

	if p.X != 300 {
		t.Fatalf("过期输入不应继续驱动移动，x=%v", p.X)
	}
}

func TestInputRateLimit(t *testing.T) {
	cfg := loadTestConfig(t)
	w := NewWorld(cfg)
	w.AddPlayer("p1", "s1", "Alice")

	now := int64(5000)
	accepted := 0
	for i := 0; i < cfg.Room.MaxInputsPerSecond+1; i++ {
		if w.SetInput("p1", uint64(i), protocol.InputRequest{}, now) {
			accepted++
		}
	}

	if accepted != cfg.Room.MaxInputsPerSecond {
		t.Fatalf("1 秒内接受输入 = %d，期望上限 %d", accepted, cfg.Room.MaxInputsPerSecond)
	}
}

// ---- P3 战斗闭环 ----

func TestFireCreatesMovingBullet(t *testing.T) {
	w := NewWorld(loadTestConfig(t))
	p := w.AddPlayer("p1", "s1", "Alice")
	p.X, p.Y = 200, 200

	w.SetInput("p1", 1, protocol.InputRequest{Aim: 0, Fire: true}, 1000)
	w.Step(1000)

	if len(w.bullets) != 1 {
		t.Fatalf("开火后子弹数 = %d，期望 1", len(w.bullets))
	}
	b := w.bullets[0]
	if b.Owner != "p1" {
		t.Fatalf("子弹归属 = %s，期望 p1", b.Owner)
	}
	// 枪口 200+16+4 = 220，本 tick 推进 620*0.05 = 31 -> 251
	if b.X < 248 || b.X > 254 {
		t.Fatalf("子弹 X = %v，期望约 251（已按本 tick 推进）", b.X)
	}
	if snap := w.Snapshot(); len(snap.Bullets) != 1 {
		t.Fatalf("快照子弹数 = %d，期望 1", len(snap.Bullets))
	}
}

func TestBulletHitsPlayerAndDealsDamage(t *testing.T) {
	w := NewWorld(loadTestConfig(t))
	shooter := w.AddPlayer("p1", "s1", "Alice")
	shooter.X, shooter.Y = 200, 200
	target := w.AddPlayer("p2", "s2", "Bob")
	target.X, target.Y = 300, 200
	target.InvincibleUntil = 0

	now := int64(1000)
	for i := 0; i < 5; i++ {
		w.SetInput("p1", uint64(i+1), protocol.InputRequest{Aim: 0, Fire: true}, now)
		w.Step(now)
		now += 50
	}

	if target.HP != target.MaxHP-w.cfg.Player.BulletDamage {
		t.Fatalf("目标 HP = %d，期望 %d", target.HP, target.MaxHP-w.cfg.Player.BulletDamage)
	}
	var hit *protocol.HitEvent
	for _, ev := range w.DrainEvents() {
		if ev.Type == protocol.S2CHit {
			h := ev.Data.(protocol.HitEvent)
			hit = &h
		}
	}
	if hit == nil || hit.TargetID != "p2" || hit.Damage != w.cfg.Player.BulletDamage {
		t.Fatalf("未收到正确的命中事件: %+v", hit)
	}
}

func TestKillUpdatesStatsAndRespawns(t *testing.T) {
	cfg := loadTestConfig(t)
	w := NewWorld(cfg)
	shooter := w.AddPlayer("p1", "s1", "Alice")
	shooter.X, shooter.Y = 200, 200
	target := w.AddPlayer("p2", "s2", "Bob")
	target.X, target.Y = 300, 200
	target.InvincibleUntil = 0
	target.HP = 20 // 两枪即可击杀

	now := int64(1000)
	for i := 0; i < 40 && target.Alive; i++ {
		w.SetInput("p1", uint64(i+1), protocol.InputRequest{Aim: 0, Fire: true}, now)
		w.Step(now)
		now += 50
	}
	if target.Alive {
		t.Fatal("目标应已被击杀")
	}
	if shooter.Kills != 1 || target.Deaths != 1 {
		t.Fatalf("击杀/死亡统计异常: kills=%d deaths=%d", shooter.Kills, target.Deaths)
	}

	var gotKill bool
	for _, ev := range w.DrainEvents() {
		if ev.Type == protocol.S2CKill {
			k := ev.Data.(protocol.KillEvent)
			gotKill = k.KillerID == "p1" && k.VictimID == "p2"
		}
	}
	if !gotKill {
		t.Fatal("未收到击杀事件")
	}

	// 子弹已清空，推进到复活时间之后。
	w.bullets = nil
	now = target.RespawnAt + 50
	w.Step(now)
	if !target.Alive || target.HP != target.MaxHP {
		t.Fatalf("复活失败: alive=%v hp=%d", target.Alive, target.HP)
	}
	if target.InvincibleUntil <= now {
		t.Fatal("复活后应有一段无敌时间")
	}
}

func TestBreakableObstacleBreaksAndRespawns(t *testing.T) {
	cfg := loadTestConfig(t)
	w := NewWorld(cfg)
	p := w.AddPlayer("p1", "s1", "Alice")
	p.X, p.Y = 150, 432 // 朝右正对 b_5（中心 384,432）

	now := int64(1000)
	for i := 0; i < 200; i++ {
		w.SetInput("p1", uint64(i+1), protocol.InputRequest{Aim: 0, Fire: true}, now)
		w.Step(now)
		now += 50
		var o *obstacle
		for _, ob := range w.obstacles {
			if ob.ID == "b_5" {
				o = ob
			}
		}
		if o != nil && o.Broken {
			break
		}
	}

	o := w.findObstacle("b_5")
	if o == nil || !o.Broken {
		t.Fatalf("可破坏障碍应被击碎: %+v", o)
	}
	var got bool
	for _, ev := range w.DrainEvents() {
		if ev.Type == protocol.S2CObstacleBroken && ev.Data.(protocol.ObstacleBrokenEvent).ObstacleID == "b_5" {
			got = true
		}
	}
	if !got {
		t.Fatal("未收到障碍击碎事件")
	}

	// 推进到恢复时间之后，障碍应重新出现且满血。
	w.bullets = nil
	w.Step(o.RespawnAt + 50)
	if o.Broken || o.HP != cfg.Obstacles.BreakableHp {
		t.Fatalf("障碍未恢复: broken=%v hp=%d", o.Broken, o.HP)
	}
}

func TestItemSpawnAndPickupAppliesBuff(t *testing.T) {
	cfg := loadTestConfig(t)
	w := NewWorld(cfg)
	p := w.AddPlayer("p1", "s1", "Alice")

	// 直接快进到刷新点，避免测试依赖随机等待。
	w.itemSpawnAccum = int64(cfg.Items.SpawnIntervalMs - cfg.TickMs())
	w.Step(1000)
	if len(w.items) != 1 {
		t.Fatalf("道具刷新数 = %d，期望 1", len(w.items))
	}

	it := w.items[0]
	it.Type = "power"
	p.X, p.Y = it.X, it.Y
	w.Step(1050)

	if len(w.items) != 0 {
		t.Fatal("玩家站到道具上后应被拾取")
	}
	if p.PowerUntil <= 1050 {
		t.Fatal("拾取威力道具后应获得 buff")
	}

	var got bool
	for _, ev := range w.DrainEvents() {
		if ev.Type == protocol.S2CItemPicked {
			ie := ev.Data.(protocol.ItemPickedEvent)
			got = ie.PlayerID == "p1" && ie.ItemType == "power"
		}
	}
	if !got {
		t.Fatal("未收到道具拾取事件")
	}

	snap := w.Snapshot()
	if _, ok := snap.Players[0].Buffs["power"]; !ok {
		t.Fatalf("快照应包含威力 buff: %+v", snap.Players[0].Buffs)
	}
}

// TestItemSpawnNeverOverlaps 回归：多个道具不应刷新在同一坐标上。
func TestItemSpawnNeverOverlaps(t *testing.T) {
	cfg := loadTestConfig(t)
	w := NewWorld(cfg) // 不放玩家，避免拾取干扰

	for i := 0; i < cfg.Items.MaxOnMap; i++ {
		w.itemSpawnAccum = int64(cfg.Items.SpawnIntervalMs - cfg.TickMs())
		w.Step(int64(1000 + i*50))
	}
	if len(w.items) != cfg.Items.MaxOnMap {
		t.Fatalf("道具数 = %d，期望 %d", len(w.items), cfg.Items.MaxOnMap)
	}

	seen := make(map[string]bool, len(w.items))
	for _, it := range w.items {
		key := fmt.Sprintf("%.2f,%.2f", it.X, it.Y)
		if seen[key] {
			t.Fatalf("道具坐标重复: (%v, %v)", it.X, it.Y)
		}
		seen[key] = true
	}
}

func (w *World) findObstacle(id string) *obstacle {
	for _, o := range w.obstacles {
		if o.ID == id {
			return o
		}
	}
	return nil
}

func TestSnapshotContainsPlayersAndObstacles(t *testing.T) {
	cfg := loadTestConfig(t)
	w := NewWorld(cfg)
	w.AddPlayer("p1", "s1", "Alice")
	w.AddPlayer("p2", "s2", "Bob")
	w.Step(1000)

	snap := w.Snapshot()
	if len(snap.Players) != 2 {
		t.Fatalf("快照玩家数 = %d，期望 2", len(snap.Players))
	}
	if len(snap.Obstacles) != len(cfg.Map.Obstacles) {
		t.Fatalf("快照障碍数 = %d，期望 %d", len(snap.Obstacles), len(cfg.Map.Obstacles))
	}
	if snap.Items == nil || snap.Bullets == nil {
		t.Fatal("空集合应序列化为 []，不能是 nil")
	}
}
