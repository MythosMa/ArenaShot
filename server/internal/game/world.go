// Package game 实现服务器权威的世界模拟与房间循环。
//
// 设计约定：
//   - 世界状态只由房间 goroutine 持有，避免锁竞争；
//   - 客户端输入只代表「意图」，位置、射击、伤害全部由本包计算；
//   - 战斗规则与 P1 客户端 LocalMockDriver 一致（圆-AABB 碰撞、无敌窗、
//     威力/加速 buff、道具触碰拾取等），视图层因此无需改动。
package game

import (
	"fmt"
	"math"
	"math/rand"
	"sort"

	"arena/server/internal/config"
	"arena/server/internal/protocol"
)

// inputStaleMs 输入过期时间：超过该时长未收到新输入，视为停止移动，
// 避免客户端断线或卡顿时角色继续漂移。
const inputStaleMs = 500

// Player 是一名战斗玩家的权威状态。
type Player struct {
	ID        string
	Name      string
	SessionID string

	X   float64
	Y   float64
	Aim float64

	HP    int
	MaxHP int
	Alive bool

	RespawnAt int64 // 毫秒时间戳，0 表示不需要复活
	Kills     int
	Deaths    int

	// 战斗运行时状态（毫秒时间戳 / 剩余毫秒）
	FireCdRemainMs   float64 // 距下一次开火还需经过的毫秒
	InvincibleUntil  int64   // 无敌截止时间（出生/复活后短暂无敌）
	PowerUntil       int64   // 威力 buff 截止时间
	SpeedUntil       int64   // 加速 buff 截止时间

	// 运行时输入状态
	input        protocol.InputRequest
	lastInputAt  int64
	lastInputSeq uint64
	rateWindow   int64
	rateCount    int
}

// Snapshot 生成协议层玩家快照。nowMs 用于过滤已过期的 buff。
func (p *Player) Snapshot(nowMs int64) protocol.PlayerSnapshot {
	buffs := make(map[string]int64)
	if p.PowerUntil > nowMs {
		buffs["power"] = p.PowerUntil
	}
	if p.SpeedUntil > nowMs {
		buffs["speed"] = p.SpeedUntil
	}
	if p.InvincibleUntil > nowMs {
		buffs["invincible"] = p.InvincibleUntil
	}
	return protocol.PlayerSnapshot{
		ID:        p.ID,
		Name:      p.Name,
		X:         p.X,
		Y:         p.Y,
		Aim:       p.Aim,
		Hp:        p.HP,
		MaxHp:     p.MaxHP,
		Alive:     p.Alive,
		RespawnAt: p.RespawnAt,
		Buffs:     buffs,
		Kills:     p.Kills,
		Deaths:    p.Deaths,
	}
}

// bullet 是飞行中的子弹。位置与方向由服务端权威计算。
type bullet struct {
	ID     string
	Owner  string
	X, Y   float64
	VX, VY float64
	Radius float64
	LifeMs int64
}

// item 是地图上的可拾取道具。
type item struct {
	ID   string
	Type string // heal | power | speed
	X, Y float64
}

// WorldEvent 是一次性事件（命中/击杀/道具/障碍破碎），由房间在 tick 后广播。
type WorldEvent struct {
	Type string
	Data any
}

// obstacle 是地图上的静态障碍，可能为可破坏类型。
type obstacle struct {
	ID        string
	Type      string // solid | breakable
	X, Y      float64 // 中心点
	W, H      float64
	HP        int
	Broken    bool
	RespawnAt int64
}

// World 是房间内的全部权威状态。
type World struct {
	cfg      *config.Config
	tick     uint64
	nowMs    int64
	players  map[string]*Player
	obstacles []*obstacle
	bullets  []*bullet
	items    []*item
	events   []WorldEvent

	itemSpawnAccum int64
	bulletSeq      uint64
	itemSeq        uint64
	processedInputs uint64
}

// NewWorld 依据配置初始化世界与静态障碍。
func NewWorld(cfg *config.Config) *World {
	w := &World{
		cfg:     cfg,
		players: make(map[string]*Player),
	}
	for _, def := range cfg.Map.Obstacles {
		w.obstacles = append(w.obstacles, &obstacle{
			ID:   def.ID,
			Type: def.Type,
			X:    def.X,
			Y:    def.Y,
			W:    def.W,
			H:    def.H,
			HP:   cfg.Obstacles.BreakableHp,
		})
	}
	return w
}

