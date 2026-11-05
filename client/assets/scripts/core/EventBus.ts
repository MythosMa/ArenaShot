/**
 * 全局事件总线。
 *
 * 作用：把「游戏逻辑」与「界面表现」解耦。
 * 逻辑层只负责 emit 事件，UI/特效层各自监听自己关心的事件，
 * 避免逻辑代码到处持有节点引用。
 *
 * 用法：
 *   EventBus.instance.on(Events.PlayerHit, this.onHit, this);
 *   EventBus.instance.emit(Events.PlayerHit, { targetId, damage });
 *   EventBus.instance.off(Events.PlayerHit, this.onHit, this);
 */

type Handler = (payload?: unknown) => void;

/** 事件订阅记录，用于按 target 反注册。 */
interface Subscription {
    handler: Handler;
    target?: object;
}

export class EventBus {
    private static _instance: EventBus | null = null;

    static get instance(): EventBus {
        if (!this._instance) {
            this._instance = new EventBus();
        }
        return this._instance;
    }

    private readonly _map = new Map<string, Subscription[]>();

    /** 订阅事件。target 用于在节点销毁时批量注销。 */
    on<T>(event: string, handler: (payload: T) => void, target?: object): void {
        const list = this._map.get(event);
        const sub: Subscription = { handler: handler as Handler, target };
        if (list) {
            list.push(sub);
        } else {
            this._map.set(event, [sub]);
        }
    }

    /** 取消订阅。不传 handler 则取消该 target 在该事件下的所有订阅。 */
    off(event: string, handler?: (payload: any) => void, target?: object): void {
        const list = this._map.get(event);
        if (!list) {
            return;
        }
        if (!handler && !target) {
            this._map.delete(event);
            return;
        }
        const next = list.filter((sub) => {
            const handlerMatch = !handler || sub.handler === handler;
            const targetMatch = !target || sub.target === target;
            return !(handlerMatch && targetMatch);
        });
        if (next.length > 0) {
            this._map.set(event, next);
        } else {
            this._map.delete(event);
        }
    }

    /** 取消某个 target 的所有订阅（节点销毁时调用）。 */
    offTarget(target: object): void {
        for (const [event, list] of this._map) {
            const next = list.filter((sub) => sub.target !== target);
            if (next.length > 0) {
                this._map.set(event, next);
            } else {
                this._map.delete(event);
            }
        }
    }

    /** 派发事件。单个处理器异常不会影响其他处理器。 */
    emit<T>(event: string, payload?: T): void {
        const list = this._map.get(event);
        if (!list || list.length === 0) {
            return;
        }
        // 复制一份，避免处理器内部增删订阅导致遍历异常。
        for (const sub of list.slice()) {
            try {
                sub.handler(payload);
            } catch (err) {
                console.error(`[EventBus] 处理事件 "${event}" 时出错:`, err);
            }
        }
    }

    /** 清空所有订阅（切换场景或重开对局时使用）。 */
    clear(): void {
        this._map.clear();
    }
}

/** 事件名常量。集中管理，避免拼写错误。 */
export const Events = {
    /** 连接状态变化：连接中 / 已连接 / 断开 */
    NetStateChanged: 'net-state-changed',
    /** 登录成功 */
    LoginOk: 'login-ok',
    /** 收到房间信息 */
    RoomInfo: 'room-info',
    /** 加入战斗结果 */
    JoinResult: 'join-result',
    /** 收到世界快照 */
    Snapshot: 'snapshot',
    /** 命中事件 */
    Hit: 'hit',
    /** 击杀事件 */
    Kill: 'kill',
    /** 障碍被击碎 */
    ObstacleBroken: 'obstacle-broken',
    /** 道具被拾取 */
    ItemPicked: 'item-picked',
    /** 玩家加入 / 离开 */
    PlayerJoin: 'player-join',
    PlayerLeave: 'player-leave',
    /** 排行榜更新 */
    Leaderboard: 'leaderboard',
    /** RTT 更新 */
    RttUpdated: 'rtt-updated',
    /** 错误提示 */
    ErrorToast: 'error-toast',
} as const;
