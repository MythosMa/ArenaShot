/**
 * 实体视图管理器。
 *
 * 职责：对比「快照里的实体集合」和「当前屏幕上的视图集合」，做增/删/改。
 * 这是从「数据中心」到「表现层」的唯一通道，配合对象池复用节点。
 *
 * 由 WorldController 持有。P2/P3 接入网络后本类无需改动。
 */

import { Node, Prefab, Vec3, instantiate } from 'cc';
import { ObjectPool } from '../core/ObjectPool';
import { getConfig, MapConfigData } from '../config/GameConfig';
import { BulletSnapshot, ItemSnapshot, ObstacleSnapshot, PlayerSnapshot, Snapshot } from '../net/NetTypes';
import { PlayerView } from './view/PlayerView';
import { BulletView } from './view/BulletView';
import { ObstacleView } from './view/ObstacleView';
import { ItemView } from './view/ItemView';
import { GameContext } from './GameContext';

export interface ViewRoots {
    playersRoot: Node;
    bulletsRoot: Node;
    obstaclesRoot: Node;
    itemsRoot: Node;
}

export interface ViewPrefabs {
    player: Prefab;
    bullet: Prefab;
    obstacleSolid: Prefab;
    obstacleBreakable: Prefab;
    item: Prefab;
}

/** 池化节点的通用载体：节点 + 对应视图组件。 */
interface PooledNode<V> {
    node: Node;
    view: V;
}

export class EntityViewManager {
    private readonly _players = new Map<string, PlayerView>();
    private readonly _obstacles = new Map<string, ObstacleView>();

    private readonly _bulletPool = new ObjectPool<PooledNode<BulletView>>(() => {
        const node = instantiate(this.prefabs.bullet);
        const view = node.getComponent(BulletView)!;
        view.init();
        return { node, view };
    });

    private readonly _itemPool = new ObjectPool<PooledNode<ItemView>>(() => {
        const node = instantiate(this.prefabs.item);
        return { node, view: node.getComponent(ItemView)! };
    });

    /** 当前正在显示的子弹/道具。子弹按 ID 复用节点以便插值。 */
    private readonly _bulletsById = new Map<string, PooledNode<BulletView>>();
    private _activeItems: PooledNode<ItemView>[] = [];

    /** 上一次快照到达时间，用于估算快照间隔（插值时长）。 */
    private _lastSyncMs = 0;

    constructor(
        private readonly roots: ViewRoots,
        private readonly prefabs: ViewPrefabs,
        private readonly map: MapConfigData,
    ) { }

    /** 按配置创建所有静态障碍，启动时调用一次。 */
    initObstacles(): void {
        for (const def of this.map.obstacles) {
            const prefab = def.type === 'solid'
                ? this.prefabs.obstacleSolid
                : this.prefabs.obstacleBreakable;
            const node = instantiate(prefab);
            node.parent = this.roots.obstaclesRoot;
            const view = node.getComponent(ObstacleView);
            if (!view) {
                console.error(`[EntityViewManager] 障碍预制体缺少 ObstacleView (id=${def.id})`);
                node.destroy();
                continue;
            }
            view.init(def.type, def.w, def.h);
            node.setPosition(this.toNode(def.x, def.y));
            this._obstacles.set(def.id, view);
        }
    }

    /**
     * 同步整个快照到视图。
     * @param interpolate 网络模式下传 true：位置按「上一快照 -> 本快照」平滑过渡，
     *                    避免 20Hz 快照在 60fps 屏幕上跳变；本地逐帧模拟传 false。
     */
    sync(snapshot: Snapshot, interpolate = false): void {
        let interpMs = 0;
        if (interpolate) {
            const now = Date.now();
            if (this._lastSyncMs > 0) {
                // 限幅：卡顿/切后台后不要用超长时长插值，直接追到最新。
                interpMs = Math.min(200, Math.max(20, now - this._lastSyncMs));
            }
            this._lastSyncMs = now;
        } else {
            this._lastSyncMs = 0;
        }

        this._syncPlayers(snapshot.players, interpMs);
        this._syncObstacles(snapshot.obstacles);
        this._syncBullets(snapshot.bullets, interpMs);
        this._syncItems(snapshot.items);
    }

