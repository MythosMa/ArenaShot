/**
 * 横屏提示遮罩（手机浏览器 H5）。
 *
 * 竖屏时盖一层半透明底板 + 提示文字，要求旋转设备；横屏时自动隐藏。
 * 不需要修改场景：运行时创建在 HUD 下，纯 Graphics + 系统字体 Label。
 */

import {
    Color, Graphics, Label, Node, screen, UITransform, view,
} from 'cc';

export class OrientationGuard {
    private static readonly BG = new Color(6, 8, 12, 220);
    private static readonly TEXT = new Color(235, 240, 245, 255);

    private readonly _node: Node;
    private readonly _ui: UITransform;
    private readonly _gfx: Graphics;
    private readonly _labelNode: Node;
    /** 当前是否已显示（竖屏）。 */
    private _active = false;

    constructor(parent: Node) {
        const node = new Node('orientation_guard');
        node.layer = parent.layer;
        this._ui = node.addComponent(UITransform);
        node.parent = parent;
        node.active = false;
        this._node = node;
        this._gfx = node.addComponent(Graphics);

        this._labelNode = new Node('orientation_label');
        this._labelNode.layer = parent.layer;
        this._labelNode.parent = node;
        const label = this._labelNode.addComponent(Label);
        label.string = '请旋转设备横屏游玩\nPlease rotate your device';
        label.fontSize = 52;
        label.lineHeight = 74;
        label.color = OrientationGuard.TEXT;
        label.useSystemFont = true;
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        label.verticalAlign = Label.VerticalAlign.CENTER;

        this.tick();
    }

    /** 当前是否处于竖屏（提示遮罩显示中）。 */
    get portrait(): boolean {
        return this._active;
    }

    /** 每帧调用；只在横竖屏切换时做实际工作。 */
    tick(): void {
        const ws = screen.windowSize;
        const portrait = ws.height > ws.width;
        if (portrait === this._active) return;

        this._active = portrait;
        this._node.active = portrait;
        if (portrait) this._layout();
    }

    dispose(): void {
        if (this._node.isValid) this._node.destroy();
    }

    private _layout(): void {
        const vs = view.getVisibleSize();
        const w = Math.max(1, vs.width);
        const h = Math.max(1, vs.height);
        this._ui.setContentSize(w, h);
        this._gfx.clear();
        this._gfx.fillColor = OrientationGuard.BG;
        this._gfx.rect(-w / 2, -h / 2, w, h);
        this._gfx.fill();
        this._labelNode.setPosition(0, 0, 0);
    }
}
