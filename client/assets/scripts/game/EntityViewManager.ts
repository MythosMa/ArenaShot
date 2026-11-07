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

    /** 当前帧正在显示（已挂到容器下）的子弹/道具。 */
    private _activeBullets: PooledNode<BulletView>[] = [];
    private _activeItems: PooledNode<ItemView>[] = [];

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

    /** 同步整个快照到视图。 */
    sync(snapshot: Snapshot): void {
        this._syncPlayers(snapshot.players);
        this._syncObstacles(snapshot.obstacles);
        this._syncBullets(snapshot.bullets);
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
        this._bulletsToPool();
        this._itemsToPool();
        this._bulletPool.clear();
        this._itemPool.clear();
    }

    // ---------------- 私有实现 ----------------

    private _syncPlayers(list: PlayerSnapshot[]): void {
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
            view.apply(p);
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

    /** 子弹数量少且生命周期短：每帧归还旧视图并复用池，不销毁节点。 */
    private _syncBullets(list: BulletSnapshot[]): void {
        this._bulletsToPool();
        for (const b of list) {
            const item = this._bulletPool.get();
            // 池化节点留在容器下仅隐藏，避免每帧反复从场景树摘除/挂回造成卡顿。
            if (item.node.parent !== this.roots.bulletsRoot) {
                item.node.parent = this.roots.bulletsRoot;
            }
            item.node.active = true;
            item.view.apply(b.x, b.y);
            this._activeBullets.push(item);
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

    private _bulletsToPool(): void {
        for (const item of this._activeBullets) {
            item.node.active = false;
            this._bulletPool.put(item);
        }
        this._activeBullets = [];
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