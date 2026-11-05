/**
 * 障碍视图。
 * 尺寸在创建时由配置决定；破碎/恢复状态由快照驱动切换。
 */

import { _decorator, Color, Component, Graphics } from 'cc';

const { ccclass, property } = _decorator;

@ccclass('ObstacleView')
export class ObstacleView extends Component {
    @property(Graphics) gfx: Graphics = null!;

    private _w = 100;
    private _h = 100;
    /** solid | breakable，决定初始颜色。 */
    private _type = 'solid';

    init(type: string, w: number, h: number): void {
        this._type = type;
        this._w = w;
        this._h = h;
        this.setBroken(false);
    }

    /** 由快照同步破碎状态。 */
    setBroken(broken: boolean): void {
        this.node.active = !broken;
        if (broken) return;
        const g = this.gfx;
        g.clear();
        if (this._type === 'solid') {
            g.fillColor = new Color(90, 90, 100, 255);
        } else {
            g.fillColor = new Color(150, 140, 110, 255);
            g.strokeColor = new Color(60, 55, 45, 255);
        }
        g.rect(-this._w / 2, -this._h / 2, this._w, this._h);
        g.fill();
        // 可破坏障碍画两道裂纹示意
        if (this._type === 'breakable') {
            g.lineWidth = 2;
            g.moveTo(-this._w * 0.25, -this._h * 0.3);
            g.lineTo(this._w * 0.15, this._h * 0.1);
            g.moveTo(-this._w * 0.1, this._h * 0.35);
            g.lineTo(this._w * 0.3, -this._h * 0.15);
            g.stroke();
        }
    }
}