package game

import (
	"log"
	"sync"
	"time"

	"arena/server/internal/config"
	"arena/server/internal/protocol"
)

// Peer 是一个可接收服务端消息的连接。玩家与观战者都通过它接收快照。
type Peer interface {
	// Send 将已编码的消息放入该连接发送队列。实现方必须保证不阻塞调用方。
	Send(raw []byte)
}

type participant struct {
	peer      Peer
	name      string
	sessionID string
	// online=false 表示连接已断开、等待重连；offlineSince 记录掉线时间。
	online       bool
	offlineSince int64
}

type spectator struct {
	playerID  string
	sessionID string
	name      string
	peer      Peer
}

// PromotePeer 由能感知「观战者被补位为战斗玩家」的连接实现。
// 网关（Client）借此在补位时放开输入权限，否则补位后玩家的输入会被网关丢弃。
type PromotePeer interface {
	Peer
	SetPlaying(bool)
}

type cmdKind int

const (
	cmdJoin cmdKind = iota
	cmdSpectate
	cmdInput
	cmdLeave
	cmdDisconnect
)

type command struct {
	kind      cmdKind
	peer      Peer
	playerID  string
	sessionID string
	name      string
	seq       uint64
	input     protocol.InputRequest
	reply     chan reply
}

type reply struct {
	result   protocol.JoinResult
	roomInfo protocol.RoomInfo
}

// Room 是单个对战房间。所有世界状态只在 run goroutine 中被读写，
// 外部通过带缓冲的 command channel 与之交互。
type Room struct {
	cfg   *config.Config
	codec protocol.Codec

	cmds chan command
	quit chan struct{}
	done chan struct{}
	stopOnce sync.Once

	// 以下字段仅由 run goroutine 持有
	world        *World
	participants map[string]*participant
	spectators   []spectator
	eventSeq     uint64
	// onPlayerGone 在玩家被彻底移除（主动离开或重连超时）时回调，
	// 由装配层用于清理会话；在 Run 之前设置，只在房间 goroutine 内调用。
	onPlayerGone func(sessionID string)
}

// NewRoom 创建房间（不自动运行，调用方需 go room.Run()）。
func NewRoom(cfg *config.Config, codec protocol.Codec) *Room {
	max := cfg.Room.MaxPlayers
	return &Room{
		cfg:          cfg,
		codec:        codec,
		cmds:         make(chan command, 256),
		quit:         make(chan struct{}),
		done:         make(chan struct{}),
		world:        NewWorld(cfg),
		participants: make(map[string]*participant, max),
	}
}

// SetOnPlayerGone 注册玩家彻底离开后的回调（用于清理会话），必须在 Run 之前调用。
func (r *Room) SetOnPlayerGone(fn func(sessionID string)) {
	r.onPlayerGone = fn
}

// Run 启动房间的固定步长循环，直到 Stop 被调用。
func (r *Room) Run() {
	defer close(r.done)

	tick := time.Duration(r.cfg.TickMs()) * time.Millisecond
	ticker := time.NewTicker(tick)
	defer ticker.Stop()

	for {
		select {
		case cmd := <-r.cmds:
			r.dispatch(cmd)
		case <-ticker.C:
			now := time.Now().UnixMilli()
			r.expireDisconnected(now)
			r.world.Step(now)
			for _, ev := range r.world.DrainEvents() {
				r.cast(ev.Type, ev.Data)
			}
			r.broadcastSnapshot()
		case <-r.quit:
			return
		}
	}
}

// Stop 停止房间循环并等待其退出。
func (r *Room) Stop() {
	r.stopOnce.Do(func() { close(r.quit) })
	<-r.done
}

// Join 请求以战斗玩家身份加入房间；满员时自动转为观战排队。
func (r *Room) Join(peer Peer, playerID, sessionID, name string) (protocol.JoinResult, protocol.RoomInfo) {
	rep, ok := r.request(command{
		kind:      cmdJoin,
		peer:      peer,
		playerID:  playerID,
		sessionID: sessionID,
		name:      name,
	})
	if !ok {
		return protocol.JoinResult{Success: false, Reason: "房间已关闭"}, protocol.RoomInfo{}
	}
	return rep.result, rep.roomInfo
}