    findPlayer(id: string): PlayerView | null {
        return this._players.get(id) ?? null;
    }

    /** 清空并销毁全部玩家/子弹/道具视图（切场景时调用）。 */
    clearAll(): void {
        for (const v of this._players.values()) {
            v.destroyView();
        }
        this._players.clear();
        for (const item of this._bulletsById.values()) {
            item.node.active = false;
            this._bulletPool.put(item);
        }
        this._bulletsById.clear();
        this._itemsToPool();
        this._bulletPool.clear();
        this._itemPool.clear();
    }

    // ---------------- 私有实现 ----------------

    private _syncPlayers(list: PlayerSnapshot[], interpMs: number): void {
        const aliveIds = new Set(list.map((p) => p.id));
        for (const [id, view] of this._players) {
            if (!aliveIds.has(id)) {
                view.destroyView();
                this._players.delete(id);
            }
        }
        const radius = getConfig().player.radius;
        for (const p of list) {
            let view: PlayerView | null = this._players.get(p.id) ?? null;
            if (view == null) {
                const node = instantiate(this.prefabs.player);
                node.parent = this.roots.playersRoot;
                view = node.getComponent(PlayerView);
                if (!view) {
                    console.error(`[EntityViewManager] 玩家预制体缺少 PlayerView (id=${p.id})`);
                    node.destroy();
                    continue;
                }
                view.init(p, p.id === GameContext.myPlayerId || p.id === 'local', radius);
                this._players.set(p.id, view);
            }
            view.apply(p, interpMs);
        }
    }

    private _syncObstacles(list: ObstacleSnapshot[]): void {
        for (const o of list) {
            const view = this._obstacles.get(o.id);
            if (view) {
                view.setBroken(o.broken);
            }
        }
    }

    /** 子弹按 ID 复用节点：同一颗子弹在快照间做位置插值，消失时归还池。 */
    private _syncBullets(list: BulletSnapshot[], interpMs: number): void {
        const alive = new Set<string>();
        for (const b of list) {
            alive.add(b.id);
            const item = this._bulletsById.get(b.id);
            if (item) {
                item.view.apply(b, interpMs);
            } else {
                const fresh = this._bulletPool.get();
                // 池化节点留在容器下仅隐藏，避免每帧反复从场景树摘除/挂回造成卡顿。
                if (fresh.node.parent !== this.roots.bulletsRoot) {
                    fresh.node.parent = this.roots.bulletsRoot;
                }
                fresh.node.active = true;
                fresh.view.apply(b, 0); // 初次出现直接落位
                this._bulletsById.set(b.id, fresh);
            }
        }
        for (const [id, item] of this._bulletsById) {
            if (!alive.has(id)) {
                item.node.active = false;
                this._bulletPool.put(item);
                this._bulletsById.delete(id);
            }
        }
    }

    private _syncItems(list: ItemSnapshot[]): void {
        this._itemsToPool();
        for (const it of list) {
            const item = this._itemPool.get();
            if (item.node.parent !== this.roots.itemsRoot) {
                item.node.parent = this.roots.itemsRoot;
            }
            item.view.init(it.type);
            item.node.setPosition(this.toNode(it.x, it.y));
            this._activeItems.push(item);
        }
    }

    private _itemsToPool(): void {
        for (const item of this._activeItems) {
            item.node.active = false;
            this._itemPool.put(item);
        }
        this._activeItems = [];
    }

    /** 服务器空间 -> 节点空间坐标（原点在地图中心，y 向上）。 */
    private toNode(x: number, y: number): Vec3 {
        return new Vec3(x - this.map.width / 2, this.map.height / 2 - y, 0);
    }
}