// Tick 返回当前逻辑帧号。
func (w *World) Tick() uint64 { return w.tick }

// PlayerCount 返回当前战斗人数。
func (w *World) PlayerCount() int { return len(w.players) }

// AddPlayer 将玩家放入世界。出生点选离其他玩家最远的一个，出生后短暂无敌。
func (w *World) AddPlayer(id, sessionID, name string) *Player {
	spawn := w.chooseSpawn()
	p := &Player{
		ID:        id,
		Name:      name,
		SessionID: sessionID,
		X:         spawn.X,
		Y:         spawn.Y,
		HP:        w.cfg.Player.MaxHp,
		MaxHP:     w.cfg.Player.MaxHp,
		Alive:     true,
	}
	w.players[id] = p
	return p
}

// RemovePlayer 移除玩家并返回其名字，用于广播离开事件。
func (w *World) RemovePlayer(id string) (string, bool) {
	p, ok := w.players[id]
	if !ok {
		return "", false
	}
	delete(w.players, id)
	return p.Name, true
}

// HasPlayer 判断玩家是否仍在世界中。
func (w *World) HasPlayer(id string) bool {
	_, ok := w.players[id]
	return ok
}

// NameOf 返回玩家名字。
func (w *World) NameOf(id string) (string, bool) {
	p, ok := w.players[id]
	if !ok {
		return "", false
	}
	return p.Name, true
}

// SetInput 写入一帧输入。返回 false 表示输入被频率限制或玩家无效。
func (w *World) SetInput(id string, seq uint64, in protocol.InputRequest, nowMs int64) bool {
	p, ok := w.players[id]
	if !ok || !p.Alive {
		return false
	}

	// 频率节流：每秒最多 maxInputsPerSecond 个输入包，超出直接丢弃。
	if nowMs-p.rateWindow >= 1000 {
		p.rateWindow = nowMs
		p.rateCount = 0
	}
	if p.rateCount >= w.cfg.Room.MaxInputsPerSecond {
		return false
	}
	p.rateCount++

	in.MoveX = sanitizeAxis(in.MoveX)
	in.MoveY = sanitizeAxis(in.MoveY)
	in.Aim = sanitizeAngle(in.Aim)
	in.ClientTime = 0 // 服务端不采信客户端时间，仅用于 RTT 统计时另行处理

	p.input = in
	p.lastInputAt = nowMs
	p.lastInputSeq = seq
	w.processedInputs++
	return true
}

// DrainEvents 返回并清空本 tick 累积的一次性事件，供房间广播。
func (w *World) DrainEvents() []WorldEvent {
	evs := w.events
	w.events = nil
	return evs
}

// Step 推进一个逻辑帧。顺序与 P1 LocalMockDriver 对齐：
// 移动与射击 -> 冷却递减 -> 复活 -> 子弹推进 -> 障碍恢复 -> 道具刷新与拾取。
func (w *World) Step(nowMs int64) {
	w.tick++
	w.nowMs = nowMs
	if nowMs == 0 {
		return
	}
	dt := w.cfg.TickSeconds()

	// 1. 玩家移动 + 射击（仅处理「新鲜」输入）
	for _, id := range w.sortedPlayerIDs() {
		p := w.players[id]
		if !p.Alive || nowMs-p.lastInputAt > inputStaleMs {
			continue
		}
		p.Aim = p.input.Aim
		mx, my := normalizeMove(p.input.MoveX, p.input.MoveY)
		if mx != 0 || my != 0 {
			speed := w.moveSpeedOf(p)
			w.tryMove(p, mx*speed*dt, my*speed*dt)
		}
		if p.input.Fire && p.FireCdRemainMs <= 0 {
			w.shoot(p)
		}
	}

	// 2. 冷却递减
	for _, p := range w.players {
		if p.FireCdRemainMs > 0 {
			p.FireCdRemainMs = math.Max(0, p.FireCdRemainMs-float64(w.cfg.TickMs()))
		}
	}

	// 3. 复活
	for _, p := range w.players {
		if !p.Alive && nowMs >= p.RespawnAt {
			w.respawn(p)
		}
	}

	// 4. 子弹推进
	w.stepBullets(dt)

	// 5. 障碍定时恢复
	for _, o := range w.obstacles {
		if o.Broken && nowMs >= o.RespawnAt {
			o.Broken = false
			o.HP = w.cfg.Obstacles.BreakableHp
		}
	}

	// 6. 道具刷新与拾取
	w.stepItemSpawn()
	w.stepItemPickup()
}

