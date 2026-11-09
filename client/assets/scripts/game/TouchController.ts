/**
 * 触屏双摇杆输入（手机浏览器 H5）。
 *
 * 左半屏按下 -> 浮动摇杆移动；右半屏按下 -> 浮动摇杆瞄准并持续开火。
 * 摇杆基点跟随手指落点，拖动方向即输入方向，松手即复位。
 *
 * 与 InputController 的关系：键鼠仍照常采样，触屏模式下由 apply()
 * 覆盖移动/瞄准/开火字段，二者共用同一个 InputRequest。
 *
 * 所有图形都是运行时 Graphics 绘制，不依赖美术资源，也不需要改场景。
 */

import {
    Camera, Color, EventTouch, Graphics, input, Input, Node, UITransform, Vec3,
} from 'cc';
import { InputRequest } from '../net/NetTypes';
import { Coord } from './Coord';

export class TouchController {
    /** 摇杆底盘半径（设计分辨率像素）。 */
    private static readonly BASE_R = 84;
    /** 摇杆最大行程。 */
    private static readonly STICK_R = 110;
    /** 摇杆头半径。 */
    private static readonly KNOB_R = 34;
    /** 死区（占最大行程的比例），低于此值不产生移动/开火。 */
    private static readonly DEAD_ZONE = 0.18;

    private static readonly BASE_FILL = new Color(8, 10, 14, 120);
    private static readonly RING = new Color(255, 255, 255, 110);
    private static readonly LEFT = new Color(120, 200, 255, 210);
    private static readonly RIGHT = new Color(255, 190, 110, 220);

    private readonly _ui: UITransform;
    private readonly _leftNode: Node;
    private readonly _leftGfx: Graphics;
    private readonly _rightNode: Node;
    private readonly _rightGfx: Graphics;

    /** 当前被摇杆占用的触点 id；null 表示空闲。 */
    private _leftTouchId: number | null = null;
    private _rightTouchId: number | null = null;

    /** 左摇杆输出（服务器空间：上=Y-，下=Y+）。 */
    private _moveX = 0;
    private _moveY = 0;

    /** 最近一次瞄准角度（服务器空间弧度）。 */
    private _aim = 0;
    private _fire = false;
    /** 是否已经发生过触屏操作：进入触屏模式后始终由触屏接管瞄准。 */
    private _touchMode = false;

    private readonly _screen = new Vec3();
    private readonly _world = new Vec3();
    private readonly _p = new Vec3();

    constructor(parent: Node, private readonly _camera: Camera) {
        this._ui = parent.getComponent(UITransform) ?? parent.addComponent(UITransform);

        this._leftNode = this._makeStickNode('touch_stick_left', parent);
        this._leftGfx = this._leftNode.addComponent(Graphics);
        this._rightNode = this._makeStickNode('touch_stick_right', parent);
        this._rightGfx = this._rightNode.addComponent(Graphics);

        input.on(Input.EventType.TOUCH_START, this._onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this._onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this._onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this._onTouchEnd, this);
    }

    /** 把触屏输入合并进键鼠采样结果（触屏模式下完全接管这些字段）。 */
    apply(req: InputRequest): void {
        if (!this._touchMode) return;

        // 触屏模式下完全由摇杆决定，避免松手后回落到鼠标/键盘的残留状态。
        req.moveX = this._leftTouchId !== null ? this._moveX : 0;
        req.moveY = this._leftTouchId !== null ? this._moveY : 0;
        req.aim = this._aim;
        req.fire = this._fire;
    }

    dispose(): void {
        input.off(Input.EventType.TOUCH_START, this._onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this._onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this._onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this._onTouchEnd, this);
        if (this._leftNode.isValid) this._leftNode.destroy();
        if (this._rightNode.isValid) this._rightNode.destroy();
    }

    private _makeStickNode(name: string, parent: Node): Node {
        const node = new Node(name);
        node.layer = parent.layer;
        node.addComponent(UITransform).setContentSize(
            TouchController.STICK_R * 2,
            TouchController.STICK_R * 2,
        );
        node.parent = parent;
        node.active = false;
        return node;
    }

