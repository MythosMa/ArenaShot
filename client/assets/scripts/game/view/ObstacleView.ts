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
    private _hp = 0;
    private _maxHp = 0;
    private _flashTime = 0;

    init(type: string, w: number, h: number): void {
        this._type = type;
        this._w = w;
        this._h = h;
        this._hp = 0;
        this._maxHp = 0;
        this.setBroken(false);
    }

    /** 由快照同步破碎状态。 */
    setBroken(broken: boolean): void {
        this.node.active = !broken;
        if (broken) return;
        this._draw();
    }

    /** 根据剩余 HP 绘制不同程度的裂纹。 */
    setDamage(hp: number, maxHp: number): void {
        if (this._type !== 'breakable') return;
        const previousHp = this._hp;
        this._hp = Math.max(0, hp);
        this._maxHp = Math.max(1, maxHp);
        if (previousHp > 0 && this._hp < previousHp) {
            this._flashTime = 0.1;
        }
        if (this.node.active) this._draw();
    }

    update(dt: number): void {
        if (this._flashTime <= 0) return;
        this._flashTime = Math.max(0, this._flashTime - dt);
        if (this.node.active) this._draw();
    }

    private _draw(): void {
        const g = this.gfx;
        g.clear();
        if (this._type === 'solid') {
            g.fillColor = new Color(90, 90, 100, 255);
        } else {
            const ratio = this._maxHp > 0 ? this._hp / this._maxHp : 1;
            const flash = this._flashTime > 0;
            g.fillColor = flash
                ? new Color(255, 245, 180, 255)
                : ratio <= 0.25
                    ? new Color(170, 105, 85, 255)
                    : ratio <= 0.5
                        ? new Color(160, 125, 95, 255)
                        : new Color(150, 140, 110, 255);
            g.strokeColor = new Color(60, 55, 45, 255);
        }
        g.rect(-this._w / 2, -this._h / 2, this._w, this._h);
        g.fill();
        if (this._type !== 'breakable') return;

        const ratio = this._maxHp > 0 ? this._hp / this._maxHp : 1;
        const cracks = ratio <= 0.25 ? 5 : ratio <= 0.5 ? 4 : ratio <= 0.75 ? 3 : 1;
        g.lineWidth = ratio <= 0.25 ? 3 : 2;
        g.strokeColor = new Color(60, 45, 35, 255);
        for (let i = 0; i < cracks; i++) {
            const x = -this._w * 0.32 + i * this._w * 0.14;
            const y = -this._h * 0.35 + (i % 2) * this._h * 0.18;
            g.moveTo(x, y);
            g.lineTo(x + this._w * 0.18, y + this._h * 0.24);
            if (i % 2 === 0) {
                g.lineTo(x + this._w * 0.1, y + this._h * 0.4);
            }
        }
        g.stroke();
    }
}