// Spectate 请求以观战者身份加入（不占用战斗位置）。
func (r *Room) Spectate(peer Peer, playerID, sessionID, name string) (protocol.JoinResult, protocol.RoomInfo) {
	rep, ok := r.request(command{
		kind:      cmdSpectate,
		peer:      peer,
		playerID:  playerID,
		sessionID: sessionID,
		name:      name,
	})
	if !ok {
		return protocol.JoinResult{Success: false, Reason: "房间已关闭"}, protocol.RoomInfo{}
	}
	return rep.result, rep.roomInfo
}

// Input 投递一帧输入。
func (r *Room) Input(playerID string, seq uint64, in protocol.InputRequest) {
	r.dispatchAsync(command{kind: cmdInput, playerID: playerID, seq: seq, input: in})
}

// Leave 让玩家离开战斗或观战队列，并返回离开后的房间信息。
func (r *Room) Leave(playerID string) protocol.RoomInfo {
	rep, ok := r.request(command{kind: cmdLeave, playerID: playerID})
	if !ok {
		return protocol.RoomInfo{}
	}
	return rep.roomInfo
}

// Disconnect 通知房间某条连接已断开。战斗玩家会被标记为离线并保留实体，
// 在 reconnectTimeoutMs 内重连可恢复；peer 用于忽略已失效连接的迟到通知。
func (r *Room) Disconnect(playerID string, peer Peer) {
	r.dispatchAsync(command{kind: cmdDisconnect, playerID: playerID, peer: peer})
}

// dispatchAsync 非阻塞投递命令；队列满时丢弃并记录（输入可丢，状态命令优先）。
func (r *Room) dispatchAsync(cmd command) {
	select {
	case r.cmds <- cmd:
	case <-r.quit:
	default:
		log.Printf("[room] 命令队列已满，丢弃 kind=%d player=%s", cmd.kind, cmd.playerID)
	}
}

// request 同步投递命令并等待房间循环处理。
func (r *Room) request(cmd command) (reply, bool) {
	cmd.reply = make(chan reply, 1)
	select {
	case r.cmds <- cmd:
	case <-r.quit:
		return reply{}, false
	}
	select {
	case rep := <-cmd.reply:
		return rep, true
	case <-r.quit:
		return reply{}, false
	}
}

func (r *Room) dispatch(cmd command) {
	switch cmd.kind {
	case cmdJoin:
		cmd.reply <- r.handleJoin(cmd)
	case cmdSpectate:
		cmd.reply <- r.handleSpectate(cmd)
	case cmdLeave:
		cmd.reply <- r.handleLeave(cmd.playerID)
	case cmdDisconnect:
		r.handleDisconnect(cmd.playerID, cmd.peer)
	case cmdInput:
		r.handleInput(cmd)
	}
}

func (r *Room) handleJoin(cmd command) reply {
	fail := func(reason string) reply {
		return reply{result: protocol.JoinResult{Success: false, Reason: reason}, roomInfo: r.roomInfo()}
	}

	if p, exists := r.participants[cmd.playerID]; exists {
		if !r.world.HasPlayer(cmd.playerID) {
			// 兜底：参与者记录还在但世界实体已丢失，重新生成。
			r.spawnPlayer(cmd.playerID, cmd.sessionID, cmd.name, cmd.peer)
			return reply{result: protocol.JoinResult{Success: true}, roomInfo: r.roomInfo()}
		}
		// 同一 playerID 再次加入视为重连：接管旧实体、位置与统计。
		p.peer = cmd.peer
		p.online = true
		p.offlineSince = 0
		if pp, ok := cmd.peer.(PromotePeer); ok {
			pp.SetPlaying(true)
		}
		log.Printf("[room] 玩家重连: %s(%s)", p.name, cmd.playerID)
		return reply{result: protocol.JoinResult{Success: true}, roomInfo: r.roomInfo()}
	}
	if r.isSpectator(cmd.playerID) {
		return fail("已在观战队列中")
	}

	if len(r.participants) < r.cfg.Room.MaxPlayers {
		r.spawnPlayer(cmd.playerID, cmd.sessionID, cmd.name, cmd.peer)
		log.Printf("[room] 玩家加入: %s(%s) %d/%d", cmd.name, cmd.playerID, len(r.participants), r.cfg.Room.MaxPlayers)
		return reply{result: protocol.JoinResult{Success: true}, roomInfo: r.roomInfo()}
	}

	// 满员：进入观战队列，位置从 1 开始。
	r.spectators = append(r.spectators, spectator{
		playerID:  cmd.playerID,
		sessionID: cmd.sessionID,
		name:      cmd.name,
		peer:      cmd.peer,
	})
	log.Printf("[room] 房间已满，%s 进入观战队列，位置 %d", cmd.name, len(r.spectators))
	return reply{
		result:   protocol.JoinResult{Success: true, Spectator: true, QueuePos: len(r.spectators)},
		roomInfo: r.roomInfo(),
	}
}

