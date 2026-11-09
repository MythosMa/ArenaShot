/**
 * 小地图（挂在 HUD 右下角）。纯 Graphics 绘制，不依赖美术资源。
 *
 * 内容：
 *   - 深色圆角底板；
 *   - 障碍：solid 灰块、breakable 砖色块（已破碎的跳过）；
 *   - 玩家：本地绿点（带白圈）、其它红点；
 *   - 白框：当前可视窗口（由世界根跟随偏移反推）。
 *
 * 由 WorldController 按快照频率调用 update() 刷新。
 */

import { Color, Graphics, Node, UITransform, Vec3, view } from 'cc';
import { GameConfigData, ObstacleDefData } from '../config/GameConfig';
import { GameContext } from '../game/GameContext';
import { Snapshot } from '../net/NetTypes';

export class MinimapView {
    /** 地图区域到小地图边缘的留白（像素）。 */
    private static readonly PAD = 10;
    /** 与屏幕右下角的间距（像素）。 */
    private static readonly MARGIN = 16;
    /** 小地图宽度（像素）；高度按地图宽高比推出。 */
    private static readonly WIDTH = 264;

    private static readonly BG = new Color(10, 12, 16, 195);
    private static readonly FRAME = new Color(255, 255, 255, 60);
    private static readonly SOLID = new Color(162, 168, 178, 255);
    private static readonly BRICK = new Color(196, 132, 88, 255);
    private static readonly ME = new Color(96, 224, 128, 255);
    private static readonly OTHER = new Color(235, 120, 90, 255);
    private static readonly VIEW = new Color(255, 255, 255, 210);

    private readonly _node: Node;
    private readonly _gfx: Graphics;
    private readonly _walls: ObstacleDefData[];
    private readonly _w: number;
    private readonly _h: number;
    private readonly _mapW: number;
    private readonly _mapH: number;
    /** 服务器像素 -> 小地图像素。 */
    private readonly _scale: number;
    /** 地图区域在小地图节点坐标系里的左下角。 */
    private readonly _ox: number;
    private readonly _oy: number;
    private readonly _viewportW: number;
    private readonly _viewportH: number;

    constructor(parent: Node, cfg: GameConfigData) {
        this._mapW = cfg.map.width;
        this._mapH = cfg.map.height;
        this._walls = cfg.map.obstacles;

        const w = MinimapView.WIDTH;
        const inner = w - MinimapView.PAD * 2;
        const h = Math.round(inner * (this._mapH / this._mapW) + MinimapView.PAD * 2);

        const node = new Node('minimap');
        node.layer = parent.layer;
        node.addComponent(UITransform).setContentSize(w, h);
        node.parent = parent;

        // HUD 以屏幕中心为原点，x 向右、y 向上；放右下角。
        const vs = view.getVisibleSize();
        node.setPosition(
            vs.width / 2 - MinimapView.MARGIN - w / 2,
            -vs.height / 2 + MinimapView.MARGIN + h / 2,
            0,
        );

        this._node = node;
        this._gfx = node.addComponent(Graphics);
        this._w = w;
        this._h = h;
        // 只留一条甜甜圈：地图区域占满内边距，中心对齐。
        this._scale = Math.min(inner / this._mapW, (h - MinimapView.PAD * 2) / this._mapH);
        this._ox = -this._mapW * this._scale / 2;
        this._oy = -this._mapH * this._scale / 2;
        this._viewportW = vs.width;
        this._viewportH = vs.height;
    }

    /** 服务器坐标 -> 小地图节点坐标。 */
    private toX(sx: number): number {
        return this._ox + sx * this._scale;
    }

    private toY(sy: number): number {
        return this._oy + (this._mapH - sy) * this._scale;
    }

    /**
     * 重绘整个小地图。
     * @param follow 世界根的当前跟随偏移（节点空间），用于反推可视窗口。
     */
    update(snap: Snapshot, follow: Vec3): void {
        const g = this._gfx;
        g.clear();

        // 1. 底板
        g.fillColor = MinimapView.BG;
        g.roundRect(-this._w / 2, -this._h / 2, this._w, this._h, 8);
        g.fill();
        g.strokeColor = MinimapView.FRAME;
        g.lineWidth = 1;
        g.roundRect(-this._w / 2, -this._h / 2, this._w, this._h, 8);
        g.stroke();

        // 2. 障碍（已破碎的可击碎墙跳过）
        const broken = new Set<string>();
        for (const o of snap.obstacles) {
            if (o.broken) broken.add(o.id);
        }
        for (const o of this._walls) {
            if (o.type === 'breakable' && broken.has(o.id)) continue;
            g.fillColor = o.type === 'solid' ? MinimapView.SOLID : MinimapView.BRICK;
            g.rect(
                this.toX(o.x - o.w / 2),
                this.toY(o.y + o.h / 2),
                o.w * this._scale,
                o.h * this._scale,
            );
            g.fill();
        }

        // 3. 玩家
        for (const p of snap.players) {
            if (!p.alive) continue;
            const me = p.id === GameContext.myPlayerId;
            const px = this.toX(p.x);
            const py = this.toY(p.y);
            g.fillColor = me ? MinimapView.ME : MinimapView.OTHER;
            g.circle(px, py, me ? 3.5 : 2.8);
            g.fill();
            if (me) {
                g.strokeColor = MinimapView.VIEW;
                g.lineWidth = 1;
                g.circle(px, py, 5.5);
                g.stroke();
            }
        }

        // 4. 可视窗口（白框）
        const scx = this._mapW / 2 - follow.x;
        const scy = this._mapH / 2 + follow.y;
        g.strokeColor = MinimapView.VIEW;
        g.lineWidth = 1.5;
        g.rect(
            this.toX(scx - this._viewportW / 2),
            this.toY(scy + this._viewportH / 2),
            this._viewportW * this._scale,
            this._viewportH * this._scale,
        );
        g.stroke();
    }

    dispose(): void {
        if (this._node.isValid) {
            this._node.destroy();
        }
    }
}