// Snapshot 生成当前世界的全量快照。
func (w *World) Snapshot() protocol.Snapshot {
	ids := w.sortedPlayerIDs()

	players := make([]protocol.PlayerSnapshot, 0, len(ids))
	leaderboard := make([]protocol.LeaderboardEntry, 0, len(ids))
	for _, id := range ids {
		p := w.players[id]
		players = append(players, p.Snapshot(w.nowMs))
		leaderboard = append(leaderboard, protocol.LeaderboardEntry{
			ID:     p.ID,
			Name:   p.Name,
			Kills:  p.Kills,
			Deaths: p.Deaths,
		})
	}
	sort.SliceStable(leaderboard, func(i, j int) bool {
		if leaderboard[i].Kills != leaderboard[j].Kills {
			return leaderboard[i].Kills > leaderboard[j].Kills
		}
		return leaderboard[i].Deaths < leaderboard[j].Deaths
	})

	obstacles := make([]protocol.ObstacleSnapshot, 0, len(w.obstacles))
	for _, o := range w.obstacles {
		obstacles = append(obstacles, protocol.ObstacleSnapshot{
			ID:        o.ID,
			Type:      o.Type,
			Broken:    o.Broken,
			Hp:        o.HP,
			RespawnAt: o.RespawnAt,
		})
	}

	bullets := make([]protocol.BulletSnapshot, 0, len(w.bullets))
	for _, b := range w.bullets {
		bullets = append(bullets, protocol.BulletSnapshot{
			ID:    b.ID,
			Owner: b.Owner,
			X:     b.X,
			Y:     b.Y,
			VX:    b.VX,
			VY:    b.VY,
		})
	}

	items := make([]protocol.ItemSnapshot, 0, len(w.items))
	for _, it := range w.items {
		items = append(items, protocol.ItemSnapshot{ID: it.ID, Type: it.Type, X: it.X, Y: it.Y})
	}

	return protocol.Snapshot{
		Tick:             w.tick,
		ServerTime:       w.nowMs,
		LastProcessedSeq: w.processedInputs,
		Players:          players,
		Bullets:          bullets,
		Obstacles:        obstacles,
		Items:            items,
		Leaderboard:      leaderboard,
	}
}

// ---------------- 战斗核心 ----------------

// shoot 按玩家朝向在枪口位置生成一颗子弹并设置开火冷却。
func (w *World) shoot(p *Player) {
	pc := w.cfg.Player
	p.FireCdRemainMs = float64(pc.FireIntervalMs)

	// 枪口：身体边缘 + 4px，与 P1 一致。
	c := math.Cos(p.Aim)
	s := math.Sin(p.Aim)
	muzzle := pc.Radius + 4
	w.bulletSeq++
	w.bullets = append(w.bullets, &bullet{
		ID:     fmt.Sprintf("b_%d", w.bulletSeq),
		Owner:  p.ID,
		X:      p.X + c*muzzle,
		Y:      p.Y + s*muzzle,
		VX:     c * pc.BulletSpeed,
		VY:     s * pc.BulletSpeed,
		Radius: pc.Radius * 0.4,
		LifeMs: int64(pc.BulletLifeMs),
	})
}

func (w *World) stepBullets(dt float64) {
	stepMs := int64(w.cfg.TickMs())
	next := make([]*bullet, 0, len(w.bullets))
	for _, b := range w.bullets {
		b.LifeMs -= stepMs
		if b.LifeMs <= 0 {
			continue
		}
		if w.advanceBullet(b, dt) {
			next = append(next, b)
		}
	}
	w.bullets = next
}

