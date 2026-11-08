/**
 * 屏幕中央提示（拾取道具、复活、错误信息等）。
 */

import { _decorator, Component, Label, Tween, tween, UIOpacity } from 'cc';
import { EventBus, Events } from '../core/EventBus';
import { GameContext } from '../game/GameContext';
import { ItemPickedEvent, JoinResult } from '../net/NetTypes';
import { NetState } from '../net/NetClient';

const { ccclass, property } = _decorator;

const ITEM_NAMES: Record<string, string> = {
    heal: '拾取 治疗',
    power: '拾取 威力提升',
    speed: '拾取 移速提升',
};

@ccclass('ToastController')
export class ToastController extends Component {
    @property(Label) label: Label = null!;

    private _opacity: UIOpacity | null = null;

    protected onLoad(): void {
        this._opacity = this.node.getComponent(UIOpacity) ?? this.node.addComponent(UIOpacity);
        if (this.label) this.label.string = '';
        if (this._opacity) this._opacity.opacity = 0;

        EventBus.instance.on<ItemPickedEvent>(Events.ItemPicked, this._onItem, this);
        EventBus.instance.on<unknown>(Events.ErrorToast, this._onError, this);
        EventBus.instance.on<JoinResult>(Events.JoinResult, this._onJoinResult, this);
        EventBus.instance.on<NetState>(Events.NetStateChanged, this._onNetState, this);

        // 入场即观战（满员排队）：进入战斗场景后明确提示，避免“不能动”的困惑。
        if (GameContext.queuePos > 0) {
            this.scheduleOnce(() => this.show(`观战中，排队第 ${GameContext.queuePos} 位`), 0.3);
        }
    }

    protected onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    private _onItem(ev: ItemPickedEvent): void {
        if (ev.playerId !== GameContext.myPlayerId) return;
        this.show(ITEM_NAMES[ev.itemType] ?? '拾取道具');
    }

    private _onError(payload: unknown): void {
        const text = typeof payload === 'string' ? payload : '发生错误';
        this.show(text);
    }

    /** 断线/重连状态提示。主动 close 走 idle，不提示。 */
    private _onNetState(state: NetState): void {
        if (state === 'closed') {
            this.show('网络断开，正在重连...');
        } else if (state === 'connecting' && GameContext.reconnecting) {
            this.show('重连中...');
        } else if (state === 'open' && GameContext.reconnecting) {
            this.show('网络已恢复');
        }
    }

    /** 入房后的再次加入结果：观战者被补位 / 补位后有空位就进战斗。 */
    private _onJoinResult(res: JoinResult): void {
        if (!res.success) return;
        if (res.spectator) {
            GameContext.queuePos = res.queuePos;
            this.show(`观战中，排队第 ${res.queuePos} 位`);
        } else {
            const promoted = GameContext.queuePos > 0;
            GameContext.queuePos = 0;
            if (promoted) this.show('已补位进入战斗');
        }
    }

    show(text: string): void {
        if (!this.label || !this._opacity) return;
        this.label.string = text;
        const op = this._opacity;
        Tween.stopAllByTarget(op);
        op.opacity = 255;
        tween(op)
            .delay(0.8)
            .to(0.5, { opacity: 0 })
            .start();
    }
}