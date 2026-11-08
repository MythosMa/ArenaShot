// Package protocol 定义客户端与服务端之间的消息类型与封套。
//
// 当前使用 JSON 编码。所有业务代码只依赖本包暴露的结构与编解码接口，
// 未来切换 Protobuf 时只需替换 codec.go，不影响房间与战斗逻辑。
package protocol

import "encoding/json"

// 客户端 -> 服务端 消息类型。
const (
	C2SLogin    = "c2s_login"    // 登录/重连
	C2SInput    = "c2s_input"    // 操作输入
	C2SJoin     = "c2s_join"     // 请求加入战斗
	C2SPing     = "c2s_ping"     // 心跳与 RTT 测量
	C2SLeave    = "c2s_leave"    // 主动离开
	C2SSpectate = "c2s_spectate" // 请求观战
)

// 服务端 -> 客户端 消息类型。
const (
	S2CLoginOK        = "s2c_login_ok"
	S2CRoomInfo       = "s2c_room_info"
	S2CJoinResult     = "s2c_join_result"
	S2CSnapshot       = "s2c_snapshot"
	S2CHit            = "s2c_hit"
	S2CKill           = "s2c_kill"
	S2CObstacleBroken = "s2c_obstacle_broken"
	S2CItemPicked     = "s2c_item_picked"
	S2CPlayerJoin     = "s2c_player_join"
	S2CPlayerLeave    = "s2c_player_leave"
	S2CLeaderboard    = "s2c_leaderboard"
	S2CPong           = "s2c_pong"
	S2CError          = "s2c_error"
	S2CKick           = "s2c_kick"
)

// Envelope 是所有消息的统一封套。
//
//	{ "type": "c2s_input", "seq": 42, "data": { ... } }
type Envelope struct {
	Type string          `json:"type"`
	Seq  uint64          `json:"seq"`
	Data json.RawMessage `json:"data,omitempty"`
}

// LoginRequest 登录请求。SessionID 为空表示新玩家，非空表示断线重连。
type LoginRequest struct {
	Name      string `json:"name"`
	SessionID string `json:"sessionId,omitempty"`
}

// LoginResponse 登录成功响应。
type LoginResponse struct {
	PlayerID      string `json:"playerId"`
	SessionID     string `json:"sessionId"`
	ConfigVersion int    `json:"configVersion"`
	ServerTime    int64  `json:"serverTime"`
}

// InputRequest 单帧操作输入。所有字段都只是「意图」，最终结果由服务端计算。
type InputRequest struct {
	MoveX      float64 `json:"moveX"` // -1 ~ 1
	MoveY      float64 `json:"moveY"` // -1 ~ 1
	Aim        float64 `json:"aim"`   // 弧度
	Fire       bool    `json:"fire"`
	UseItem    bool    `json:"useItem"`
	ClientTime int64   `json:"clientTime"` // 客户端本地时间，用于延迟统计
}

// PingRequest 心跳请求。
type PingRequest struct {
	ClientTime int64 `json:"clientTime"`
}

// PongResponse 心跳响应。
type PongResponse struct {
	ClientTime int64 `json:"clientTime"`
	ServerTime int64 `json:"serverTime"`
}

// Vec2 协议层二维坐标。
type Vec2 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// PlayerSnapshot 玩家在某一帧的状态。
type PlayerSnapshot struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	X         float64          `json:"x"`
	Y         float64          `json:"y"`
	Aim       float64          `json:"aim"`
	Hp        int              `json:"hp"`
	MaxHp     int              `json:"maxHp"`
	Alive     bool             `json:"alive"`
	RespawnAt int64            `json:"respawnAt"` // 复活时间戳（毫秒），未死亡为 0
	Buffs     map[string]int64 `json:"buffs"`     // buff 名称 -> 结束时间戳
	Kills     int              `json:"kills"`
	Deaths    int              `json:"deaths"`
	// LastProcessedSeq 是该玩家被服务端接受的最后一个输入封套序号，
	// 用于客户端预测回滚/校正。按玩家下发，避免与其他人的输入混在一起。
	LastProcessedSeq uint64 `json:"lastProcessedSeq"`
}

// BulletSnapshot 子弹状态。
type BulletSnapshot struct {
	ID    string  `json:"id"`
	Owner string  `json:"owner"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	VX    float64 `json:"vx"`
	VY    float64 `json:"vy"`
}

// ObstacleSnapshot 障碍状态。
type ObstacleSnapshot struct {
	ID        string `json:"id"`
	Type      string `json:"type"` // solid | breakable
	Broken    bool   `json:"broken"`
	Hp        int    `json:"hp"`
	RespawnAt int64  `json:"respawnAt"`
}

// ItemSnapshot 地图上的道具。
type ItemSnapshot struct {
	ID   string  `json:"id"`
	Type string  `json:"type"` // heal | power | speed
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
}

// LeaderboardEntry 排行榜条目。
type LeaderboardEntry struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Kills  int    `json:"kills"`
	Deaths int    `json:"deaths"`
}

// Snapshot 全量世界快照。4 人规模下全量广播最简单也最稳。
type Snapshot struct {
	Tick        uint64             `json:"tick"`
	ServerTime  int64              `json:"serverTime"`
	Players     []PlayerSnapshot   `json:"players"`
	Bullets     []BulletSnapshot   `json:"bullets"`
	Obstacles   []ObstacleSnapshot `json:"obstacles"`
	Items       []ItemSnapshot     `json:"items"`
	Leaderboard []LeaderboardEntry `json:"leaderboard"`
}

// HitEvent 命中事件，用于播放受击表现。
type HitEvent struct {
	ShooterID string  `json:"shooterId"`
	TargetID  string  `json:"targetId"`
	Damage    int     `json:"damage"`
	X         float64 `json:"x"`
	Y         float64 `json:"y"`
}

// KillEvent 击杀事件。
type KillEvent struct {
	KillerID   string `json:"killerId"`
	KillerName string `json:"killerName"`
	VictimID   string `json:"victimId"`
	VictimName string `json:"victimName"`
}

// ObstacleBrokenEvent 障碍被击碎事件。
type ObstacleBrokenEvent struct {
	ObstacleID string  `json:"obstacleId"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
}

// ItemPickedEvent 道具被拾取事件。
type ItemPickedEvent struct {
	PlayerID string  `json:"playerId"`
	ItemID   string  `json:"itemId"`
	ItemType string  `json:"itemType"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
}

// PlayerJoinEvent 玩家加入事件。
type PlayerJoinEvent struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// PlayerLeaveEvent 玩家离开事件。
type PlayerLeaveEvent struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// RoomInfo 房间信息。
type RoomInfo struct {
	PlayerCount    int  `json:"playerCount"`
	MaxPlayers     int  `json:"maxPlayers"`
	SpectatorCount int  `json:"spectatorCount"`
	QueueCount     int  `json:"queueCount"`
	InGame         bool `json:"inGame"`
}

// JoinResult 加入结果。
type JoinResult struct {
	Success   bool   `json:"success"`
	Spectator bool   `json:"spectator"`
	QueuePos  int    `json:"queuePos"` // 排队位置，0 表示无需排队
	Reason    string `json:"reason,omitempty"`
}

// ErrorMessage 错误消息。
type ErrorMessage struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// KickMessage 踢出消息。
type KickMessage struct {
	Reason string `json:"reason"`
}
