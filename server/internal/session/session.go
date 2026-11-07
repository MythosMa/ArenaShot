// Package session 管理登录身份与断线重连凭证。
//
// 一个连接登录后获得独立的 playerId 与 sessionId；sessionId 由客户端保存，
// 断线后在保留时间内带它重连即可恢复原玩家位置（P4 接入）。
package session

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
)

// Session 是一次登录产生的身份。
type Session struct {
	ID       string // 断线重连凭证
	PlayerID string
	Name     string
}

// Manager 线程安全地保存当前有效会话。
type Manager struct {
	mu   sync.RWMutex
	byID map[string]*Session
}

// NewManager 创建会话管理器。
func NewManager() *Manager {
	return &Manager{byID: make(map[string]*Session)}
}

// Create 为新登录生成身份并登记。
func (m *Manager) Create(name string) *Session {
	s := &Session{
		ID:       newID("s_"),
		PlayerID: newID("p_"),
		Name:     name,
	}
	m.mu.Lock()
	m.byID[s.ID] = s
	m.mu.Unlock()
	return s
}

// Get 按 sessionId 查找会话。
func (m *Manager) Get(id string) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.byID[id]
	return s, ok
}

// Delete 删除会话（重连超时或主动退出时调用）。
func (m *Manager) Delete(id string) {
	m.mu.Lock()
	delete(m.byID, id)
	m.mu.Unlock()
}

// Count 返回当前会话数量，供健康检查/调试使用。
func (m *Manager) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.byID)
}

func newID(prefix string) string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		panic("session: 随机数生成失败: " + err.Error())
	}
	return prefix + hex.EncodeToString(buf)
}
