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
import {
    ErrorMessage, HitEvent, ItemPickedEvent, JoinResult, KillEvent, ObstacleBrokenEvent,
    PlayerJoinEvent, PlayerLeaveEvent, S2C, Snapshot,
} from '../net/NetTypes';
import { NetClient } from '../net/NetClient';
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

    /** 输入上报间隔（毫秒）：20Hz，与服务端 tick 对齐。 */
    private static readonly INPUT_INTERVAL_MS = 50;

    private readonly state = new GameState();
    private viewMgr!: EntityViewManager;
    private driver!: LocalMockDriver;
    private netClient: NetClient | null = null;
    private inputCtrl!: InputController;
    private damageTextPool!: ObjectPool<DamageTextView>;
    private camera!: Camera;
    private map!: MapConfigData;
    private cfg!: GameConfigData;

    /** true：连服务器；false：P1 本地模拟（离线开发用）。 */
    private netMode = false;
    /** 输入上报节流累计时间（毫秒）。 */
    private _inputAccumMs = 0;

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
                // 回收前停掉残留动画，避免池节点在后台继续被 tween 改位置
                view.stopAll();
                view.node.active = false;
                this.damageTextPool.put(view);
            };
            return view;
        });

        // 3. 数据源与输入：已登录则走网络，否则退回 P1 本地模拟
        this.camera = this._findCamera();
        this.inputCtrl = new InputController(this.camera);

        const net = NetClient.instance;
        if (net.isOpen && GameContext.myPlayerId) {
            this.netMode = true;
            this.netClient = net;
            this._bindNetHandlers();
        } else {
            this.driver = new LocalMockDriver();
            GameContext.myPlayerId = 'local';
        }
    }

    protected update(dt: number): void {
        if (this.netMode) {
            this._updateNet(dt);
            return;
        }
        if (!this.driver) return; // onLoad 尚未完成（异步）

        // 采样输入 -> 喂给模拟器
        // 瞄准基准必须用视图节点的「世界坐标」，与 camera.screenToWorld 结果同系，
        // 不能再用 Coord.toNode 的局部坐标（会相对屏幕中心偏移）。
        const localView = this.viewMgr.findPlayer(GameContext.myPlayerId);
        if (localView) {
            const wp = localView.node.worldPosition;
            this.inputCtrl.setSelfWorldPos(wp.x, wp.y);
            this.driver.feedInput(this.inputCtrl.getInput());
        }

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
        this._unbindNetHandlers();
    }

    // ---------------- P2 网络模式 ----------------

    /** 以 20Hz 采样并上报一次输入。世界状态完全由服务端快照驱动。 */
    private _updateNet(dt: number): void {
        const net = this.netClient;
        if (!net || !net.isOpen) return;

        this._inputAccumMs += dt * 1000;
        if (this._inputAccumMs < WorldController.INPUT_INTERVAL_MS) {
            return;
        }
        this._inputAccumMs -= WorldController.INPUT_INTERVAL_MS;

        // 首次快照到达前还没有本地视图，先不上报输入
        const me = this.viewMgr.findPlayer(GameContext.myPlayerId);
        if (!me) return;

        const wp = me.node.worldPosition;
        this.inputCtrl.setSelfWorldPos(wp.x, wp.y);
        net.sendInput(this.inputCtrl.getInput());
    }

    private readonly _onNetSnapshot = (snap: Snapshot): void => {
        this.state.updateFromSnapshot(snap);
        this.viewMgr.sync(snap);
        // 无敌状态由服务端以 buff 形式下发（出生/复活后短暂无敌）。
        for (const p of snap.players) {
            this.viewMgr.findPlayer(p.id)?.setInvincible((p.buffs?.invincible ?? 0) > snap.serverTime);
        }
        EventBus.instance.emit(Events.Snapshot, snap);
        EventBus.instance.emit(Events.Leaderboard, snap.leaderboard);
    };

    private readonly _onNetHit = (h: HitEvent): void => {
        this._spawnDamageText(Math.round(h.damage), h.x, h.y, '#ff4d4f');
        this.viewMgr.findPlayer(h.targetId)?.playHitFlash();
        EventBus.instance.emit(Events.Hit, h);
    };

    private readonly _onNetKill = (ev: KillEvent): void => {
        EventBus.instance.emit(Events.Kill, ev);
    };

    private readonly _onNetItem = (ev: ItemPickedEvent): void => {
        EventBus.instance.emit(Events.ItemPicked, ev);
    };

    private readonly _onNetObstacle = (ev: ObstacleBrokenEvent): void => {
        EventBus.instance.emit(Events.ObstacleBroken, ev);
    };

    private readonly _onNetError = (err: ErrorMessage): void => {
        EventBus.instance.emit(Events.ErrorToast, err?.message ?? '服务器错误');
    };

    private readonly _onNetPlayerJoin = (ev: PlayerJoinEvent): void => {
        console.info(`[战斗] ${ev.name}(${ev.id}) 进入房间`);
    };

    private readonly _onNetPlayerLeave = (ev: PlayerLeaveEvent): void => {
        console.info(`[战斗] ${ev.name}(${ev.id}) 离开房间`);
    };

    /** 入房后再次收到加入结果：一般是观战者被补位为战斗玩家。 */
    private readonly _onNetJoinResult = (res: JoinResult): void => {
        EventBus.instance.emit(Events.JoinResult, res);
    };

    private _bindNetHandlers(): void {
        const net = this.netClient!;
        net.on(S2C.JoinResult, this._onNetJoinResult);
        net.on(S2C.Snapshot, this._onNetSnapshot);
        net.on(S2C.Hit, this._onNetHit);
        net.on(S2C.Kill, this._onNetKill);
        net.on(S2C.ItemPicked, this._onNetItem);
        net.on(S2C.ObstacleBroken, this._onNetObstacle);
        net.on(S2C.Error, this._onNetError);
        net.on(S2C.PlayerJoin, this._onNetPlayerJoin);
        net.on(S2C.PlayerLeave, this._onNetPlayerLeave);
    }

    private _unbindNetHandlers(): void {
        const net = this.netClient;
        if (!net) return;
        net.off(S2C.JoinResult, this._onNetJoinResult);
        net.off(S2C.Snapshot, this._onNetSnapshot);
        net.off(S2C.Hit, this._onNetHit);
        net.off(S2C.Kill, this._onNetKill);
        net.off(S2C.ItemPicked, this._onNetItem);
        net.off(S2C.ObstacleBroken, this._onNetObstacle);
        net.off(S2C.Error, this._onNetError);
        net.off(S2C.PlayerJoin, this._onNetPlayerJoin);
        net.off(S2C.PlayerLeave, this._onNetPlayerLeave);
    }

    // ---------------- 事件表现 ----------------

    private _replayEvents(): void {
        while (this.driver.events.length > 0) {
            const ev = this.driver.events.shift()!;
            switch (ev.key) {
                case 'hit': {
                    const h = ev.payload as HitEvent;
                    this._spawnDamageText(Math.round(h.damage), h.x, h.y, '#ff4d4f');
                    this.viewMgr.findPlayer(h.targetId)?.playHitFlash();
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
        // 固定在命中点上方，避免随机横向偏移造成位置飘忽。
        const p = Coord.toNode(sx, sy - 20);
        view.play(`-${damage}`, colorHex, p.x, p.y);
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