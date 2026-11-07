/**
 * WebSocket 网络客户端（P2）。
 *
 * 职责：
 *   - 建立/关闭 WebSocket 连接；
 *   - 收发统一封套消息（Codec 负责编解码）；
 *   - 按消息类型路由给订阅者（WorldController / UI）；
 *   - 登录、加入、心跳与 RTT 统计。
 *
 * 说明：
 *   - 单例，跨场景存活（Boot 登录后切到 Game 场景，连接不能断）。
 *   - 这里只做「收消息 -> 回调」，不写任何游戏逻辑，保证表现层
 *     与网络层解耦，P4 加预测/插值时也只改本文件与视图层。
 */

import { EventBus, Events } from '../core/EventBus';
import { Codec } from './Codec';
import {
    C2S,
    Envelope,
    InputRequest,
    JoinResult,
    LoginRequest,
    LoginResponse,
    PingRequest,
    PongResponse,
    S2C,
    ErrorMessage,
} from './NetTypes';

export type NetState = 'idle' | 'connecting' | 'open' | 'closed';

type MessageHandler = (data: any) => void;

interface PendingRequest {
    type: string;
    resolve: (data: any) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** 默认服务端地址：开发时指向本机 8080，部署时可通过 GameContext.serverUrl 覆盖。 */
export function defaultWsUrl(): string {
    if (typeof location !== 'undefined' && location.hostname) {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        return `${proto}://${location.hostname}:8080/ws`;
    }
    return 'ws://127.0.0.1:8080/ws';
}

export class NetClient {
    private static _instance: NetClient | null = null;

    static get instance(): NetClient {
        if (!this._instance) {
            this._instance = new NetClient();
        }
        return this._instance;
    }

    /** 连接状态变化回调，供登录界面显示。 */
    onState: ((state: NetState) => void) | null = null;
    /** RTT（毫秒，指数平滑）变化回调。 */
    onRtt: ((rttMs: number) => void) | null = null;

    private readonly _codec = new Codec();
    private readonly _handlers = new Map<string, Set<MessageHandler>>();
    private _ws: WebSocket | null = null;
    private _seq = 0;
    private _state: NetState = 'idle';
    private _pending: PendingRequest | null = null;
    private _pingTimer: ReturnType<typeof setInterval> | null = null;
    private _rtt = 0;

    get state(): NetState {
        return this._state;
    }

    get rtt(): number {
        return Math.round(this._rtt);
    }

    get isOpen(): boolean {
        return this._state === 'open'
            && this._ws !== null
            && this._ws.readyState === WebSocket.OPEN;
    }

    // ---------------- 连接 ----------------

    /** 建立连接。已连接时直接返回。 */
    connect(url: string, timeoutMs = 5000): Promise<void> {
        if (this.isOpen) {
            return Promise.resolve();
        }
        this.close();

        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const ws = new WebSocket(url);
            this._ws = ws;
            this._setState('connecting');

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                this._setState('closed');
                try {
                    ws.close();
                } catch (e) {
                    void e;
                }
                reject(new Error('连接服务器超时'));
            }, timeoutMs);