// advanceBullet 用一个 tick 内的子步推进子弹。
// 20Hz 下子弹每个 tick 走 31px，若只在 tick 末尾采样，擦边命中可能被跳过；
// 按 ≤8px 的子步推进后，命中判定宽度远小于步长，射击手感与 P1（60fps）一致。
// 返回 false 表示子弹在本 tick 内消失（越界或命中）。
func (w *World) advanceBullet(b *bullet, dt float64) bool {
	const maxSubStep = 8.0

	dist := math.Hypot(b.VX, b.VY) * dt
	steps := int(math.Ceil(dist / maxSubStep))
	if steps < 1 {
		steps = 1
	}
	sdt := dt / float64(steps)

	for i := 0; i < steps; i++ {
		nx := b.X + b.VX*sdt
		ny := b.Y + b.VY*sdt

		// 越界消失
		if nx < 0 || ny < 0 || nx > w.cfg.Map.Width || ny > w.cfg.Map.Height {
			return false
		}

		// 命中障碍：可破坏障碍掉血，子弹无论命中何种障碍都消失。
		if ob := w.blockingObstacle(nx, ny, b.Radius); ob != nil {
			if ob.Type == "breakable" && !ob.Broken {
				w.damageObstacle(ob)
			}
			return false
		}

		// 命中玩家（不包括发射者自己，也不打尸体）
		if target := w.bulletHit(b, nx, ny); target != nil {
			w.damagePlayer(target, b.Owner, nx, ny)
			return false
		}

		b.X = nx
		b.Y = ny
	}
	return true
}

func (w *World) bulletHit(b *bullet, nx, ny float64) *Player {
	for _, p := range w.players {
		if p.ID == b.Owner || !p.Alive {
			continue
		}
		if math.Hypot(p.X-nx, p.Y-ny) < w.cfg.Player.Radius + b.Radius {
			return p
		}
	}
	return nil
}

func (w *World) damagePlayer(target *Player, shooterID string, x, y float64) {
	if target.InvincibleUntil > w.nowMs {
		return
	}

	base := float64(w.cfg.Player.BulletDamage)
	if shooter := w.players[shooterID]; shooter != nil && shooter.PowerUntil > w.nowMs {
		base *= w.cfg.Items.PowerMultiplier
	}

	target.HP -= int(base)
	w.events = append(w.events, WorldEvent{protocol.S2CHit, protocol.HitEvent{
		ShooterID: shooterID,
		TargetID:  target.ID,
		Damage:    int(math.Round(base)),
		X:         x,
		Y:         y,
	}})

	if target.HP <= 0 {
		target.Alive = false
		target.RespawnAt = w.nowMs + int64(w.cfg.Room.RespawnDelayMs)
		target.Deaths++
		if shooter := w.players[shooterID]; shooter != nil {
			shooter.Kills++
			w.events = append(w.events, WorldEvent{protocol.S2CKill, protocol.KillEvent{
				KillerID:   shooter.ID,
				KillerName: shooter.Name,
				VictimID:   target.ID,
				VictimName: target.Name,
			}})
		}
	}
}

func (w *World) damageObstacle(o *obstacle) {
	o.HP -= w.cfg.Player.BulletDamage
	if o.HP <= 0 {
		o.Broken = true
		o.RespawnAt = w.nowMs + int64(w.cfg.Obstacles.RespawnMs)
		w.events = append(w.events, WorldEvent{protocol.S2CObstacleBroken, protocol.ObstacleBrokenEvent{
			ObstacleID: o.ID,
			X:          o.X,
			Y:          o.Y,
		}})
	}
}

func (w *World) respawn(p *Player) {
	sp := w.chooseSpawn()
	p.X = sp.X
	p.Y = sp.Y
	p.HP = p.MaxHP
	p.Alive = true
	p.RespawnAt = 0
	p.InvincibleUntil = w.nowMs + int64(w.cfg.Player.InvincibleAfterRespawnMs)
}

// ---------------- 道具 ----------------

func (w *World) stepItemSpawn() {
	cfg := w.cfg.Items
	w.itemSpawnAccum += int64(w.cfg.TickMs())
	if w.itemSpawnAccum < int64(cfg.SpawnIntervalMs) {
		return
	}
	w.itemSpawnAccum = 0
	if len(w.items) >= cfg.MaxOnMap {
		return
	}
	pts := w.cfg.Map.ItemSpawnPoints
	if len(pts) == 0 {
		return
	}

	// 只在空闲刷新点里随机，避免同一坐标叠加多个道具。
	free := make([]int, 0, len(pts))
	for i, p := range pts {
		occupied := false
		for _, it := range w.items {
			if math.Abs(it.X-p.X) < 0.5 && math.Abs(it.Y-p.Y) < 0.5 {
				occupied = true
				break
			}
		}
		if !occupied {
			free = append(free, i)
		}
	}
	if len(free) == 0 {
		// 刷新点已全部被占用，本轮跳过，下个周期再试。
		return
	}
	pt := pts[free[rand.Intn(len(free))]]
	w.itemSeq++
	w.items = append(w.items, &item{
		ID:   fmt.Sprintf("i_%d", w.itemSeq),
		Type: []string{"heal", "power", "speed"}[rand.Intn(3)],
		X:    pt.X,
		Y:    pt.Y,
	})
}