func (r *Room) handleSpectate(cmd command) reply {
	fail := func(reason string) reply {
		return reply{result: protocol.JoinResult{Success: false, Reason: reason}, roomInfo: r.roomInfo()}
	}

	if _, exists := r.participants[cmd.playerID]; exists {
		return fail("请先离开战斗")
	}
	if r.isSpectator(cmd.playerID) {
		return fail("已在观战队列中")
	}

	r.spectators = append(r.spectators, spectator{
		playerID:  cmd.playerID,
		sessionID: cmd.sessionID,
		name:      cmd.name,
		peer:      cmd.peer,
	})
	log.Printf("[room] %s 开始观战，排队位置 %d", cmd.name, len(r.spectators))
	return reply{
		result:   protocol.JoinResult{Success: true, Spectator: true, QueuePos: len(r.spectators)},
		roomInfo: r.roomInfo(),
	}
}

func (r *Room) handleInput(cmd command) {
	if _, ok := r.participants[cmd.playerID]; !ok {
		return
	}
	r.world.SetInput(cmd.playerID, cmd.seq, cmd.input, time.Now().UnixMilli())
}

func (r *Room) handleLeave(playerID string) reply {
	if p, ok := r.participants[playerID]; ok {
		delete(r.participants, playerID)
		r.world.RemovePlayer(playerID)
		r.cast(protocol.S2CPlayerLeave, protocol.PlayerLeaveEvent{ID: playerID, Name: p.name})
		log.Printf("[room] 玩家离开: %s(%s) %d/%d", p.name, playerID, len(r.participants), r.cfg.Room.MaxPlayers)
		r.notifyPlayerGone(p.sessionID)
		r.promoteSpectators()
		r.notifySpectatorPositions()
		return reply{roomInfo: r.roomInfo()}
	}

	for i, s := range r.spectators {
		if s.playerID == playerID {
			r.spectators = append(r.spectators[:i], r.spectators[i+1:]...)
			log.Printf("[room] 观战者离开: %s", s.name)
			r.notifyPlayerGone(s.sessionID)
			r.notifySpectatorPositions()
			break
		}
	}
	return reply{roomInfo: r.roomInfo()}
}

// handleDisconnect 处理连接断开：战斗玩家保留实体等待重连，观战者直接出队。
func (r *Room) handleDisconnect(playerID string, peer Peer) {
	if p, ok := r.participants[playerID]; ok {
		// 只接受当前连接的通知，避免旧连接的迟到 close 把重连后的玩家标记为离线。
		if p.peer != peer {
			return
		}
		if p.online {
			p.online = false
			p.offlineSince = time.Now().UnixMilli()
			log.Printf("[room] 玩家掉线，等待重连: %s(%s)", p.name, playerID)
		}
		return
	}

	for i, s := range r.spectators {
		if s.playerID == playerID && s.peer == peer {
			r.spectators = append(r.spectators[:i], r.spectators[i+1:]...)
			log.Printf("[room] 观战者断线离开: %s", s.name)
			r.notifyPlayerGone(s.sessionID)
			r.notifySpectatorPositions()
			return
		}
	}
}

// expireDisconnected 在重连超时后释放离线玩家的战斗位置。
func (r *Room) expireDisconnected(now int64) {
	timeout := int64(r.cfg.Room.ReconnectTimeoutMs)
	if timeout <= 0 {
		return
	}

	var expired []string
	for id, p := range r.participants {
		if !p.online && now-p.offlineSince >= timeout {
			expired = append(expired, id)
		}
	}
	for _, id := range expired {
		p := r.participants[id]
		delete(r.participants, id)
		r.world.RemovePlayer(id)
		r.cast(protocol.S2CPlayerLeave, protocol.PlayerLeaveEvent{ID: id, Name: p.name})
		log.Printf("[room] 重连超时，释放位置: %s(%s)", p.name, id)
		r.notifyPlayerGone(p.sessionID)
	}
	if len(expired) > 0 {
		r.promoteSpectators()
		r.notifySpectatorPositions()
	}
}

