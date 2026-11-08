/**
 * 道具视图。
 * 用 Graphics 绘制可辨识的图标（治疗十字 / 威力闪电 / 移速双箭头），
 * 配合悬浮、轻摇与出生弹出，不再只是一个纯色方块。
 */

import { _decorator, Color, Component, Graphics } from 'cc';

const { ccclass, property } = _decorator;

const ITEM_COLORS: Record<string, Color> = {
    heal: new Color(70, 200, 110, 255),
    power: new Color(225, 85, 80, 255),
    speed: new Color(85, 145, 235, 255),
};

@ccclass('ItemView')
export class ItemView extends Component {
    @property(Graphics) gfx: Graphics = null!;

    /** 当前绘制类型；相同类型复用节点时跳过重绘。 */
    private _type = '';
    private _animT = 0;
    /** 出生弹出进度 0~1。 */
    private _spawnT = 1;

    /** 道具在快照中首次出现时调用（EntityViewManager 按 id 复用节点）。 */
    init(type: string): void {
        this.node.active = true;
        this._animT = 0;
        this._spawnT = 0;
        if (type !== this._type) {
            this._type = type;
            this._redraw();
        }
    }

    protected update(dt: number): void {
        const n = this.gfx?.node;
        if (!n) return;

        this._animT += dt;
        this._spawnT = Math.min(1, this._spawnT + dt / 0.25);

        const pop = ItemView._easeOutBack(this._spawnT);
        const breathe = 1 + 0.035 * Math.sin(this._animT * 3);
        const s = Math.max(0.01, pop * breathe);
        n.setScale(s, s, 1);
        n.setPosition(0, Math.sin(this._animT * 2.4) * 2, 0);
        n.angle = Math.sin(this._animT * 1.8) * 10;
    }

    private _redraw(): void {
        const g = this.gfx;
        if (!g) return;

        const base = ITEM_COLORS[this._type] ?? Color.WHITE;
        g.clear();

        // 1. 底盘：移速用圆，其余用圆角方块。
        g.lineWidth = 2;
        g.strokeColor = new Color(25, 25, 30, 230);
        g.fillColor = base;
        if (this._type === 'speed') {
            g.circle(0, 0, 14);
        } else {
            g.roundRect(-14, -14, 28, 28, 6);
        }
        g.fill();
        g.stroke();

        // 2. 顶部高光，让底盘有一点体积感。
        g.fillColor = new Color(255, 255, 255, 45);
        g.roundRect(-11, 1, 22, 9, 4);
        g.fill();

        // 3. 类型图标（白色）。
        g.fillColor = new Color(255, 255, 255, 240);
        g.strokeColor = new Color(255, 255, 255, 240);
        if (this._type === 'heal') {
            g.rect(-3, -9, 6, 18);
            g.fill();
            g.rect(-9, -3, 18, 6);
            g.fill();
        } else if (this._type === 'power') {
            // 闪电
            g.moveTo(2, 11);
            g.lineTo(-7, 0);
            g.lineTo(-1, 0);
            g.lineTo(-3, -11);
            g.lineTo(7, 1);
            g.lineTo(1, 1);
            g.close();
            g.fill();
        } else {
            // 加速：两个向右的箭头
            g.lineWidth = 3;
            for (let i = 0; i < 2; i++) {
                const x = -6 + i * 8;
                g.moveTo(x, -5);
                g.lineTo(x + 6, 0);
                g.lineTo(x, 5);
                g.stroke();
            }
        }

        // 4. 外圈提示。
        g.strokeColor = new Color(255, 255, 255, 100);
        g.lineWidth = 1;
        g.circle(0, 0, 20);
        g.stroke();
    }

    /** easeOutBack：道具刷新时「弹」出来，比直接出现更容易被注意到。 */
    private static _easeOutBack(t: number): number {
        if (t >= 1) return 1;
        const c1 = 1.70158;
        const c3 = c1 + 1;
        const p = t - 1;
        return 1 + c3 * p * p * p + c1 * p * p;
    }
}
