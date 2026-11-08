/**
 * 网络协议类型定义（与服务端 internal/protocol/message.go 保持一一对应）。
 *
 * 消息封套统一为：
 *   { "type": string, "seq": number, "data": object }
 * type 取值见 C2S / S2C 两个常量表。
 */

/** 客户端 -> 服务端 消息名。 */
export const C2S = {
    Login: 'c2s_login',
    Input: 'c2s_input',
    Join: 'c2s_join',
    Ping: 'c2s_ping',
    Leave: 'c2s_leave',
    Spectate: 'c2s_spectate',
} as const;

/** 服务端 -> 客户端 消息名。 */
export const S2C = {
    LoginOk: 's2c_login_ok',
    RoomInfo: 's2c_room_info',
    JoinResult: 's2c_join_result',
    Snapshot: 's2c_snapshot',
    Hit: 's2c_hit',
    Kill: 's2c_kill',
    ObstacleBroken: 's2c_obstacle_broken',
    ItemPicked: 's2c_item_picked',
    PlayerJoin: 's2c_player_join',
    PlayerLeave: 's2c_player_leave',
    Leaderboard: 's2c_leaderboard',
    Pong: 's2c_pong',
    Error: 's2c_error',
    Kick: 's2c_kick',
} as const;

/** 统一封套。 */
export interface Envelope {
    type: string;
    seq: number;
    data: unknown;
}

/* ---------------- C2S 负载 ---------------- */

export interface LoginRequest {
    name: string;
    /** 重连时携带上次下发的 sessionId */
    sessionId?: string;
}

export interface InputRequest {
    /** -1 ~ 1 */
    moveX: number;
    moveY: number;
    /** 瞄准方向（弧度） */
    aim: number;
    fire: boolean;
    useItem: boolean;
    /** 客户端本地时间戳（毫秒），用于延迟统计 */
    clientTime: number;
}

export interface PingRequest {
    clientTime: number;
}

/* ---------------- S2C 负载 ---------------- */

export interface LoginResponse {
    playerId: string;
    sessionId: string;
    configVersion: number;
    serverTime: number;
}

export interface PongResponse {
    clientTime: number;
    serverTime: number;
}

export interface RoomInfo {
    playerCount: number;
    maxPlayers: number;
    spectatorCount: number;
    queueCount: number;
    inGame: boolean;
}

export interface JoinResult {
    success: boolean;
    spectator: boolean;
    /** 排队位置，0 表示无需排队 */
    queuePos: number;
    reason?: string;
}

export interface PlayerSnapshot {
    id: string;
    name: string;
    x: number;
    y: number;
    aim: number;
    hp: number;
    maxHp: number;
    alive: boolean;
    /** 复活时间戳（毫秒），未死亡为 0 */
    respawnAt: number;
    /** buff 名称 -> 结束时间戳 */
    buffs: Record<string, number>;
    kills: number;
    deaths: number;
    /** 服务端已接受的本玩家最后一个输入序号，用于预测校正 */
    lastProcessedSeq: number;
}

export interface BulletSnapshot {
    id: string;
    owner: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
}

export interface ObstacleSnapshot {
    id: string;
    type: string;
    broken: boolean;
    hp: number;
    respawnAt: number;
}

export interface ItemSnapshot {
    id: string;
    /** heal | power | speed */
    type: string;
    x: number;
    y: number;
}

export interface LeaderboardEntry {
    id: string;
    name: string;
    kills: number;
    deaths: number;
}

/** 全量世界快照。 */
export interface Snapshot {
    tick: number;
    serverTime: number;
    players: PlayerSnapshot[];
    bullets: BulletSnapshot[];
    obstacles: ObstacleSnapshot[];
    items: ItemSnapshot[];
    leaderboard: LeaderboardEntry[];
}

export interface HitEvent {
    shooterId: string;
    targetId: string;
    damage: number;
    x: number;
    y: number;
}

export interface KillEvent {
    killerId: string;
    killerName: string;
    victimId: string;
    victimName: string;
}

export interface ObstacleBrokenEvent {
    obstacleId: string;
    x: number;
    y: number;
}

export interface ItemPickedEvent {
    playerId: string;
    itemId: string;
    itemType: string;
    x: number;
    y: number;
}

export interface PlayerJoinEvent {
    id: string;
    name: string;
}

export interface PlayerLeaveEvent {
    id: string;
    name: string;
}

export interface ErrorMessage {
    code: number;
    message: string;
}

export interface KickMessage {
    reason: string;
}