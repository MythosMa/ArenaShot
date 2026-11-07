/**
 * 玩家视图。负责把快照数据渲染到 Player.prefab 节点上。
 *
 * 只做「表现」，不持有任何服务器权威状态；数据全部来自快照。
 */

import { _decorator, Color, Component, Graphics, Label, Node } from 'cc';
import { PlayerSnapshot } from '../../net/NetTypes';
import { Coord } from '../Coord';

const { ccclass, property } = _decorator;

@ccclass('PlayerView')
export class PlayerView extends Component {
    static readonly HP_W = 36;
    static readonly HP_H = 4;

    @property(Graphics) bodyGraphics: Graphics = null!;
    @property(Node) aimNode: Node = null!;
    @property(Graphics) hpFill: Graphics = null!;
    @property(Label) nameLabel: Label = null!;
    /** 出生/复活无敌光圈，由外部控制显隐。 */
    @property(Node) invincibleNode: Node = null!;

    private _radius = 16;
    private _bodyColor = new Color(120, 200, 120, 255);
    /** 受击闪白剩余时间，>0 时身体画白色。 */
    private _flashT = 0;
    /** 已绘制的血量比例，用于避免每帧重建 Graphics。 */
    private _hpRatio = -1;

    /** 由 EntityViewManager 在创建视图时调用一次。 */
    init(data: PlayerSnapshot, isLocal: boolean, radius: number): void {
        this._radius = radius;
        this._bodyColor = isLocal
            ? new Color(90, 220, 120, 255)
            : new Color(235, 120, 90, 255);
        this.node.active = true;
        if (this.invincibleNode) {
            this.invincibleNode.active = false;
        }
        if (this.nameLabel) {
            this.nameLabel.string = data.name;
        }
        this._hpRatio = -1; // 强制重绘一次血条
        this.apply(data);
        this._redrawBody();
        this._redrawAim();
    }

    /** 每帧 / 快照到达时应用最新的玩家快照。 */
    apply(snap: PlayerSnapshot): void {
        this.node.setPosition(Coord.toNode(snap.x, snap.y));
        if (this.aimNode) {
            this.aimNode.angle = Coord.serverAngleToNodeDeg(snap.aim);
        }
        this.node.active = snap.alive;
        this._updateHp(snap.hp, snap.maxHp);
    }

    /** 命中表现：身体短暂闪白。 */
    playHitFlash(): void {
        this._flashT = 0.08;
        this._redrawBody();
    }

    /** 设置无敌光圈显隐（复活后短暂无敌）。 */
    setInvincible(on: boolean): void {
        if (this.invincibleNode) {
            this.invincibleNode.active = this.node.active && on;
        }
    }

    destroyView(): void {
        this.node.destroy();
    }

    protected update(): void {
        if (this._flashT > 0) {
            this._flashT -= 0.016;
            if (this._flashT <= 0) {
                this._redrawBody();
            }
        }
    }

    private _updateHp(hp: number, maxHp: number): void {
        if (!this.hpFill) return;
        this.hpFill.node.active = hp < maxHp;
        const ratio = Math.max(0, Math.min(1, hp / Math.max(1, maxHp)));
        if (Math.abs(ratio - this._hpRatio) < 0.001) return; // 血量没变，不重建顶点
        this._hpRatio = ratio;
        const g = this.hpFill;
        g.clear();
        if (ratio > 0) {
            // 血条颜色：绿 -> 黄 -> 红
            g.fillColor = new Color(
                Math.round(255 * (1 - ratio)),
                Math.round(255 * ratio),
                60,
                255,
            );
            g.rect(-PlayerView.HP_W / 2, -PlayerView.HP_H / 2,
                PlayerView.HP_W * ratio, PlayerView.HP_H);
            g.fill();
        }
    }

    private _redrawBody(): void {
        if (!this.bodyGraphics) return;
        const g = this.bodyGraphics;
        g.clear();
        g.fillColor = this._flashT > 0 ? Color.WHITE : this._bodyColor;
        g.circle(0, 0, this._radius);
        g.fill();
    }

    /** 朝向指示：沿 +X 方向画一个箭头，由 aim 节点旋转表达朝向。 */
    private _redrawAim(): void {
        const n = this.aimNode;
        if (!n) return;

        const g = n.getComponent(Graphics);
        if (!g) return;

        const len = this._radius + 6;
        g.clear();
        g.strokeColor = new Color(255, 255, 255, 255);
        g.lineWidth = 3;
        // 箭杆
        g.moveTo(this._radius * 0.4, 0);
        g.lineTo(len, 0);
        g.stroke();
        // 箭头
        g.fillColor = new Color(255, 255, 255, 255);
        g.moveTo(len, 4);
        g.lineTo(len + 6, 0);
        g.lineTo(len, -4);
        g.close();
        g.fill();
    }
}