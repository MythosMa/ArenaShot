/**
 * 伤害飘字视图。
 * 播放一次后由池管理器回收（通过回调通知外部）。
 */

import { _decorator, Color, Component, Label, Tween, tween, UIOpacity, Vec3 } from 'cc';

const { ccclass, property } = _decorator;

@ccclass('DamageTextView')
export class DamageTextView extends Component {
    @property(Label) label: Label = null!;

    /** 飘字结束后回调（用于归还对象池），由调用方注入。 */
    onComplete: (() => void) | null = null;

    /** 该视图是否正在播放。 */
    playing = false;

    /**
     * 在指定位置播放一次飘字。
     *
     * 位置由这里统一设置：池复用时要先停掉上一轮残留的 tween，
     * 否则旧的 position tween 会和新的同时写节点位置，出现乱飘/跳位。
     */
    play(text: string, colorHex: string, x: number, y: number): void {
        this.stopAll(); // 会重置 playing，必须在下面重新置位
        this.playing = true;
        this.node.active = true;

        this.node.setPosition(x, y, 0);
        this.node.setScale(1, 1, 1);

        this.label.string = text;
        this.label.color = new Color().fromHEX(colorHex);

        const uiOpacity = this.node.getComponent(UIOpacity) ?? this.node.addComponent(UIOpacity);
        if (uiOpacity) {
            uiOpacity.opacity = 255;
            tween(uiOpacity).delay(0.5).to(0.35, { opacity: 0 }).call(() => {
                this.playing = false;
                this.onComplete?.();
            }).start();
        }
        tween(this.node)
            .by(0.85, { position: new Vec3(0, 46, 0) })
            .start();
    }

    stopAll(): void {
        Tween.stopAllByTarget(this.node);
        const uiOpacity = this.node.getComponent(UIOpacity);
        if (uiOpacity) {
            Tween.stopAllByTarget(uiOpacity);
        }
        this.playing = false;
    }
}