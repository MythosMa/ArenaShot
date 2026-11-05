/**
 * 击杀播报：屏幕右侧滚动显示「A 击败了 B」，3 秒后自动消失。
 */

import { _decorator, Color, Component, Label, Node, UIOpacity, tween } from 'cc';
import { EventBus, Events } from '../core/EventBus';
import { KillEvent } from '../net/NetTypes';

const { ccclass, property } = _decorator;

@ccclass('KillFeedController')
export class KillFeedController extends Component {
    @property(Node) container: Node = null!;
    @property(Label) rowTemplate: Label = null!;

    protected onLoad(): void {
        if (this.rowTemplate) {
            // 模板只用于取字体与样式，本身不显示
            this.rowTemplate.node.active = false;
        }
        EventBus.instance.on<KillEvent>(Events.Kill, this._onKill, this);
    }

    protected onDestroy(): void {
        EventBus.instance.offTarget(this);
    }

    private _onKill(ev: KillEvent): void {
        if (!this.container) return;

        const node = new Node('kill_row');
        node.parent = this.container;
        const label = node.addComponent(Label);
        if (this.rowTemplate) {
            label.font = this.rowTemplate.font;
            label.useSystemFont = this.rowTemplate.useSystemFont;
            label.fontSize = this.rowTemplate.fontSize;
            label.lineHeight = this.rowTemplate.lineHeight;
        } else {
            label.fontSize = 22;
            label.lineHeight = 26;
        }
        label.color = new Color(255, 226, 160, 255);
        label.string = `${ev.killerName} 击败了 ${ev.victimName}`;

        const op = node.addComponent(UIOpacity);
        op.opacity = 255;
        // 3 秒后淡出并销毁
        tween(op)
            .delay(2.2)
            .to(0.6, { opacity: 0 })
            .call(() => node.destroy())
            .start();
    }
}