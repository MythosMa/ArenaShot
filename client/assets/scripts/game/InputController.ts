/**
 * 输入控制器：把键鼠输入收集成服务器能理解的 InputRequest。
 *
 * 只负责「采样」，不做任何移动/射击模拟。
 * 输入会交给 LocalMockDriver（P1）或 NetClient（P2/P3）。
 *
 * 键位：W/A/S/D 或方向键移动；鼠标瞄准；左键或 J 射击；空格使用道具。
 */

import { Camera, EventKeyboard, EventMouse, Input, KeyCode, Vec3, input } from 'cc';
import { InputRequest } from '../net/NetTypes';
import { Coord } from './Coord';

const KEY_UP = new Set([KeyCode.KEY_W, KeyCode.ARROW_UP]);
const KEY_DOWN = new Set([KeyCode.KEY_S, KeyCode.ARROW_DOWN]);
const KEY_LEFT = new Set([KeyCode.KEY_A, KeyCode.ARROW_LEFT]);
const KEY_RIGHT = new Set([KeyCode.KEY_D, KeyCode.ARROW_RIGHT]);

export class InputController {
    private up = false;
    private down = false;
    private left = false;
    private right = false;
    private firing = false;
    private useItemQueued = false;

    private readonly _screenPos = new Vec3();
    private readonly _aimWorld = new Vec3();
    /** 本地玩家的世界坐标；必须与 camera.screenToWorld 的结果处于同一坐标系。 */
    private readonly _selfWorld = new Vec3();

    private readonly _keyDown = (e: EventKeyboard): void => {
        if (KEY_UP.has(e.keyCode)) this.up = true;
        else if (KEY_DOWN.has(e.keyCode)) this.down = true;
        else if (KEY_LEFT.has(e.keyCode)) this.left = true;
        else if (KEY_RIGHT.has(e.keyCode)) this.right = true;
        else if (e.keyCode === KeyCode.KEY_J) this.firing = true;
        else if (e.keyCode === KeyCode.SPACE) this.useItemQueued = true;
    };

    private readonly _keyUp = (e: EventKeyboard): void => {
        if (KEY_UP.has(e.keyCode)) this.up = false;
        else if (KEY_DOWN.has(e.keyCode)) this.down = false;
        else if (KEY_LEFT.has(e.keyCode)) this.left = false;
        else if (KEY_RIGHT.has(e.keyCode)) this.right = false;
        else if (e.keyCode === KeyCode.KEY_J) this.firing = false;
    };

    private readonly _mouseDown = (e: EventMouse): void => {
        if (e.getButton() === EventMouse.BUTTON_LEFT) this.firing = true;
    };

    private readonly _mouseUp = (e: EventMouse): void => {
        if (e.getButton() === EventMouse.BUTTON_LEFT) this.firing = false;
    };

    private readonly _mouseMove = (e: EventMouse): void => {
        const loc = e.getLocation();
        this._screenPos.set(loc.x, loc.y, 0);
    };

    constructor(private readonly camera: Camera) {
        input.on(Input.EventType.KEY_DOWN, this._keyDown, this);
        input.on(Input.EventType.KEY_UP, this._keyUp, this);
        input.on(Input.EventType.MOUSE_DOWN, this._mouseDown, this);
        input.on(Input.EventType.MOUSE_UP, this._mouseUp, this);
        input.on(Input.EventType.MOUSE_MOVE, this._mouseMove, this);
    }

    /** 每帧把「我的世界坐标」告诉输入层，用于计算瞄准方向。 */
    setSelfWorldPos(x: number, y: number): void {
        this._selfWorld.set(x, y, 0);
    }

    /** 采样一帧输入。 */
    getInput(): InputRequest {
        // 移动向量（服务器空间：上=Y-，下=Y+）
        let moveX = 0;
        let moveY = 0;
        if (this.left) moveX = -1;
        if (this.right) moveX = 1;
        if (this.up) moveY = -1;
        if (this.down) moveY = 1;
        if (moveX !== 0 && moveY !== 0) {
            // 斜向归一化
            const inv = 1 / Math.SQRT2;
            moveX *= inv;
            moveY *= inv;
        }

        // 瞄准：鼠标屏幕坐标 -> 世界坐标 -> 服务器角度。
        // 注意 screenToWorld(screenPos, out) 的第一个参数是屏幕坐标，第二个才是输出，
        // 写反了会把 (0,0) 当成鼠标位置，导致朝向恒指向屏幕左下角。
        // 另外 screenToWorld 返回「世界坐标」，玩家节点位于 Canvas 局部坐标系
        // （原点在屏幕中心），两者必须用同一个坐标系相减。世界与节点坐标系轴向一致，
        // 可直接复用该角度转换。
        this.camera.screenToWorld(this._screenPos, this._aimWorld);
        const dx = this._aimWorld.x - this._selfWorld.x;
        const dy = this._aimWorld.y - this._selfWorld.y;
        const aim = Coord.nodeDirToServerAngle(dx, dy);

        const useItem = this.useItemQueued;
        this.useItemQueued = false;

        return {
            moveX,
            moveY,
            aim,
            fire: this.firing,
            useItem,
            clientTime: Date.now(),
        };
    }

    dispose(): void {
        input.off(Input.EventType.KEY_DOWN, this._keyDown, this);
        input.off(Input.EventType.KEY_UP, this._keyUp, this);
        input.off(Input.EventType.MOUSE_DOWN, this._mouseDown, this);
        input.off(Input.EventType.MOUSE_UP, this._mouseUp, this);
        input.off(Input.EventType.MOUSE_MOVE, this._mouseMove, this);
    }
}