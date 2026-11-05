/**
 * 子弹视图。
 * 位置与方向都来自快照，表现层仅每帧 setPosition。
 */

import { _decorator, Color, Component, Graphics } from 'cc';
import { Coord } from '../Coord';

const { ccclass, property } = _decorator;

@ccclass('BulletView')
export class BulletView extends Component {
    @property(Graphics) gfx: Graphics = null!;

    init(radius = 5): void {
        const g = this.gfx;
        g.clear();
        g.fillColor = new Color(250, 220, 90, 255);
        g.circle(0, 0, radius);
        g.fill();
        this.node.active = true;
    }

    apply(x: number, y: number): void {
        this.node.setPosition(Coord.toNode(x, y));
    }
}