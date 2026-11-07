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
	peer Peer
	name string
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
			r.world.Step(time.Now().UnixMilli())
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
	case cmdInput:
		r.handleInput(cmd)
	}
}

func (r *Room) handleJoin(cmd command) reply {
	fail := func(reason string) reply {
		return reply{result: protocol.JoinResult{Success: false, Reason: reason}, roomInfo: r.roomInfo()}
	}

	if _, exists := r.participants[cmd.playerID]; exists {
		return fail("已在房间中")
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
	if _, ok := r.participants[playerID]; ok {
		name, _ := r.world.NameOf(playerID)
		delete(r.participants, playerID)
		r.world.RemovePlayer(playerID)
		r.cast(protocol.S2CPlayerLeave, protocol.PlayerLeaveEvent{ID: playerID, Name: name})
		log.Printf("[room] 玩家离开: %s(%s) %d/%d", name, playerID, len(r.participants), r.cfg.Room.MaxPlayers)
		r.promoteSpectators()
		r.notifySpectatorPositions()
		return reply{roomInfo: r.roomInfo()}
	}

	for i, s := range r.spectators {
		if s.playerID == playerID {
			r.spectators = append(r.spectators[:i], r.spectators[i+1:]...)
			log.Printf("[room] 观战者离开: %s", s.name)
			r.notifySpectatorPositions()
			break
		}
	}
	return reply{roomInfo: r.roomInfo()}
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
	r.participants[playerID] = &participant{peer: peer, name: name}
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
		p.peer.Send(raw)
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
		p.peer.Send(raw)
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
