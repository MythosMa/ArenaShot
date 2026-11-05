// Package config 负责加载与校验游戏配置。
// 配置文件是客户端与服务端的唯一数值来源，双端必须使用同一份内容。
package config

import (
	"encoding/json"
	"fmt"
	"os"
)

// Vec2 二维坐标，单位：像素。
type Vec2 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// RoomConfig 房间相关参数。
type RoomConfig struct {
	MaxPlayers           int `json:"maxPlayers"`           // 房间内最大战斗人数
	TickRate             int `json:"tickRate"`             // 服务器逻辑帧率（Hz）
	RespawnDelayMs       int `json:"respawnDelayMs"`       // 死亡后复活延迟（毫秒）
	ReconnectTimeoutMs   int `json:"reconnectTimeoutMs"`   // 断线重连保留时间（毫秒）
	SnapshotIntervalMs   int `json:"snapshotIntervalMs"`   // 快照广播间隔（毫秒）
	MaxInputsPerSecond   int `json:"maxInputsPerSecond"`   // 单玩家每秒输入包上限（防刷）
}

// PlayerConfig 玩家与武器的数值。
type PlayerConfig struct {
	MaxHp                   int     `json:"maxHp"`
	MoveSpeed               float64 `json:"moveSpeed"`               // 像素/秒
	Radius                  float64 `json:"radius"`                  // 碰撞半径
	FireIntervalMs          int     `json:"fireIntervalMs"`          // 射击冷却
	BulletSpeed             float64 `json:"bulletSpeed"`             // 像素/秒
	BulletDamage            int     `json:"bulletDamage"`
	BulletLifeMs            int     `json:"bulletLifeMs"`            // 子弹存活时间
	InvincibleAfterRespawnMs int    `json:"invincibleAfterRespawnMs"`
}

// ItemsConfig 道具与 Buff 参数。
type ItemsConfig struct {
	SpawnIntervalMs    int     `json:"spawnIntervalMs"`
	MaxOnMap           int     `json:"maxOnMap"`
	HealAmount         int     `json:"healAmount"`
	PowerMultiplier    float64 `json:"powerMultiplier"`
	PowerDurationMs    int     `json:"powerDurationMs"`
	SpeedMultiplier    float64 `json:"speedMultiplier"`
	SpeedDurationMs    int     `json:"speedDurationMs"`
}

// ObstaclesConfig 可破坏障碍参数。
type ObstaclesConfig struct {
	BreakableHp int `json:"breakableHp"`
	RespawnMs   int `json:"respawnMs"`
}

// ObstacleDef 地图上固定障碍的初始定义。
type ObstacleDef struct {
	ID   string  `json:"id"`
	Type string  `json:"type"` // solid | breakable
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	W    float64 `json:"w"`
	H    float64 `json:"h"`
}

// MapConfig 地图尺寸、出生点、障碍与道具刷新点。
type MapConfig struct {
	Width           float64       `json:"width"`
	Height          float64       `json:"height"`
	WallThickness   float64       `json:"wallThickness"`
	SpawnPoints     []Vec2        `json:"spawnPoints"`
	Obstacles       []ObstacleDef `json:"obstacles"`
	ItemSpawnPoints []Vec2        `json:"itemSpawnPoints"`
}

// Config 是 game.json 的完整映射。
type Config struct {
	Version   int             `json:"version"`
	Room      RoomConfig      `json:"room"`
	Player    PlayerConfig    `json:"player"`
	Items     ItemsConfig     `json:"items"`
	Obstacles ObstaclesConfig `json:"obstacles"`
	Map       MapConfig       `json:"map"`
}

// Load 从指定路径读取配置并做基础校验。
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取配置文件失败: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("解析配置文件失败: %w", err)
	}

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) validate() error {
	if c.Room.MaxPlayers <= 0 {
		return fmt.Errorf("room.maxPlayers 必须大于 0")
	}
	if c.Room.TickRate <= 0 || c.Room.TickRate > 120 {
		return fmt.Errorf("room.tickRate 取值范围应为 1~120")
	}
	if c.Player.MaxHp <= 0 || c.Player.MoveSpeed <= 0 {
		return fmt.Errorf("player.maxHp 与 player.moveSpeed 必须大于 0")
	}
	if c.Map.Width <= 0 || c.Map.Height <= 0 {
		return fmt.Errorf("map 尺寸必须大于 0")
	}
	if len(c.Map.SpawnPoints) == 0 {
		return fmt.Errorf("map.spawnPoints 不能为空")
	}
	return nil
}

// TickSeconds 返回单个逻辑帧的时长（秒），供运动积分使用。
func (c *Config) TickSeconds() float64 {
	return 1.0 / float64(c.Room.TickRate)
}

// TickMs 返回单个逻辑帧的时长（毫秒）。
func (c *Config) TickMs() int {
	return 1000 / c.Room.TickRate
}