    private readonly _onTouchStart = (e: EventTouch): void => {
        const p = this._toLocal(e);
        // 16:9 保持居中时，屏幕两侧/上下可能有黑边；落在黑边上的触点不算操作。
        if (!this._inside(p)) return;
        this._touchMode = true;
        if (p.x < 0) {
            if (this._leftTouchId !== null) return;
            this._leftTouchId = e.getID();
            this._leftNode.setPosition(p);
            this._leftNode.active = true;
            this._setLeft(0, 0);
        } else {
            if (this._rightTouchId !== null) return;
            this._rightTouchId = e.getID();
            this._rightNode.setPosition(p);
            this._rightNode.active = true;
            this._setRight(0, 0);
        }
    };

    private readonly _onTouchMove = (e: EventTouch): void => {
        const id = e.getID();
        if (id === this._leftTouchId) {
            const p = this._toLocal(e);
            const base = this._leftNode.position;
            this._setLeft(p.x - base.x, p.y - base.y);
        } else if (id === this._rightTouchId) {
            const p = this._toLocal(e);
            const base = this._rightNode.position;
            this._setRight(p.x - base.x, p.y - base.y);
        }
    };

    private readonly _onTouchEnd = (e: EventTouch): void => {
        const id = e.getID();
        if (id === this._leftTouchId) {
            this._leftTouchId = null;
            this._moveX = 0;
            this._moveY = 0;
            this._leftNode.active = false;
        } else if (id === this._rightTouchId) {
            this._rightTouchId = null;
            this._fire = false;
            this._rightNode.active = false;
        }
    };

    /**
     * 触点 -> HUD 局部坐标（原点在屏幕中心，y 向上）。
     *
     * 与 InputController 的鼠标瞄准走同一条转换链（screenToWorld -> 节点空间），
     * 避免 getUILocation 与 UI 世界坐标的差异。
     */
    private _toLocal(e: EventTouch): Vec3 {
        const loc = e.getLocation();
        this._screen.set(loc.x, loc.y, 0);
        this._camera.screenToWorld(this._screen, this._world);
        this._ui.convertToNodeSpaceAR(this._world, this._p);
        return this._p;
    }

    /** 是否落在可视设计区域内（排除 16:9 居中留出的黑边）。 */
    private _inside(p: Vec3): boolean {
        const cs = this._ui.contentSize;
        return Math.abs(p.x) <= cs.width / 2 && Math.abs(p.y) <= cs.height / 2;
    }

    private _setLeft(dx: number, dy: number): void {
        const len = Math.hypot(dx, dy);
        const clamped = Math.min(len, TouchController.STICK_R);
        const nx = len > 0 ? dx / len : 0;
        const ny = len > 0 ? dy / len : 0;

        if (len < TouchController.STICK_R * TouchController.DEAD_ZONE) {
            this._moveX = 0;
            this._moveY = 0;
        } else {
            // 节点 y 向上、服务器 y 向下，移动分量取反。
            this._moveX = nx * (clamped / TouchController.STICK_R);
            this._moveY = -ny * (clamped / TouchController.STICK_R);
        }

        // 摇杆头不超出最大行程
        const k = len > 0 ? Math.min(1, TouchController.STICK_R / len) : 0;
        this._drawStick(this._leftGfx, dx * k, dy * k, TouchController.LEFT);
    }

    private _setRight(dx: number, dy: number): void {
        const len = Math.hypot(dx, dy);
        if (len >= TouchController.STICK_R * TouchController.DEAD_ZONE) {
            this._aim = Coord.nodeDirToServerAngle(dx, dy);
            this._fire = true;
        } else {
            this._fire = false;
        }

        const k = len > 0 ? Math.min(1, TouchController.STICK_R / len) : 0;
        this._drawStick(this._rightGfx, dx * k, dy * k, TouchController.RIGHT);
    }

    private _drawStick(g: Graphics, dx: number, dy: number, knob: Color): void {
        g.clear();

        g.fillColor = TouchController.BASE_FILL;
        g.circle(0, 0, TouchController.BASE_R);
        g.fill();
        g.strokeColor = TouchController.RING;
        g.lineWidth = 2;
        g.circle(0, 0, TouchController.BASE_R);
        g.stroke();

        g.fillColor = knob;
        g.circle(dx, dy, TouchController.KNOB_R);
        g.fill();
        g.strokeColor = TouchController.RING;
        g.lineWidth = 2;
        g.circle(dx, dy, TouchController.KNOB_R);
        g.stroke();
    }
}