func (r *Room) notifyPlayerGone(sessionID string) {
	if r.onPlayerGone != nil && sessionID != "" {
		r.onPlayerGone(sessionID)
	}
}

// notifySpectatorPositions 在队列变化后，把最新排队序号推给仍在排队的观战者。
func (r *Room) notifySpectatorPositions() {
	for i, s := range r.spectators {
		r.sendTo(s.peer, protocol.S2CJoinResult, protocol.JoinResult{
			Success:   true,
			Spectator: true,
			QueuePos:  i + 1,
		})
	}
}

// spawnPlayer 在世界上创建玩家并登记连接，同时广播加入事件。
func (r *Room) spawnPlayer(playerID, sessionID, name string, peer Peer) {
	p := r.world.AddPlayer(playerID, sessionID, name)
	// 出生保护：与 P1 一致，入场后短暂无敌。
	p.InvincibleUntil = time.Now().UnixMilli() + int64(r.cfg.Player.InvincibleAfterRespawnMs)
	r.participants[playerID] = &participant{
		peer:      peer,
		name:      name,
		sessionID: sessionID,
		online:    true,
	}
	r.cast(protocol.S2CPlayerJoin, protocol.PlayerJoinEvent{ID: playerID, Name: name})
}

// promoteSpectators 在空出位置后，按队列顺序把观战者转为玩家。
func (r *Room) promoteSpectators() {
	for len(r.participants) < r.cfg.Room.MaxPlayers && len(r.spectators) > 0 {
		s := r.spectators[0]
		r.spectators = r.spectators[1:]

		// 先放开该连接的输入权限，再通知本人成为玩家，最后广播加入事件；
		// 顺序保证客户端收到补位通知后上报的输入不会被网关丢弃。
		if pp, ok := s.peer.(PromotePeer); ok {
			pp.SetPlaying(true)
		}
		r.sendTo(s.peer, protocol.S2CJoinResult, protocol.JoinResult{Success: true})
		r.spawnPlayer(s.playerID, s.sessionID, s.name, s.peer)
		r.sendTo(s.peer, protocol.S2CRoomInfo, r.roomInfo())
		log.Printf("[room] 观战者补位: %s(%s)", s.name, s.playerID)
	}
}

func (r *Room) isSpectator(playerID string) bool {
	for _, s := range r.spectators {
		if s.playerID == playerID {
			return true
		}
	}
	return false
}

func (r *Room) roomInfo() protocol.RoomInfo {
	return protocol.RoomInfo{
		PlayerCount:    len(r.participants),
		MaxPlayers:     r.cfg.Room.MaxPlayers,
		SpectatorCount: len(r.spectators),
		QueueCount:     len(r.spectators),
		InGame:         true,
	}
}

// broadcastSnapshot 每 tick 向所有参与者广播一次全量快照。
func (r *Room) broadcastSnapshot() {
	if len(r.participants) == 0 && len(r.spectators) == 0 {
		return
	}
	snap := r.world.Snapshot()
	raw, err := r.codec.Encode(protocol.S2CSnapshot, snap.Tick, snap)
	if err != nil {
		log.Printf("[room] 快照编码失败: %v", err)
		return
	}

	for _, p := range r.participants {
		if p.online {
			p.peer.Send(raw)
		}
	}
	for _, s := range r.spectators {
		s.peer.Send(raw)
	}
}

// cast 广播一次性事件。
func (r *Room) cast(msgType string, data any) {
	r.eventSeq++
	raw, err := r.codec.Encode(msgType, r.eventSeq, data)
	if err != nil {
		log.Printf("[room] 事件编码失败 type=%s: %v", msgType, err)
		return
	}
	for _, p := range r.participants {
		if p.online {
			p.peer.Send(raw)
		}
	}
	for _, s := range r.spectators {
		s.peer.Send(raw)
	}
}

// sendTo 向单个连接发送消息。
func (r *Room) sendTo(peer Peer, msgType string, data any) {
	r.eventSeq++
	raw, err := r.codec.Encode(msgType, r.eventSeq, data)
	if err != nil {
		log.Printf("[room] 消息编码失败 type=%s: %v", msgType, err)
		return
	}
	peer.Send(raw)
}
