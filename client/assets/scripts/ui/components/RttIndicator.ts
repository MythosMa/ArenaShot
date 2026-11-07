import { _decorator, Component, Label } from "cc";
import { EventBus, Events } from "../../core/EventBus";
import { NetClient } from "../../net/NetClient";

const { ccclass, property } = _decorator;

/** 订阅 RttUpdated 事件，把网络延迟显示到 Label 上。 */
@ccclass("RttIndicator")
export class RttIndicator extends Component {
  @property(Label) label: Label | null = null;
  @property textPrefix = "延迟 ";

  protected onEnable(): void {
    EventBus.instance.on<number>(Events.RttUpdated, this._onRtt, this);

    // 进入场景时心跳已在运行，先用当前缓存的 RTT 初始化，避免显示默认占位文本。
    if (NetClient.instance.isOpen) {
      this._onRtt(NetClient.instance.rtt);
    }
  }

  protected onDisable(): void {
    EventBus.instance.offTarget(this);
  }

  private _onRtt(rttMs: number): void {
    if (!this.label) return;
    this.label.string = `${this.textPrefix}${Math.round(rttMs)}ms`;
  }
}