func (w *World) stepItemPickup() {
	rad := w.cfg.Player.Radius + 24
	for i := len(w.items) - 1; i >= 0; i-- {
		it := w.items[i]
		for _, p := range w.players {
			if !p.Alive {
				continue
			}
			if math.Hypot(p.X-it.X, p.Y-it.Y) < rad {
				w.applyItem(p, it.Type)
				w.events = append(w.events, WorldEvent{protocol.S2CItemPicked, protocol.ItemPickedEvent{
					PlayerID: p.ID,
					ItemID:   it.ID,
					ItemType: it.Type,
					X:        it.X,
					Y:        it.Y,
				}})
				w.items = append(w.items[:i], w.items[i+1:]...)
				break
			}
		}
	}
}

func (w *World) applyItem(p *Player, typ string) {
	cfg := w.cfg.Items
	switch typ {
	case "heal":
		p.HP = min(p.MaxHP, p.HP+cfg.HealAmount)
	case "power":
		p.PowerUntil = w.nowMs + int64(cfg.PowerDurationMs)
	case "speed":
		p.SpeedUntil = w.nowMs + int64(cfg.SpeedDurationMs)
	}
}

// moveSpeedOf 返回玩家当前移动速度（加速 buff 生效时放大）。
func (w *World) moveSpeedOf(p *Player) float64 {
	speed := w.cfg.Player.MoveSpeed
	if p.SpeedUntil > w.nowMs {
		speed *= w.cfg.Items.SpeedMultiplier
	}
	return speed
}

// ---------------- 内部实现 ----------------

func (w *World) sortedPlayerIDs() []string {
	ids := make([]string, 0, len(w.players))
	for id := range w.players {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// chooseSpawn 选择离现有玩家最远的出生点，降低出生即被攻击的概率。
func (w *World) chooseSpawn() config.Vec2 {
	spawns := w.cfg.Map.SpawnPoints
	best := spawns[0]
	bestDist := -1.0

	for _, s := range spawns {
		dmin := math.Inf(1)
		for _, p := range w.players {
			if d := math.Hypot(p.X-s.X, p.Y-s.Y); d < dmin {
				dmin = d
			}
		}
		// 没有其他玩家时 dmin 为正无穷，第一个出生点会保持选中。
		if dmin > bestDist {
			bestDist = dmin
			best = s
		}
	}
	return best
}

// tryMove 分轴移动，实现贴墙滑动；最后夹紧到地图边界。
func (w *World) tryMove(p *Player, dx, dy float64) {
	r := w.cfg.Player.Radius
	if dx != 0 {
		nx := p.X + dx
		if !w.blocked(nx, p.Y, r) {
			p.X = nx
		}
	}
	if dy != 0 {
		ny := p.Y + dy
		if !w.blocked(p.X, ny, r) {
			p.Y = ny
		}
	}

	p.X = clamp(p.X, r, w.cfg.Map.Width-r)
	p.Y = clamp(p.Y, r, w.cfg.Map.Height-r)
}

// blocked 判断圆形是否与任一未破坏障碍重叠。
func (w *World) blocked(x, y, r float64) bool {
	return w.blockingObstacle(x, y, r) != nil
}

// blockingObstacle 返回与圆形重叠的第一个未破坏障碍。
func (w *World) blockingObstacle(x, y, r float64) *obstacle {
	for _, o := range w.obstacles {
		if o.Type == "breakable" && o.Broken {
			continue
		}
		if circleRectOverlap(x, y, r, o.X-o.W/2, o.Y-o.H/2, o.W, o.H) {
			return o
		}
	}
	return nil
}

func circleRectOverlap(cx, cy, cr, rx, ry, rw, rh float64) bool {
	nx := clamp(cx, rx, rx+rw)
	ny := clamp(cy, ry, ry+rh)
	return math.Hypot(cx-nx, cy-ny) <= cr
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func sanitizeAxis(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return clamp(v, -1, 1)
}

func sanitizeAngle(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

// normalizeMove 限制输入向量长度不超过 1，斜向移动不会更快。
func normalizeMove(x, y float64) (float64, float64) {
	length := math.Hypot(x, y)
	if length > 1 {
		return x / length, y / length
	}
	return x, y
}