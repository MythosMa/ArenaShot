/**
 * 子弹视图。
 * 位置与方向都来自快照，表现层仅每帧 setPosition。
 */

import { _decorator, Color, Component, Graphics } from 'cc';
import { Coord } from '../Coord';
import { BulletSnapshot } from '../../net/NetTypes';

const { ccclass, property } = _decorator;

@ccclass('BulletView')
export class BulletView extends Component {
    @property(Graphics) gfx: Graphics = null!;

    // ---- 快照插值状态（与 PlayerView 同方案）----
    private _curX = 0;
    private _curY = 0;
    private _fromX = 0;
    private _fromY = 0;
    private _toX = 0;
    private _toY = 0;
    private _moveT = 1;
    private _moveDurSec = 0.05;

    init(radius = 5): void {
        const g = this.gfx;
        g.clear();
        g.fillColor = new Color(250, 220, 90, 255);
        g.circle(0, 0, radius);
        g.fill();
        this.node.active = true;
        this._moveT = 1; // 从对象池取出的节点直接落位，避免从上一次生命周期的位置飞来
    }

    /** @param interpMs 非 0 时从当前渲染位置向快照位置插值；0 表示直接落位。 */
    apply(b: BulletSnapshot, interpMs = 0): void {
        if (interpMs > 0) {
            this._fromX = this._curX;
            this._fromY = this._curY;
            this._toX = b.x;
            this._toY = b.y;
            this._moveT = 0;
            this._moveDurSec = interpMs / 1000;
        } else {
            this._curX = this._fromX = this._toX = b.x;
            this._curY = this._fromY = this._toY = b.y;
            this._moveT = 1;
            this.node.setPosition(Coord.toNode(b.x, b.y));
        }
    }

    protected update(dt: number): void {
        if (this._moveT >= 1) return;
        this._moveT = Math.min(1, this._moveT + dt / Math.max(this._moveDurSec, 0.001));
        const t = this._moveT;
        this._curX = this._fromX + (this._toX - this._fromX) * t;
        this._curY = this._fromY + (this._toY - this._fromY) * t;
        this.node.setPosition(Coord.toNode(this._curX, this._curY));
    }
}