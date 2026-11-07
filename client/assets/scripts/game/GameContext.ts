/**
 * 跨场景共享的轻量上下文。
 * 登录场景写入玩家名，战斗场景读取；后续 P2/P4 会加入 sessionId 用于重连。
 */
export const GameContext = {
    /** 玩家展示名 */
    playerName: 'Player',
    /** 我的玩家 ID（登录成功后服务器下发） */
    myPlayerId: '',
    /** 重连时的 sessionId */
    sessionId: '',
    /** 服务器 WebSocket 地址；为空时使用 NetClient 推导的默认值 */
    serverUrl: '',
    /** 弱网/重连中的标记，避免 UI 误操作 */
    reconnecting: false,
    /** 观战排队位置：>0 表示尚未上场，0 表示在战斗中 */
    queuePos: 0,
};