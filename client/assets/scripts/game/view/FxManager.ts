/**
 * 轻量圆环特效管理器。
 *
 * 用于命中火花、拾取/复活光环、击杀爆散等一次性反馈。
 * 节点全部在 fxRoot 下运行时创建并池化复用，动画交给 tween，
 * 不需要美术资源，也不需要每帧手工更新。
 */

import { Color, Graphics, Node, Tween, UIOpacity, UITransform, Vec3, tween } from 'cc';

interface RingFx {
    node: Node;
    gfx: Graphics;
    opacity: UIOpacity;
}

export class FxManager {
    private readonly _pool: RingFx[] = [];
    private readonly _all: RingFx[] = [];

    constructor(private readonly _root: Node) { }

    /**
     * 在节点空间 (x, y) 播放一个扩散圆环。
     * @param x/y      节点空间坐标（不是服务器坐标，调用方先转换）
     * @param r0       起始半径（像素）
     * @param r1       结束半径（像素）
     * @param color    圆环颜色
     * @param duration 持续时间（秒）
     * @param lineWidth 结束时的线宽（像素）
     */
    ring(
        x: number,
        y: number,
        r0: number,
        r1: number,
        color: Color,
        duration = 0.35,
        lineWidth = 3,
    ): void {
        const fx = this._take(r1, color, lineWidth);
        fx.node.active = true;
        fx.node.setPosition(x, y, 0);

        // 用「单位圆 + 缩放」表达半径：线宽按最终半径归一化，
        // 这样缩放到 r1 时线宽正好是 lineWidth，不会因为缩放变得过粗。
        const s0 = Math.max(0.01, r0 / Math.max(0.01, r1));
        fx.node.setScale(s0, s0, 1);
        fx.opacity.opacity = 255;

        Tween.stopAllByTarget(fx.node);
        Tween.stopAllByTarget(fx.opacity);

        tween(fx.node)
            .to(duration, { scale: new Vec3(1, 1, 1) }, { easing: 'quadOut' })
            .call(() => this._recycle(fx))
            .start();
        tween(fx.opacity)
            .to(duration, { opacity: 0 }, { easing: 'quadIn' })
            .start();
    }

    /** 命中火花：小圆点快速向外一冲。 */
    spark(x: number, y: number, color: Color): void {
        this.ring(x, y, 2, 14, color, 0.18, 5);
    }

    /** 场景销毁前停掉所有 tween 并销毁节点。 */
    dispose(): void {
        for (const fx of this._all) {
            Tween.stopAllByTarget(fx.node);
            Tween.stopAllByTarget(fx.opacity);
            if (fx.node.isValid) {
                fx.node.destroy();
            }
        }
        this._pool.length = 0;
        this._all.length = 0;
    }

    private _take(r1: number, color: Color, lineWidth: number): RingFx {
        const fx = this._pool.pop() ?? this._create();
        const g = fx.gfx;
        g.clear();
        g.strokeColor = color;
        // 单位圆半径 1，线宽按 r1 归一化；缩放后得到目标线宽。
        g.lineWidth = lineWidth / Math.max(0.01, r1);
        g.circle(0, 0, 1);
        g.stroke();
        return fx;
    }

    private _create(): RingFx {
        const node = new Node('fx_ring');
        node.layer = this._root.layer;
        node.parent = this._root;
        node.addComponent(UITransform);
        const gfx = node.addComponent(Graphics);
        const opacity = node.addComponent(UIOpacity);
        const fx: RingFx = { node, gfx, opacity };
        this._all.push(fx);
        return fx;
    }

    private _recycle(fx: RingFx): void {
        if (!fx.node.isValid) return; // 场景已销毁
        fx.node.active = false;
        fx.node.setScale(1, 1, 1);
        if (this._pool.indexOf(fx) < 0) {
            this._pool.push(fx);
        }
    }
}
