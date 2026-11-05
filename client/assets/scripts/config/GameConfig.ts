/**
 * 游戏配置加载。
 *
 * 配置文件是客户端与服务端的唯一数值来源，见 server/config/game.json。
 * 客户端通过 assets/resources/config/game.json 加载（由 scripts/sync-config.sh 同步）。
 *
 * 用法（在场景脚本 onCreate 中先 await）：
 *   const cfg = await GameConfig.load();
 *   this.playerSpeed = cfg.player.moveSpeed;
 */

import { JsonAsset, resources } from 'cc';

export interface Vec2Data {
    x: number;
    y: number;
}

export interface RoomConfigData {
    maxPlayers: number;
    tickRate: number;
    respawnDelayMs: number;
    reconnectTimeoutMs: number;
    snapshotIntervalMs: number;
    maxInputsPerSecond: number;
}

export interface PlayerConfigData {
    maxHp: number;
    moveSpeed: number;
    radius: number;
    fireIntervalMs: number;
    bulletSpeed: number;
    bulletDamage: number;
    bulletLifeMs: number;
    invincibleAfterRespawnMs: number;
}

export interface ItemsConfigData {
    spawnIntervalMs: number;
    maxOnMap: number;
    healAmount: number;
    powerMultiplier: number;
    powerDurationMs: number;
    speedMultiplier: number;
    speedDurationMs: number;
}

export interface ObstaclesConfigData {
    breakableHp: number;
    respawnMs: number;
}

export interface ObstacleDefData {
    id: string;
    /** solid | breakable */
    type: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface MapConfigData {
    width: number;
    height: number;
    wallThickness: number;
    spawnPoints: Vec2Data[];
    obstacles: ObstacleDefData[];
    itemSpawnPoints: Vec2Data[];
}

export interface GameConfigData {
    version: number;
    room: RoomConfigData;
    player: PlayerConfigData;
    items: ItemsConfigData;
    obstacles: ObstaclesConfigData;
    map: MapConfigData;
}

/** 客户端本地缓存的配置实例。 */
let _data: GameConfigData | null = null;

/** 获取已加载的配置；未加载会抛错，请先 await load()。 */
export function getConfig(): GameConfigData {
    if (!_data) {
        throw new Error('[GameConfig] 配置尚未加载，请先 await GameConfig.load()');
    }
    return _data;
}

/** 加载配置（幂等，内部缓存）。 */
export function loadConfig(): Promise<GameConfigData> {
    if (_data) {
        return Promise.resolve(_data);
    }
    return new Promise((resolve, reject) => {
        resources.load('config/game', JsonAsset, (err, asset) => {
            if (err || !asset) {
                reject(new Error(`[GameConfig] 加载配置失败: ${err?.message ?? '资源为空'}`));
                return;
            }
            _data = asset.json as GameConfigData;
            resolve(_data);
        });
    });
}