/**
 * 观战状态常驻提示。
 *
 * Toast 只显示一两秒，排队中的玩家很容易忘记自己还在观战。
 * 本组件在排队期间持续显示「观战模式 · 排队第 N 位」，补位上场后自动隐藏。
 *
 * 覆盖两种进入观战的情况：
 *   1. 登录加入时房间已满；
 *   2. 断线重连后回到房间时恰好满员。
 *
 * 数据来源：GameContext.queuePos（加入结果/重连流程写入）+ JoinResult 事件。
 */

import { _decorator, Component, Label } from 'cc';
import { EventBus, Events } from '../../core/EventBus';
import { GameContext } from '../../game/GameContext';
import { JoinResult, Snapshot } from '../../net/NetTypes';

const { ccclass, property } = _decorator;

@ccclass('SpectatorBanner')
export class SpectatorBanner extends Component {
    @property(Label) label: Label | null = null;
    /** {n} 会被替换为当前排队序号。 */
    @property textTemplate = '观战模式　排队第 {n} 位，等待进入';

    protected onEnable(): void {
        EventBus.instance.on<JoinResult>(Events.JoinResult, this._onJoinResult, this);
        EventBus.instance.on<Snapshot>(Events.Snapshot, this._onSnapshot, this);
        // 进入场景时可能已经在排队：登录满员，或重连后落入队列。
        this._refresh(GameContext.queuePos);
    }

    protected onDisable(): void {
        EventBus.instance.offTarget(this);
    }

    private _onJoinResult(res: JoinResult): void {
        if (!res.success) return;
        GameContext.queuePos = res.spectator ? res.queuePos : 0;
        this._refresh(GameContext.queuePos);
    }

    /** 兜底：自己已经出现在快照里，说明已上场，撤掉提示。 */
    private _onSnapshot(snap: Snapshot): void {
        if (GameContext.queuePos <= 0) return;
        if (snap.players.some((p) => p.id === GameContext.myPlayerId)) {
            GameContext.queuePos = 0;
            this._refresh(0);
        }
    }

    /** 只切换子节点显隐，不关掉自身节点，否则 onDisable 后再也收不到事件。 */
    private _refresh(queuePos: number): void {
        const spectating = queuePos > 0;
        if (this.label?.node) {
            this.label.node.active = spectating;
        }
        if (spectating && this.label) {
            this.label.string = this.textTemplate.replace('{n}', String(queuePos));
        }
    }
}
