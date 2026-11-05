/**
 * 道具视图。
 * 按道具类型用不同颜色方块占位，并做轻微旋转动画吸引注意。
 */

import { _decorator, Color, Component, Graphics, tween } from 'cc';

const { ccclass, property } = _decorator;

const ITEM_COLORS: Record<string, Color> = {
    heal: new Color(80, 220, 120, 255),
    power: new Color(230, 90, 90, 255),
    speed: new Color(90, 150, 235, 255),
};

@ccclass('ItemView')
export class ItemView extends Component {
    @property(Graphics) gfx: Graphics = null!;

    init(type: string): void {
        const g = this.gfx;
        g.clear();
        g.fillColor = ITEM_COLORS[type] ?? Color.WHITE;
        g.rect(-14, -14, 28, 28);
        g.fill();
        this.node.active = true;
    }

    /** 进入战斗场景后给一块小旋转，作为拾取提醒。 */
    startPulse(): void {
        this.node.angle = 0;
        tween(this.node)
            .repeatForever(
                tween(this.node)
                    .to(0.8, { angle: 15 })
                    .to(0.8, { angle: 0 }),
            )
            .start();
    }

    hide(): void {
        this.node.active = false;
    }
}