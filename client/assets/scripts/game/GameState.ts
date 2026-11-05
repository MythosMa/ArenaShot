/**
 * 「数据处理中心」。
 *
 * 对应你对架构的理解：服务端广播局内数据，客户端解析后先进入这里，
 * 游戏主逻辑（WorldController/视图）只读这个中心来驱动表现。
 *
 * 未来 P2/P3 接入真实网络后，NetClient 收到的 s2c_snapshot 会写入这里，
 * 视图层的消费方式完全不变 —— 这正是把表现和网络解耦的价值。
 */

import {
    BulletSnapshot,
    ItemSnapshot,
    LeaderboardEntry,
    ObstacleSnapshot,
    PlayerSnapshot,
    Snapshot,
} from '../net/NetTypes';

export class GameState {
    /** 最近一帧快照。 */
    latest: Snapshot | null = null;

    /** 由数据源（网络或本地模拟）写入最新快照。 */
    updateFromSnapshot(snapshot: Snapshot): void {
        this.latest = snapshot;
    }

    get players(): PlayerSnapshot[] {
        return this.latest?.players ?? [];
    }

    get bullets(): BulletSnapshot[] {
        return this.latest?.bullets ?? [];
    }

    get obstacles(): ObstacleSnapshot[] {
        return this.latest?.obstacles ?? [];
    }

    get items(): ItemSnapshot[] {
        return this.latest?.items ?? [];
    }

    get leaderboard(): LeaderboardEntry[] {
        return this.latest?.leaderboard ?? [];
    }

    get tick(): number {
        return this.latest?.tick ?? 0;
    }

    /** 取指定玩家的快照；不存在返回 {@link null}。 */
    getPlayer(id: string): PlayerSnapshot | null {
        for (const p of this.players) {
            if (p.id === id) return p;
        }
        return null;
    }

    /** 当前在线的玩家 ID 集合（按快照顺序）。 */
    get playerIds(): string[] {
        return this.players.map((p) => p.id);
    }
}