/**
 * 登录/取名界面控制器（Boot 场景）。
 *
 * P1：直接进入本地战斗场景。
 * P2：改为先连接服务器、登录成功后再跳转（连接逻辑接入 NetClient）。
 */

import { _decorator, Button, Component, director, EditBox, EventKeyboard, Input, KeyCode, Label, input } from 'cc';
import { GameContext } from '../game/GameContext';

const { ccclass, property } = _decorator;

@ccclass('LoginController')
export class LoginController extends Component {
    @property(EditBox) nameInput: EditBox = null!;
    @property(Label) statusLabel: Label = null!;
    @property(Label) rttLabel: Label = null!;
    @property(Button) startButton: Button = null!;

    private _starting = false;

    protected onLoad(): void {
        this.startButton?.node.on(Button.EventType.CLICK, this._onStart, this);
        input.on(Input.EventType.KEY_DOWN, this._onKeyDown, this);
        if (this.statusLabel) this.statusLabel.string = '输入名字，点击开始';
        if (this.rttLabel) this.rttLabel.string = 'RTT: -';
    }

    protected onDestroy(): void {
        this.startButton?.node.off(Button.EventType.CLICK, this._onStart, this);
        input.off(Input.EventType.KEY_DOWN, this._onKeyDown, this);
    }

    private _onKeyDown(e: EventKeyboard): void {
        if (e.keyCode === KeyCode.ENTER) {
            this._onStart();
        }
    }

    private _onStart(): void {
        if (this._starting) return;

        const raw = (this.nameInput?.string ?? '').trim();
        const name = raw.length > 0 ? raw.slice(0, 12) : `玩家${Math.floor(Math.random() * 9000 + 1000)}`;

        this._starting = true;
        GameContext.playerName = name;
        if (this.statusLabel) this.statusLabel.string = '进入战场...';
        // 下一帧再切场景，确保当前按钮事件处理完毕
        this.scheduleOnce(() => director.loadScene('Game'), 0);
    }
}