            ws.onopen = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this._setState('open');
                resolve();
            };

            ws.onerror = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this._setState('closed');
                reject(new Error('无法连接服务器'));
            };

            ws.onclose = () => {
                clearTimeout(timer);
                if (!settled) {
                    settled = true;
                    reject(new Error('连接已断开'));
                }
                this._stopPing();
                this._rejectPending('连接已断开');
                this._setState('closed');
            };

            ws.onmessage = (ev: MessageEvent) => {
                const raw = typeof ev.data === 'string' ? ev.data : '';
                this._onMessage(raw);
            };
        });
    }

    /** 主动关闭连接（回登录页/退出游戏时调用）。 */
    close(): void {
        this._stopPing();
        this._rejectPending('连接已关闭');

        const ws = this._ws;
        this._ws = null;
        if (ws) {
            ws.onopen = null;
            ws.onerror = null;
            ws.onclose = null;
            ws.onmessage = null;
            try {
                ws.close();
            } catch (e) {
                void e;
            }
        }
        this._setState('idle');
    }

    // ---------------- 业务请求 ----------------

    /** 登录（成功后服务端下发 playerId / sessionId）。 */
    login(name: string, sessionId?: string): Promise<LoginResponse> {
        const req: LoginRequest = { name };
        if (sessionId) {
            req.sessionId = sessionId;
        }
        return this.request<LoginResponse>(C2S.Login, S2C.LoginOk, req);
    }

    /** 请求加入战斗。满员时服务端会自动转为观战排队。 */
    join(): Promise<JoinResult> {
        return this.request<JoinResult>(C2S.Join, S2C.JoinResult, {}).then((res) => {
            if (!res.success) {
                throw new Error(res.reason || '加入房间失败');
            }
            return res;
        });
    }

    /** 主动观战。 */
    spectate(): Promise<JoinResult> {
        return this.request<JoinResult>(C2S.Spectate, S2C.JoinResult, {}).then((res) => {
            if (!res.success) {
                throw new Error(res.reason || '观战失败');
            }
            return res;
        });
    }

    /** 上报一帧输入（只上报意图，结果由服务端计算）。 */
    sendInput(input: InputRequest): void {
        this.send(C2S.Input, input);
    }

    /** 离开房间。 */
    leave(): void {
        this.send(C2S.Leave, {});
    }

    // ---------------- 消息订阅 ----------------

    on<T>(type: string, handler: (data: T) => void): void {
        let set = this._handlers.get(type);
        if (!set) {
            set = new Set<MessageHandler>();
            this._handlers.set(type, set);
        }
        set.add(handler as MessageHandler);
    }

    off<T>(type: string, handler: (data: T) => void): void {
        const set = this._handlers.get(type);
        if (!set) return;
        set.delete(handler as MessageHandler);
        if (set.size === 0) {
            this._handlers.delete(type);
        }
    }

    // ---------------- 心跳 ----------------

    /** 开始心跳与 RTT 采样。 */
    startPing(intervalMs = 2000): void {
        this._stopPing();
        this._ping();
        this._pingTimer = setInterval(() => this._ping(), intervalMs);
    }

    private _ping(): void {
        const req: PingRequest = { clientTime: Date.now() };
        this.send(C2S.Ping, req);
    }

    private _stopPing(): void {
        if (this._pingTimer !== null) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
    }

    // ---------------- 内部实现 ----------------

    private send(type: string, data: unknown): void {
        if (!this.isOpen || !this._ws) {
            return;
        }
        this._ws.send(this._codec.encode(type, ++this._seq, data));
    }

    private request<T>(sendType: string, expectType: string, data: unknown, timeoutMs = 5000): Promise<T> {
        if (!this.isOpen) {
            return Promise.reject(new Error('尚未连接服务器'));
        }
        // 同一时刻只保留一个同步请求（登录/加入不会并发）
        this._rejectPending('新的请求替换了未完成的请求');

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this._pending && this._pending.timer === timer) {
                    this._pending = null;
                    reject(new Error(`等待 ${expectType} 超时`));
                }
            }, timeoutMs);

            this._pending = {
                type: expectType,
                resolve: resolve as (value: any) => void,
                reject,
                timer,
            };
            this.send(sendType, data);
        });
    }

    private _rejectPending(message: string): void {
        const pending = this._pending;
        if (!pending) return;
        this._pending = null;
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
    }

    private _onMessage(raw: string): void {
        let env: Envelope;
        try {
            env = this._codec.decode(raw);
        } catch (err) {
            console.warn('[NetClient] 忽略非法消息:', (err as Error).message);
            return;
        }

        if (env.type === S2C.Pong) {
            this._onPong(env.data as PongResponse);
        }

        const pending = this._pending;
        if (pending && pending.type === env.type) {
            this._pending = null;
            clearTimeout(pending.timer);
            pending.resolve(env.data);
        } else if (pending && env.type === S2C.Error) {
            const errMsg = env.data as ErrorMessage;
            this._pending = null;
            clearTimeout(pending.timer);
            pending.reject(new Error(errMsg?.message || '服务器返回错误'));
        }

        const set = this._handlers.get(env.type);
        if (set) {
            for (const handler of set) {
                try {
                    handler(env.data);
                } catch (err) {
                    console.error(`[NetClient] 处理消息 ${env.type} 出错:`, err);
                }
            }
        }
    }

    private _onPong(pong: PongResponse): void {
        const clientTime = Number(pong?.clientTime ?? 0);
        if (clientTime <= 0) return;

        const sample = Math.max(0, Date.now() - clientTime);
        this._rtt = this._rtt > 0 ? this._rtt * 0.7 + sample * 0.3 : sample;
        this.onRtt?.(this.rtt);
        // 同时广播到事件总线，供 UI 组件订阅。
        EventBus.instance.emit(Events.RttUpdated, this.rtt);
    }

    private _setState(state: NetState): void {
        if (this._state === state) return;
        this._state = state;
        this.onState?.(state);
    }
}
