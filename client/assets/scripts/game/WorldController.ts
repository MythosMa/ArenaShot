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
    Camera, Color, director, instantiate, Prefab, _decorator, Component, Node, Vec3,
} from 'cc';
import { ObjectPool } from '../core/ObjectPool';
import { createLogger } from '../core/Logger';
import { loadConfig, getConfig, MapConfigData, GameConfigData } from '../config/GameConfig';
import { Events, EventBus } from '../core/EventBus';
import {
    ErrorMessage, HitEvent, ItemPickedEvent, JoinResult, KillEvent, ObstacleBrokenEvent,
    PlayerJoinEvent, PlayerLeaveEvent, PlayerSnapshot, S2C, Snapshot,
} from '../net/NetTypes';
import { NetClient, NetState, defaultWsUrl } from '../net/NetClient';
import { GameContext } from './GameContext';
import { Coord } from './Coord';
import { GameState } from './GameState';
import { EntityViewManager, ViewRoots, ViewPrefabs } from './EntityViewManager';
import { InputController } from './InputController';
import { LocalMockDriver } from './LocalMockDriver';
import { DamageTextView } from './view/DamageTextView';
import { FxManager } from './view/FxManager';

const { ccclass, property } = _decorator;

// 战斗流程日志：Info 在 DEBUG 构建打印，生产构建（web-mobile 发布）静默。
const log = createLogger('战斗');

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

    // ---- 一次性 FX（命中/击杀/拾取/障碍破碎/复活）----
    /** fxRoot 下的圆环特效管理器。 */
    private fx!: FxManager;

    // ---- 顿挫 / 屏幕震动 ----
    /** 震动的承载节点：playersRoot 的父级（世界整体），HUD 不动。 */
    private _worldRoot: Node | null = null;
    private _worldBasePos = new Vec3();
    /** 震动剩余时间与总时长（秒）、幅度（像素）。 */
    private _shakeTime = 0;
    private _shakeDurSec = 0.2;
    private _shakeAmp = 0;
    /** 复活检测：上一快照的存活状态，玩家从死到活时在脚下放光环。 */
    private readonly _aliveById = new Map<string, boolean>();

    // ---- P4 断线重连 ----
    /** 正在执行自动重连，避免并发触发多套流程。 */
    private _reconnecting = false;
    /** 组件已销毁（切场景），停止重连循环。 */
    private _destroyed = false;
    /** 每次重连尝试间隔（毫秒），服务端 reconnectTimeoutMs 内重连可保留位置。 */
    private static readonly RECONNECT_INTERVAL_MS = 2000;

    /** 命中火花颜色（玩家子弹命中）。 */
    private static readonly FX_HIT = new Color(255, 220, 120, 255);
    /** 击杀爆散颜色（较浓的金红）。 */
    private static readonly FX_KILL = new Color(255, 140, 60, 255);
    /** 道具拾取光环颜色，按类型分发。 */
    private static readonly FX_ITEM: Record<string, Color> = {
        heal: new Color(120, 230, 150, 255),
        power: new Color(255, 130, 60, 255),
        speed: new Color(120, 195, 255, 255),
    };
    /** 障碍破碎碎片色。 */
    private static readonly FX_OBSTACLE = new Color(150, 150, 160, 255);
    /** 复活光环（与无敌光圈同色系，贴近地面的一圈）。 */
    private static readonly FX_RESPAWN = new Color(255, 235, 120, 255);

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

        // 一次性 FX 与屏幕震动：震动挂在「世界根」上，HUD/相机不动。
        this.fx = new FxManager(this.fxRoot);
        this._worldRoot = this.playersRoot?.parent ?? null;
        if (this._worldRoot) {
            this._worldBasePos.set(this._worldRoot.position);
        }

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
        // 震动在世界根上，两种模式都要更新。
        this._updateShake(dt);

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
        this._applyBuffVisuals(snap);
        this._detectRespawns(snap.players);

        // 广播供 UI 使用
        EventBus.instance.emit(Events.Snapshot, snap);
        EventBus.instance.emit(Events.Leaderboard, snap.leaderboard);

        // 消费一次性事件（命中/击杀/道具/障碍）
        this._replayEvents();
    }

    protected onDestroy(): void {
        this._destroyed = true;
        this.inputCtrl?.dispose();
        this.viewMgr?.clearAll();
        this.fx?.dispose();
        this._unbindNetHandlers();
        // 离开战斗场景即结束本次对局；重连循环也会因为 _destroyed 退出。
        if (this.netMode) {
            NetClient.instance.close();
        }
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
        // 网络快照 20Hz 到达，视图层做插值平滑到 60fps。
        this.viewMgr.sync(snap, true);
        // 无敌/移速/威力都来自服务端 buff 到期时间戳。
        this._applyBuffVisuals(snap);
        this._detectRespawns(snap.players);
        EventBus.instance.emit(Events.Snapshot, snap);
        EventBus.instance.emit(Events.Leaderboard, snap.leaderboard);
    };

    private readonly _onNetHit = (h: HitEvent): void => {
        this._handleHit(h);
    };

    private readonly _onNetKill = (ev: KillEvent): void => {
        this._handleKill(ev);
    };

    private readonly _onNetItem = (ev: ItemPickedEvent): void => {
        this._handleItem(ev);
    };

    private readonly _onNetObstacle = (ev: ObstacleBrokenEvent): void => {
        this._handleObstacle(ev);
    };

    private readonly _onNetError = (err: ErrorMessage): void => {
        EventBus.instance.emit(Events.ErrorToast, err?.message ?? '服务器错误');
    };

    private readonly _onNetPlayerJoin = (ev: PlayerJoinEvent): void => {
        log.i(`${ev.name}(${ev.id}) 进入房间`);
    };

    private readonly _onNetPlayerLeave = (ev: PlayerLeaveEvent): void => {
        log.i(`${ev.name}(${ev.id}) 离开房间`);
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
        EventBus.instance.on<NetState>(Events.NetStateChanged, this._onNetState, this);
    }

    private _unbindNetHandlers(): void {
        EventBus.instance.offTarget(this);
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

    // ---------------- P4 断线重连 ----------------

    /** 战斗中断线（state='closed'）时启动自动重连；主动 close 走 'idle'，不会触发。 */
    private _onNetState(state: NetState): void {
        if (!this.netMode || this._destroyed) return;
        if (state === 'closed') {
            void this._startReconnect();
        }
    }

    /**
     * 重连流程：连接 -> 带 sessionId 登录（复用原身份/位置）-> 加入 -> 恢复心跳。
     * 若超过服务端 reconnectTimeoutMs 仍未成功，登录会拿到新会话并重新进入对局。
     */
    private async _startReconnect(): Promise<void> {
        if (this._reconnecting || this._destroyed) return;
        this._reconnecting = true;
        GameContext.reconnecting = true;
        console.warn('[战斗] 连接断开，开始自动重连');

        while (!this._destroyed) {
            try {
                const net = this.netClient ?? NetClient.instance;
                const url = GameContext.serverUrl || defaultWsUrl();
                await net.connect(url);
                const login = await net.login(GameContext.playerName, GameContext.sessionId);
                GameContext.myPlayerId = login.playerId;
                GameContext.sessionId = login.sessionId;

                const res = await net.join();
                GameContext.queuePos = res.spectator ? res.queuePos : 0;
                net.startPing();

                GameContext.reconnecting = false;
                this._reconnecting = false;
                log.i('重连成功:', login.playerId);
                return;
            } catch (err) {
                console.warn('[战斗] 重连失败，稍后重试:', (err as Error).message);
                // 半开连接无法复用，清理后等下一轮再试。
                NetClient.instance.close();
            }
            await this._delay(WorldController.RECONNECT_INTERVAL_MS);
        }
        this._reconnecting = false;
    }

    private _delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ---------------- 事件表现 ----------------

    private _replayEvents(): void {
        while (this.driver.events.length > 0) {
            const ev = this.driver.events.shift()!;
            switch (ev.key) {
                case 'hit': {
                    this._handleHit(ev.payload as HitEvent);
                    break;
                }
                case 'kill': {
                    this._handleKill(ev.payload as KillEvent);
                    break;
                }
                case 'item': {
                    this._handleItem(ev.payload as ItemPickedEvent);
                    break;
                }
                case 'obstacle': {
                    this._handleObstacle(ev.payload as ObstacleBrokenEvent);
                    break;
                }
                case 'log': {
                    // P1 直接把局内日志打到控制台
                    log.i(ev.payload);
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

    // ---------------- 战斗反馈统一入口（本地/网络共用） ----------------

    /** 命中：伤害数字 + 命中点火花 + 受击方向推挤；被打的是自己时轻微震屏。 */
    private _handleHit(h: HitEvent): void {
        this._spawnDamageText(Math.round(h.damage), h.x, h.y, '#ff4d4f');
        this.viewMgr.findPlayer(h.targetId)?.playHitFlash(h.x, h.y);

        if (this.fx) {
            const p = Coord.toNode(h.x, h.y);
            this.fx.ring(p.x, p.y, 4, 22, WorldController.FX_HIT, 0.22, 3);
        }
        if (h.targetId === GameContext.myPlayerId) {
            this._shake(2.5, 0.12);
        }
        EventBus.instance.emit(Events.Hit, h);
    }

    /** 击杀：在被害者脚下爆散双环；击杀/阵亡涉及自己时震屏更强。 */
    private _handleKill(ev: KillEvent): void {
        const victim = this.viewMgr.findPlayer(ev.victimId);
        if (victim && this.fx) {
            const sp = victim.getServerPos();
            const p = Coord.toNode(sp.x, sp.y);
            this.fx.ring(p.x, p.y, 8, 46, WorldController.FX_KILL, 0.45, 5);
            this.fx.ring(p.x, p.y, 4, 26, WorldController.FX_HIT, 0.3, 3);
        }
        if (ev.killerId === GameContext.myPlayerId || ev.victimId === GameContext.myPlayerId) {
            this._shake(ev.victimId === GameContext.myPlayerId ? 6 : 4, 0.25);
        }
        EventBus.instance.emit(Events.Kill, ev);
    }

    /** 道具拾取：按道具类型颜色的扩散光环。 */
    private _handleItem(ev: ItemPickedEvent): void {
        if (this.fx) {
            const p = Coord.toNode(ev.x, ev.y);
            const color = WorldController.FX_ITEM[ev.itemType] ?? Color.WHITE;
            this.fx.ring(p.x, p.y, 6, 34, color, 0.35, 3);
        }
        EventBus.instance.emit(Events.ItemPicked, ev);
    }

    /** 障碍破碎：灰色扩散环。 */
    private _handleObstacle(ev: ObstacleBrokenEvent): void {
        if (this.fx) {
            const p = Coord.toNode(ev.x, ev.y);
            this.fx.ring(p.x, p.y, 10, 44, WorldController.FX_OBSTACLE, 0.4, 3);
        }
        EventBus.instance.emit(Events.ObstacleBroken, ev);
    }

    // ---------------- 状态驱动的表现 ----------------

    /** 把快照里的 buff 状态应用到视图：无敌光圈 + 移速/威力光环。 */
    private _applyBuffVisuals(snap: Snapshot): void {
        for (const p of snap.players) {
            const view = this.viewMgr.findPlayer(p.id);
            if (!view) continue;
            view.setInvincible((p.buffs?.invincible ?? 0) > snap.serverTime);
            view.setBuffs(p.buffs, snap.serverTime);
        }
    }

    /** 检测玩家从死亡变为存活，在脚下放一圈复活光环。 */
    private _detectRespawns(players: PlayerSnapshot[]): void {
        for (const p of players) {
            const wasAlive = this._aliveById.get(p.id);
            if (wasAlive === false && p.alive && this.fx) {
                const view = this.viewMgr.findPlayer(p.id);
                const sp = view?.getServerPos() ?? p;
                const n = Coord.toNode(sp.x, sp.y);
                this.fx.ring(n.x, n.y, 10, 52, WorldController.FX_RESPAWN, 0.5, 4);
            }
            this._aliveById.set(p.id, p.alive);
        }
    }

    // ---------------- 屏幕震动 ----------------

    /** 触发一次震动；震动中再次触发时取较大幅度与剩余时长。 */
    private _shake(amp: number, durSec: number): void {
        this._shakeAmp = Math.max(this._shakeAmp, amp);
        this._shakeDurSec = Math.max(this._shakeTime, durSec);
        this._shakeTime = this._shakeDurSec;
    }

    /** 每帧推进震动：随机偏移世界根，结束后精确归位（HUD/相机不受影响）。 */
    private _updateShake(dt: number): void {
        const root = this._worldRoot;
        if (!root || !root.isValid) return;
        if (this._shakeTime <= 0) return;

        this._shakeTime = Math.max(0, this._shakeTime - dt);
        if (this._shakeTime <= 0) {
            root.setPosition(this._worldBasePos);
            this._shakeAmp = 0;
            return;
        }
        const k = this._shakeTime / Math.max(0.001, this._shakeDurSec);
        const a = this._shakeAmp * k;
        root.setPosition(
            this._worldBasePos.x + (Math.random() * 2 - 1) * a,
            this._worldBasePos.y + (Math.random() * 2 - 1) * a,
            this._worldBasePos.z,
        );
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