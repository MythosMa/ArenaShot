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

    play(text: string, colorHex: string): void {
        this.playing = true;
        this.node.active = true;
        this.label.string = text;
        this.label.color = new Color().fromHEX(colorHex);
        this.node.setPosition(0, 0, 0);
        this.node.setScale(1, 1, 1);

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