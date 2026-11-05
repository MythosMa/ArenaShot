/**
 * 屏幕中央提示（拾取道具、复活、错误信息等）。
 */

import { _decorator, Component, Label, Tween, tween, UIOpacity } from 'cc';
import { EventBus, Events } from '../core/EventBus';
import { GameContext } from '../game/GameContext';
import { ItemPickedEvent } from '../net/NetTypes';

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