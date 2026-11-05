/**
 * 世界主控制器（挂在 WorldController 组件，通常绑在 Scene 根 Canvas 上）。
 *
 * 职责：把「数据源」和「表现层」焊在一起 ——
 *
 *   数据源（P1 Mock / P2+ 网络） -> GameState（数据中心） -> EntityViewManager -> 视图
 *
 * P2/P3 接入真实服务器后，这里只需把数据源从 LocalMockDriver 换成
 * NetClient 的「收消息 -> state.updateFromSnapshot」，其余不变。
 */

import {
    Camera, director, instantiate, Prefab, _decorator, Component, Node,
} from 'cc';
import { ObjectPool } from '../core/ObjectPool';
import { loadConfig, getConfig, MapConfigData, GameConfigData } from '../config/GameConfig';
import { Events, EventBus } from '../core/EventBus';
import { HitEvent, KillEvent, Snapshot } from '../net/NetTypes';
import { GameContext } from './GameContext';
import { Coord } from './Coord';
import { GameState } from './GameState';
import { EntityViewManager, ViewRoots, ViewPrefabs } from './EntityViewManager';
import { InputController } from './InputController';
import { LocalMockDriver } from './LocalMockDriver';
import { DamageTextView } from './view/DamageTextView';

const { ccclass, property } = _decorator;

@ccclass('WorldController')
export class WorldController extends Component {
    // ---- 场景节点容器（编辑器拖入）----
    @property(Node) playersRoot: Node = null!;
    @property(Node) bulletsRoot: Node = null!;
    @property(Node) obstaclesRoot: Node = null!;
    @property(Node) itemsRoot: Node = null!;
    @property(Node) fxRoot: Node = null!;

    // ---- 预制体（编辑器拖入）----
    @property(Prefab) playerPrefab: Prefab = null!;
    @property(Prefab) bulletPrefab: Prefab = null!;
    @property(Prefab) obstacleSolidPrefab: Prefab = null!;
    @property(Prefab) obstacleBreakablePrefab: Prefab = null!;
    @property(Prefab) itemPrefab: Prefab = null!;
    @property(Prefab) damageTextPrefab: Prefab = null!;

    private readonly state = new GameState();
    private viewMgr!: EntityViewManager;
    private driver!: LocalMockDriver;
    private inputCtrl!: InputController;
    private damageTextPool!: ObjectPool<DamageTextView>;
    private camera!: Camera;
    private map!: MapConfigData;
    private cfg!: GameConfigData;

    /** P1 本地模拟；P2 接入网络后置 true。 */
    private netMode = false;

    async onLoad(): Promise<void> {
        // 1. 配置与坐标系就绪
        await loadConfig();
        this.cfg = getConfig();
        this.map = this.cfg.map;
        Coord.init(this.map.width, this.map.height);

        // 2. 视图层
        this.viewMgr = new EntityViewManager(
            this._viewRoots(),
            this._viewPrefabs(),
            this.map,
        );
        this.viewMgr.initObstacles();
        this.damageTextPool = new ObjectPool<DamageTextView>(() => {
            const node = instantiate(this.damageTextPrefab);
            node.parent = this.fxRoot;
            const view = node.getComponent(DamageTextView)!;
            view.onComplete = () => {
                view.node.active = false;
                this.damageTextPool.put(view);
            };
            return view;
        });

        // 3. 数据源与输入
        this.camera = this._findCamera();
        this.inputCtrl = new InputController(this.camera);
        this.driver = new LocalMockDriver();

        // P1 中本地玩家固定 id
        GameContext.myPlayerId = 'local';
    }

    protected update(dt: number): void {
        if (!this.driver) return; // onLoad 尚未完成（异步）

        void this.netMode;

        // 采样输入 -> 喂给模拟器
        const me = this.driver.localPlayerServerPos();
        const meNode = Coord.toNode(me.x, me.y);
        this.inputCtrl.setSelfNodePos(meNode.x, meNode.y);
        this.driver.feedInput(this.inputCtrl.getInput());

        // 推进模拟 -> 刷新数据中心 -> 驱动视图
        this.driver.update(dt * 1000);
        const snap = this.driver.buildSnapshot();
        this.state.updateFromSnapshot(snap);
        this.viewMgr.sync(snap);

        // 广播供 UI 使用
        EventBus.instance.emit(Events.Snapshot, snap);
        EventBus.instance.emit(Events.Leaderboard, snap.leaderboard);

        // 消费一次性事件（命中/击杀/道具/障碍）
        this._replayEvents();
    }

    protected onDestroy(): void {
        this.inputCtrl?.dispose();
        this.viewMgr?.clearAll();
    }

    // ---------------- 事件表现 ----------------

    private _replayEvents(): void {
        while (this.driver.events.length > 0) {
            const ev = this.driver.events.shift()!;
            switch (ev.key) {
                case 'hit': {
                    const h = ev.payload as HitEvent;
                    this._spawnDamageText(Math.round(h.damage), h.x, h.y, '#ff4d4f');
                    EventBus.instance.emit(Events.Hit, h);
                    break;
                }
                case 'kill': {
                    EventBus.instance.emit(Events.Kill, ev.payload);
                    break;
                }
                case 'item': {
                    EventBus.instance.emit(Events.ItemPicked, ev.payload);
                    break;
                }
                case 'obstacle': {
                    EventBus.instance.emit(Events.ObstacleBroken, ev.payload);
                    break;
                }
                case 'log': {
                    // P1 直接把局内日志打到控制台
                    console.info('[战斗]', ev.payload);
                    break;
                }
            }
        }
    }

    private _spawnDamageText(damage: number, sx: number, sy: number, colorHex: string): void {
        const view = this.damageTextPool.get();
        if (view.node.parent !== this.fxRoot) {
            view.node.parent = this.fxRoot;
        }
        view.node.active = true;
        const p = Coord.toNode(sx - (Math.random() * 20 - 10), sy - 10);
        view.node.setPosition(p.x, p.y, 0);
        view.play(`-${damage}`, colorHex);
    }

    // ---------------- 装配 ----------------

    private _viewRoots(): ViewRoots {
        return {
            playersRoot: this.playersRoot,
            bulletsRoot: this.bulletsRoot,
            obstaclesRoot: this.obstaclesRoot,
            itemsRoot: this.itemsRoot,
        };
    }

    private _viewPrefabs(): ViewPrefabs {
        return {
            player: this.playerPrefab,
            bullet: this.bulletPrefab,
            obstacleSolid: this.obstacleSolidPrefab,
            obstacleBreakable: this.obstacleBreakablePrefab,
            item: this.itemPrefab,
        };
    }

    private _findCamera(): Camera {
        // 优先取场景中第一个 3D/2D 相机；设计期 Camera.main 可能未就绪。
        const scene = director.getScene();
        if (scene) {
            const cam = scene.getComponentInChildren(Camera) ?? this.node.getComponentInChildren(Camera);
            if (cam) return cam;
        }
        throw new Error('[WorldController] 场景中找不到相机');
    }
}