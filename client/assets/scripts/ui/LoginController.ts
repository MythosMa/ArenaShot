/**
 * 登录/取名界面控制器（Boot 场景）。
 *
 * P2：连接服务器 -> 登录 -> 加入战斗 -> 进入 Game 场景。
 * 连接使用 NetClient 单例，切场景后连接保持不动。
 */

import {
  _decorator,
  Button,
  Component,
  director,
  EditBox,
  EventKeyboard,
  Input,
  isValid,
  KeyCode,
  Label,
  input,
  ResolutionPolicy,
  view,
  sys,
} from "cc";
import { GameContext } from "../game/GameContext";
import { NetClient, defaultWsUrl } from "../net/NetClient";

const { ccclass, property } = _decorator;

@ccclass("LoginController")
export class LoginController extends Component {
  @property(EditBox) nameInput: EditBox = null!;
  @property(Label) statusLabel: Label = null!;
  @property(Button) startButton: Button = null!;
  @property(Label) controllerLabel: Label = null!;

  private _starting = false;

  protected onLoad(): void {
    // 统一 16:9 居中显示：超宽屏两侧留黑边，不让视界外的内容被渲染。
    view.setDesignResolutionSize(1920, 1080, ResolutionPolicy.SHOW_ALL);
    this.startButton?.node?.on(Button.EventType.CLICK, this._onStart, this);
    input.on(Input.EventType.KEY_DOWN, this._onKeyDown, this);
    if (this.statusLabel) this.statusLabel.string = "输入名字，点击开始";
    if (sys.isMobile) {
      this.controllerLabel.string =
        "左手触摸控制移动，右手触摸旋转控制设射击和方向";
    } else {
      this.controllerLabel.string = "W/S/A/D 控制移动，鼠标控制面向/左键设计";
    }
  }

  protected onDestroy(): void {
    this.startButton?.node?.off(Button.EventType.CLICK, this._onStart, this);
    input.off(Input.EventType.KEY_DOWN, this._onKeyDown, this);
    NetClient.instance.onRtt = null;
  }

  private _onKeyDown(e: EventKeyboard): void {
    if (e.keyCode === KeyCode.ENTER) {
      void this._onStart();
    }
  }

  private async _onStart(): Promise<void> {
    if (this._starting) return;

    const raw = (this.nameInput?.string ?? "").trim();
    const name =
      raw.length > 0
        ? raw.slice(0, 12)
        : `玩家${Math.floor(Math.random() * 9000 + 1000)}`;

    this._starting = true;
    if (this.startButton) this.startButton.interactable = false;
    GameContext.playerName = name;

    try {
      const net = NetClient.instance;
      const url = GameContext.serverUrl || defaultWsUrl();

      this._setStatus("连接服务器...");
      await net.connect(url);

      this._setStatus("登录中...");
      const login = await net.login(name);
      GameContext.myPlayerId = login.playerId;
      GameContext.sessionId = login.sessionId;

      this._setStatus("加入房间...");
      const joinResult = await net.join();
      GameContext.queuePos = joinResult.spectator ? joinResult.queuePos : 0;

      net.startPing();
      this._setStatus("进入战场...");
      // 下一帧再切场景，确保当前按钮事件处理完毕
      this.scheduleOnce(() => director.loadScene("Game"), 0);
    } catch (err) {
      // 登录/入房任一步失败都断开连接，否则重试会复用已登录的连接并收到 409。
      NetClient.instance.close();
      this._starting = false;
      if (this.startButton) this.startButton.interactable = true;
      this._setStatus(`连接失败: ${(err as Error).message}`);
      console.error("[Login] 登录失败:", err);
    }
  }

  private _setStatus(text: string): void {
    if (isValid(this) && this.statusLabel) {
      this.statusLabel.string = text;
    }
  }
}
