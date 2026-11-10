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
    Button, Camera, Color, director, instantiate, Label, Prefab, Rect, ResolutionPolicy, _decorator, Component, EventKeyboard, Input, input, KeyCode, Node, screen, sys, Vec3, view,
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
import { TouchController } from './TouchController';
import { LocalMockDriver } from './LocalMockDriver';
import { DamageTextView } from './view/DamageTextView';
import { FxManager } from './view/FxManager';
import { MinimapView } from '../ui/MinimapView';
import { OrientationGuard } from '../ui/OrientationGuard';
import { HUDController } from '../ui/HUDController';

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

    // ---- 观战 HUD（编辑器拖入）----
    @property(Node) spectatorHud: Node = null!;
    @property(Label) spectatorTargetName: Label = null!;
    @property(Button) spectatorPrevButton: Button = null!;
    @property(Button) spectatorNextButton: Button = null!;

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
    /** 触屏双摇杆（手机 H5）；桌面无触摸事件时始终空闲。 */
    private touchCtrl: TouchController | null = null;
    /** 竖屏提示遮罩。 */
    private orientation: OrientationGuard | null = null;
    /** 上一次应用到相机的窗口比例。 */
    private _cameraAspect = 0;
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

    // ---- 相机跟随 / 顿挫 ----
    /** 世界根节点：playersRoot 的父级（game_root），整体平移实现镜头跟随与震动。 */
    private _worldRoot: Node | null = null;
    /** 跟随偏移：世界根需要平移的量，使本地玩家保持在屏幕中央。 */
    private readonly _followPos = new Vec3();
    /** 震动偏移，叠加在跟随偏移之上。 */
    private readonly _shakeOffset = new Vec3();
    /** 是否已完成首次镜头定位（首帧直接对准，不做平滑）。 */
    private _hasFollow = false;
    /** 震动剩余时间与总时长（秒）、幅度（像素）。 */
    private _shakeTime = 0;
    /** 观战目标玩家 ID；普通玩家为空。 */
    private _spectatorTargetId = '';
    private _playerHud: HUDController | null = null;
    private _shakeDurSec = 0.2;
    private _shakeAmp = 0;
    /** 复活检测：上一快照的存活状态，玩家从死到活时在脚下放光环。 */
    private readonly _aliveById = new Map<string, boolean>();

    // ---- 小地图 ----
    private minimap: MinimapView | null = null;
    /** 本地模拟模式下小地图的重绘节流累计（秒）。 */
    private _minimapAccum = 0;
    private static readonly MINIMAP_INTERVAL_SEC = 0.05;

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

        // 一次性 FX 与镜头：跟随/震动都平移「世界根」，HUD/相机不动。
        this.fx = new FxManager(this.fxRoot);
        this._worldRoot = this.playersRoot?.parent ?? null;
        if (this._worldRoot) {
            this._followPos.set(this._worldRoot.position);
        }

        // 小地图、触屏摇杆、横屏提示都运行时创建在 HUD 下，避开编辑器改动。
        this.camera = this._findCamera();
        // 设计分辨率 1920×1080；超宽/超高窗口统一按 16:9 居中留黑边。
        // 关键：Canvas 默认会把相机拉伸到整个窗口宽度，导致「视界之外」的地图内容
        // 被渲染出来；SHOW_ALL 让引擎自行裁剪，超过设计比例的左右区域只显示清屏色。
        view.setDesignResolutionSize(1920, 1080, ResolutionPolicy.SHOW_ALL);
        this._updateCameraViewport();
        const hud = this.node.getChildByName('hud');
        if (hud) {
            this._playerHud = hud.getComponent(HUDController) ?? hud.getComponentInChildren(HUDController);
            this.minimap = new MinimapView(hud, this.cfg);
            // 只有手机（或显式开启的 ?touch=1 调试模式）才创建触屏 UI。
            // 不能按「能否收到 EventTouch」判断：Cocos 在无触摸屏的桌面浏览器里
            // 会把鼠标事件模拟派发成 EventTouch，导致桌面也冒出虚拟摇杆。
            if (WorldController._useTouchUI()) {
                this.touchCtrl = new TouchController(hud, this.camera);
                this.orientation = new OrientationGuard(hud);
            }
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
        this.inputCtrl = new InputController(this.camera);
        input.on(Input.EventType.KEY_DOWN, this._onSpectatorKeyDown, this);
        this.spectatorPrevButton?.node.on(Button.EventType.CLICK, this._onSpectatorPrev, this);
        this.spectatorNextButton?.node.on(Button.EventType.CLICK, this._onSpectatorNext, this);
        this._updateSpectatorHud();

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
        // 竖屏提示（手机 H5）
        this.orientation?.tick();
        this._updateCameraViewport();

        // 跟随与震动都作用在世界根上，两种模式都要更新。
        this._updateCameraFollow(dt);
        this._updateSpectatorHud();
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
            if (!this._isSpectator()) {
                const req = this.inputCtrl.getInput();
                if (!this.orientation?.portrait) this.touchCtrl?.apply(req);
                this.driver.feedInput(req);
            }
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

        // 小地图按 20Hz 重绘即可，没必要每帧重建 Graphics。
        this._minimapAccum += dt;
        if (this._minimapAccum >= WorldController.MINIMAP_INTERVAL_SEC) {
            this._minimapAccum = 0;
            this.minimap?.update(snap, this._followPos);
        }
    }

    protected onDestroy(): void {
        this._destroyed = true;
        input.off(Input.EventType.KEY_DOWN, this._onSpectatorKeyDown, this);
        this.spectatorPrevButton?.node.off(Button.EventType.CLICK, this._onSpectatorPrev, this);
        this.spectatorNextButton?.node.off(Button.EventType.CLICK, this._onSpectatorNext, this);
        this.inputCtrl?.dispose();
        this.touchCtrl?.dispose();
        this.orientation?.dispose();
        this.viewMgr?.clearAll();
        this.fx?.dispose();
        this.minimap?.dispose();
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
        if (this._isSpectator()) return;

        const me = this.viewMgr.findPlayer(GameContext.myPlayerId);
        if (!me) return;

        const wp = me.node.worldPosition;
        this.inputCtrl.setSelfWorldPos(wp.x, wp.y);
        const req = this.inputCtrl.getInput();
        if (!this.orientation?.portrait) this.touchCtrl?.apply(req);
        net.sendInput(req);
    }

    private readonly _onNetSnapshot = (snap: Snapshot): void => {
        this.state.updateFromSnapshot(snap);
        // 网络快照 20Hz 到达，视图层做插值平滑到 60fps。
        this.viewMgr.sync(snap, true);
        // 无敌/移速/威力都来自服务端 buff 到期时间戳。
        this._applyBuffVisuals(snap);
        this._detectRespawns(snap.players);
        this.minimap?.update(snap, this._followPos);
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

    // ---------------- 镜头跟随与屏幕震动 ----------------

    /**
     * 二次保险：把相机限制在 16:9 的中间视口。
     * Canvas/ResolutionPolicy 在不同预览与 Web 构建模板中的裁剪行为可能不同，
     * 但 Camera.rect 会直接限制该相机实际提交到渲染管线的区域。
     */
    private _updateCameraViewport(): void {
        const camera = this.camera;
        if (!camera) return;
        const ws = screen.windowSize;
        if (ws.width <= 0 || ws.height <= 0) return;
        const aspect = ws.width / ws.height;
        if (Math.abs(aspect - this._cameraAspect) < 0.001) return;
        this._cameraAspect = aspect;

        const designAspect = 1920 / 1080;
        const rect = camera.rect;
        if (aspect > designAspect) {
            const widthRatio = designAspect / aspect;
            rect.x = (1 - widthRatio) / 2;
            rect.y = 0;
            rect.width = widthRatio;
            rect.height = 1;
        } else if (aspect < designAspect) {
            const heightRatio = aspect / designAspect;
            rect.x = 0;
            rect.y = (1 - heightRatio) / 2;
            rect.width = 1;
            rect.height = heightRatio;
        } else {
            rect.x = 0;
            rect.y = 0;
            rect.width = 1;
            rect.height = 1;
        }
        camera.rect = new Rect(rect.x, rect.y, rect.width, rect.height);
    }

    /** 触发一次震动；震动中再次触发时取较大幅度与剩余时长。 */
    private _shake(amp: number, durSec: number): void {
        this._shakeAmp = Math.max(this._shakeAmp, amp);
        this._shakeDurSec = Math.max(this._shakeTime, durSec);
        this._shakeTime = this._shakeDurSec;
    }

    /**
     * 镜头跟随：平移世界根（game_root），让目标保持在屏幕中央，并夹紧到地图边界。
     * 轻微平滑（指数趋近）；目标跳变过大（如复活瞬移）时直接落位，避免横穿全图的拖镜。
     */
    private _updateCameraFollow(dt: number): void {
        if (!this._worldRoot || !this.viewMgr) return;

        const t = this._cameraTarget();
        const vs = view.getVisibleSize();
        // 世界根不能把可视窗口移出地图边界；单轴不足一屏时保持居中。
        const maxOx = Math.max(0, (this.map.width - vs.width) / 2);
        const maxOy = Math.max(0, (this.map.height - vs.height) / 2);
        const ox = Math.max(-maxOx, Math.min(maxOx, -t.x));
        const oy = Math.max(-maxOy, Math.min(maxOy, -t.y));

        if (!this._hasFollow
            || Math.hypot(ox - this._followPos.x, oy - this._followPos.y) > 480) {
            this._followPos.set(ox, oy, 0);
            this._hasFollow = true;
        } else {
            const k = 1 - Math.exp(-dt * 10);
            this._followPos.x += (ox - this._followPos.x) * k;
            this._followPos.y += (oy - this._followPos.y) * k;
        }
        this._applyWorldOffset();
    }

    /** 待聚焦的点：普通玩家跟随自己，观战玩家跟随选中的目标。 */
    private _cameraTarget(): Vec3 {
        if (this._isSpectator()) {
            this._ensureSpectatorTarget();
            const target = this.state.players.find((p) => p.id === this._spectatorTargetId);
            if (target) {
                const v = Coord.toNode(target.x, target.y);
                return new Vec3(v.x, v.y, 0);
            }
        }

        const me = this.viewMgr.findPlayer(GameContext.myPlayerId);
        if (me) {
            const p = me.node.position;
            return new Vec3(p.x, p.y, 0);
        }

        const list = this.state.players;
        if (list.length > 0) {
            let sx = 0;
            let sy = 0;
            let n = 0;
            for (const q of list) {
                if (!q.alive) continue;
                const v = Coord.toNode(q.x, q.y);
                sx += v.x;
                sy += v.y;
                n++;
            }
            if (n > 0) return new Vec3(sx / n, sy / n, 0);
        }
        return new Vec3(0, 0, 0);
    }

    private _isSpectator(): boolean {
        return GameContext.queuePos > 0 &&
            !this.state.players.some((p) => p.id === GameContext.myPlayerId);
    }

    private _ensureSpectatorTarget(): void {
        if (!this._isSpectator()) {
            this._spectatorTargetId = '';
            return;
        }
        const current = this.state.players.find(
            (p) => p.id === this._spectatorTargetId && p.alive,
        );
        if (current) return;
        this._spectatorTargetId = this.state.players.find((p) => p.alive)?.id ?? '';
    }

    private _onSpectatorKeyDown(event: EventKeyboard): void {
        if (!this._isSpectator()) return;
        if (event.keyCode === KeyCode.KEY_Q || event.keyCode === KeyCode.ARROW_LEFT) {
            this._cycleSpectatorTarget(-1);
        } else if (event.keyCode === KeyCode.KEY_E || event.keyCode === KeyCode.ARROW_RIGHT) {
            this._cycleSpectatorTarget(1);
        }
    }

    private readonly _onSpectatorPrev = (): void => {
        this._cycleSpectatorTarget(-1);
    };

    private readonly _onSpectatorNext = (): void => {
        this._cycleSpectatorTarget(1);
    };

    private _updateSpectatorHud(): void {
        const spectator = this._isSpectator();
        this.touchCtrl?.setEnabled(!spectator);
        this._playerHud?.setPlayerStatusVisible(!spectator);
        if (this.spectatorHud) this.spectatorHud.active = spectator;
        if (!spectator || !this.spectatorTargetName) return;
        const target = this.state.players.find((p) => p.id === this._spectatorTargetId);
        this.spectatorTargetName.string = target
            ? `当前跟随：${target.name}`
            : '当前跟随：等待玩家';
    }

    private _cycleSpectatorTarget(direction: number): void {
        const targets = this.state.players.filter((p) => p.alive);
        if (targets.length === 0) {
            this._spectatorTargetId = '';
            return;
        }
        const index = targets.findIndex((p) => p.id === this._spectatorTargetId);
        const next = (index + direction + targets.length) % targets.length;
        this._spectatorTargetId = targets[next].id;
    }

    /** 每帧推进震动：在跟随偏移上叠加衰减的随机偏移。 */
    private _updateShake(dt: number): void {
        if (this._shakeTime <= 0) {
            if (this._shakeOffset.x !== 0 || this._shakeOffset.y !== 0) {
                this._shakeOffset.set(0, 0, 0);
                this._applyWorldOffset();
            }
            return;
        }
        this._shakeTime = Math.max(0, this._shakeTime - dt);
        if (this._shakeTime <= 0) {
            this._shakeOffset.set(0, 0, 0);
            this._shakeAmp = 0;
            this._applyWorldOffset();
            return;
        }
        const k = this._shakeTime / Math.max(0.001, this._shakeDurSec);
        const a = this._shakeAmp * k;
        this._shakeOffset.set((Math.random() * 2 - 1) * a, (Math.random() * 2 - 1) * a, 0);
        this._applyWorldOffset();
    }

    /** 把「跟随 + 震动」汇总后的偏移应用到世界根。 */
    private _applyWorldOffset(): void {
        const root = this._worldRoot;
        if (!root || !root.isValid) return;
        root.setPosition(
            this._followPos.x + this._shakeOffset.x,
            this._followPos.y + this._shakeOffset.y,
            this._followPos.z,
        );
    }

    // ---------------- 装配 ----------------

    /**
     * 是否启用触屏 UI。
     * 手机浏览器为 true；桌面浏览器默认 false（继续用键鼠），
     * 地址栏追加 ?touch=1 可强制开启，方便在桌面上用鼠标拖拽调试摇杆。
     */
    private static _useTouchUI(): boolean {
        if (sys.isMobile) return true;
        if (sys.isBrowser && typeof location !== 'undefined') {
            return /[?&]touch=1(?:&|$)/.test(location.search);
        }
        return false;
    }

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