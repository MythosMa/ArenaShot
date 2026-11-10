/**
 * 战斗 HUD：血量、Buff、排行榜。
 * 所有数据都来自 EventBus 转发的事件，不直接访问世界数据。
 */

import { _decorator, Color, Component, Graphics, Label } from "cc";
import { EventBus, Events } from "../core/EventBus";
import { GameContext } from "../game/GameContext";
import { LeaderboardEntry, PlayerSnapshot, Snapshot } from "../net/NetTypes";

const { ccclass, property } = _decorator;

const HP_W = 200;
const HP_H = 14;

/** buff 键 -> 中文名。服务端下发的都是英文键，这里做一次友好化。 */
const BUFF_NAMES: Record<string, string> = {
  power: "威力",
  speed: "移速",
  invincible: "无敌",
};

@ccclass("HUDController")
export class HUDController extends Component {
  @property(Graphics) hpFill: Graphics = null!;
  @property(Label) hpText: Label = null!;
  @property(Graphics) buffBg: Graphics = null!;
  @property(Label) buffText: Label = null!;
  @property(Label) leaderboardLabel: Label = null!;

  /** 上一帧的绘制结果，值没变就跳过重建，避免每帧刷新 Graphics/Label。 */
  private _hpRatio = -1;
  private _hpStr = "";
  private _buffStr = "";
  private _boardStr = "";

  protected onLoad(): void {
    EventBus.instance.on<Snapshot>(Events.Snapshot, this._onSnapshot, this);
    EventBus.instance.on<LeaderboardEntry[]>(
      Events.Leaderboard,
      this._onLeaderboard,
      this,
    );
  }

  protected onDestroy(): void {
    EventBus.instance.offTarget(this);
    // EventBus 的 offTarget 按 target 清理
  }

  /** 观战时隐藏只属于本玩家的血量与 Buff 信息，排行榜继续保留。 */
  setPlayerStatusVisible(visible: boolean): void {
    this.hpFill?.node && (this.hpFill.node.active = visible);
    this.hpText?.node && (this.hpText.node.active = visible);
    this.buffBg?.node && (this.buffBg.node.active = visible);
    this.buffText?.node && (this.buffText.node.active = visible);
  }

  private _onSnapshot(snap: Snapshot): void {
    const meId = GameContext.myPlayerId;
    const me: PlayerSnapshot | undefined = snap.players.find(
      (p) => p.id === meId,
    );
    if (!me) return;

    // 血条
    if (this.hpFill) {
      const ratio = Math.max(0, Math.min(1, me.hp / Math.max(1, me.maxHp)));
      if (Math.abs(ratio - this._hpRatio) >= 0.001) {
        this._hpRatio = ratio;
        const g = this.hpFill;
        g.clear();
        g.fillColor =
          ratio > 0.5
            ? new Color(80, 210, 120, 255)
            : ratio > 0.25
              ? new Color(235, 200, 70, 255)
              : new Color(235, 80, 80, 255);
        g.rect(-HP_W / 2, -HP_H / 2, HP_W * ratio, HP_H);
        g.fill();
      }
    }
    if (this.hpText) {
      const hpStr = me.alive
        ? `${Math.max(0, Math.ceil(me.hp))} / ${me.maxHp}`
        : "已阵亡";
      if (hpStr !== this._hpStr) {
        this._hpStr = hpStr;
        this.hpText.string = hpStr;
      }
    }

    // Buff 展示
    if (this.buffText) {
      const parts: string[] = [];
      const now = snap.serverTime;
      // 用 for-in 遍历 buffs，避免依赖 Object.entries（低版本 lib 无此 API）
      const buffs = me.buffs ?? {};
      for (const key in buffs) {
        const until = buffs[key];
        if (until > now) {
          const left = ((until - now) / 1000).toFixed(1);
          parts.push(`${BUFF_NAMES[key] ?? key} ${left}s`);
        }
      }
      const buffStr = parts.join("   ");
      if (buffStr !== this._buffStr) {
        this._buffStr = buffStr;
        this.buffText.string = buffStr;
      }
    }
  }

  private _onLeaderboard(list: LeaderboardEntry[]): void {
    if (!this.leaderboardLabel) return;
    const lines = list.map(
      (e, i) => `${i + 1}. ${e.name}  ${e.kills}/${e.deaths}`,
    );
    const text = lines.join("\n");
    if (text === this._boardStr) return;
    this._boardStr = text;
    this.leaderboardLabel.string = text;
  }
}
