/**
 * 玩家视图。负责把快照数据渲染到 Player.prefab 节点上。
 *
 * 只做「表现」，不持有任何服务器权威状态；数据全部来自快照。
 */

import { _decorator, Color, Component, Graphics, Label, Node } from "cc";
import { getConfig } from "../../config/GameConfig";
import { PlayerSnapshot } from "../../net/NetTypes";
import { Coord } from "../Coord";

const { ccclass, property } = _decorator;

@ccclass("PlayerView")
export class PlayerView extends Component {
  static readonly HP_W = 36;
  static readonly HP_H = 4;

  @property(Graphics) bodyGraphics: Graphics = null!;
  @property(Node) aimNode: Node = null!;
  @property(Graphics) hpFill: Graphics = null!;
  @property(Label) nameLabel: Label = null!;
  /** 出生/复活无敌光圈，由外部控制显隐。 */
  @property(Node) invincibleNode: Node = null!;

  private _radius = 16;
  private _bodyColor = new Color(120, 200, 120, 255);
  /** 受击闪白剩余时间，>0 时身体画白色。 */
  private _flashT = 0;
  /** 已绘制的血量比例，用于避免每帧重建 Graphics。 */
  private _hpRatio = -1;

  // ---- 快照插值状态（网络模式 20Hz -> 60fps 平滑）----
  /** 服务器坐标下的当前渲染位置。 */
  private _curX = 0;
  private _curY = 0;
  private _fromX = 0;
  private _fromY = 0;
  private _toX = 0;
  private _toY = 0;
  /** 当前插值进度 0~1，1 表示已就位。 */
  private _moveT = 1;
  private _moveDurSec = 0.05;
  /** 上一快照的存活状态，用于复活瞬间直接落位。 */
  private _wasAlive = true;
  /** 视角角度（弧度）插值起点，未插值时跟随 _to。 */
  private _fromAim = 0;
  private _toAim = 0;

  // ---- 程序化动效状态（不依赖美术资源）----
  /** 呼吸/脉动动画累计时间（秒）。 */
  private _animT = 0;
  /** 平滑后的移动速度（节点像素/秒）。 */
  private _speed = 0;
  /** 上一帧的节点坐标，用于估算速度与拉伸方向。 */
  private _lastNx = 0;
  private _lastNy = 0;
  private _hasLastN = false;
  /** 移动方向的节点角度（度），用于让身体沿运动方向拉伸。 */
  private _moveAngleDeg = 0;
  /** 移动相位，随位移推进，驱动上下弹跳。 */
  private _walkPhase = 0;
  /** 出生/复活弹出进度 0~1。 */
  private _spawnT = 1;
  /** 受击顿挫脉冲 0~1。 */
  private _hitPulse = 0;
  /** 开火后坐脉冲 0~1。 */
  private _firePulse = 0;
  /** 满速参考值，仅用于动效强度归一化。 */
  private _maxSpeed = 220;
  /** 无敌光圈是否已绘制（Graphics 只在运行时生成顶点）。 */
  private _invincibleDrawn = false;

  /** 由 EntityViewManager 在创建视图时调用一次。 */
  init(data: PlayerSnapshot, isLocal: boolean, radius: number): void {
    this._radius = radius;
    this._bodyColor = isLocal
      ? new Color(90, 220, 120, 255)
      : new Color(235, 120, 90, 255);
    this.node.active = true;
    if (this.invincibleNode) {
      this.invincibleNode.active = false;
    }
    if (this.nameLabel) {
      this.nameLabel.string = data.name;
    }
    this._hpRatio = -1; // 强制重绘一次血条
    this.apply(data, 0);
    this._redrawBody();
    this._redrawAim();
    this._redrawInvincible();

    // 动效初始状态：首次出现也播放一次弹出，避免角色像贴图一样突然出现。
    this._maxSpeed = Math.max(1, getConfig().player.moveSpeed);
    this._spawnT = 0;
    this._animT = 0;
    this._speed = 0;
    this._hasLastN = false;
  }

  /**
   * 应用最新玩家快照。
   * @param interpMs 非 0 时从「当前渲染位置」向快照位置线性插值，
   *                 消除 20Hz 快照的跳变；0 表示直接落位（本地模拟/首帧/复活）。
   */
  apply(snap: PlayerSnapshot, interpMs = 0): void {
    const wasAlive = this._wasAlive;
    if (interpMs > 0 && wasAlive && snap.alive) {
      this._fromX = this._curX;
      this._fromY = this._curY;
      this._toX = snap.x;
      this._toY = snap.y;
      this._fromAim = this._toAim;
      this._toAim = snap.aim;
      this._moveT = 0;
      this._moveDurSec = interpMs / 1000;
    } else {
      // 直接落位：初始化、本地模拟、或生死状态刚变化（避免复活瞬间横穿地图）。
      this._curX = this._fromX = this._toX = snap.x;
      this._curY = this._fromY = this._toY = snap.y;
      this._toAim = snap.aim;
      this._moveT = 1;
      if (this.aimNode) {
        this.aimNode.angle = Coord.serverAngleToNodeDeg(snap.aim);
      }
      this.node.setPosition(Coord.toNode(snap.x, snap.y));
    }
    this._wasAlive = snap.alive;
    this.node.active = snap.alive;

    // 复活或首次出现：重置速度采样（避免把瞬移当成高速移动），并播放弹出动画。
    if (snap.alive && (!wasAlive || !this._hasLastN)) {
      this._speed = 0;
      this._hasLastN = false;
      if (!wasAlive) {
        this._spawnT = 0;
      }
    }

    this._updateHp(snap.hp, snap.maxHp);
  }

  /** 命中表现：身体短暂闪白并出现一次顿挫脉冲。 */
  playHitFlash(): void {
    this._flashT = 0.08;
    this._hitPulse = 1;
    this._redrawBody();
  }

  /**
   * 开火表现：身体与朝向箭头快速脉冲一次。
   * 由 EntityViewManager 在子弹首次出现在快照里时调用（子弹带 owner），
   * 因此本地与远程玩家都能看到后坐感。
   */
  playFire(): void {
    this._firePulse = 1;
  }

  /** 设置无敌光圈显隐（复活后短暂无敌）。 */
  setInvincible(on: boolean): void {
    if (!this.invincibleNode) return;
    const show = this.node.active && on;
    if (show && !this._invincibleDrawn) {
      this._redrawInvincible();
    }
    this.invincibleNode.active = show;
  }

  destroyView(): void {
    this.node.destroy();
  }

  protected update(dt: number): void {
    if (this._flashT > 0) {
      this._flashT -= dt;
      if (this._flashT <= 0) {
        this._redrawBody();
      }
    }

    if (this._moveT < 1) {
      this._moveT = Math.min(
        1,
        this._moveT + dt / Math.max(this._moveDurSec, 0.001),
      );
      const t = this._moveT;
      this._curX = this._fromX + (this._toX - this._fromX) * t;
      this._curY = this._fromY + (this._toY - this._fromY) * t;
      this.node.setPosition(Coord.toNode(this._curX, this._curY));
      if (this.aimNode) {
        const aim = PlayerView._lerpAngle(this._fromAim, this._toAim, t);
        this.aimNode.angle = Coord.serverAngleToNodeDeg(aim);
      }
    }

    this._updateMotionFx(dt);
  }

  /**
   * 程序化角色动效。角色的美术只是一个纯色圆，这里用缩放/位移的细微变化
   * 让它看起来「有生命」：
   *   - 静止时缓慢呼吸；
   *   - 移动时沿运动方向轻微拉伸，并上下弹跳；
   *   - 开火后坐、受击顿挫、出生弹出；
   *   - 无敌光圈脉动。
   * 全部是标量运算，不新增节点，也不产生每帧分配。
   */
  private _updateMotionFx(dt: number): void {
    this._animT += dt;

    // 1. 由渲染位置估算移动速度与方向（节点空间）。
    const nx = this._curX - Coord.mapW / 2;
    const ny = Coord.mapH / 2 - this._curY;
    if (this._hasLastN && dt > 0) {
      const dx = nx - this._lastNx;
      const dy = ny - this._lastNy;
      // 夹紧上限，防止一次异常快照把速度推到离谱的值。
      const raw = Math.min(Math.sqrt(dx * dx + dy * dy) / dt, 600);
      this._speed += (raw - this._speed) * Math.min(1, dt * 10);
      if (dx * dx + dy * dy > 0.25) {
        this._moveAngleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
      }
    } else {
      this._hasLastN = true;
      this._speed = 0;
    }
    this._lastNx = nx;
    this._lastNy = ny;

    // 2. 脉冲衰减。
    this._hitPulse = Math.max(0, this._hitPulse - dt / 0.18);
    this._firePulse = Math.max(0, this._firePulse - dt / 0.14);
    this._spawnT = Math.min(1, this._spawnT + dt / 0.35);

    // 3. 合成身体缩放：呼吸 × 移动拉伸 × 出生弹出 × 受击/开火脉冲。
    const moveK = Math.min(1, this._speed / this._maxSpeed);
    this._walkPhase += this._speed * dt * 0.09;

    const breathe = 1 + 0.1 * Math.sin(this._animT * 2.4);
    const stretch = 0.13 * moveK;
    const spawn = PlayerView._easeOutBack(this._spawnT);
    const punch = 1 + 0.16 * this._hitPulse;
    const fire = 1 + 0.07 * this._firePulse;
    const k = breathe * spawn * punch * fire;

    const body = this.bodyGraphics?.node;
    if (body) {
      body.angle = this._moveAngleDeg;
      body.setScale(k * (1 + stretch), k * (1 - stretch * 0.8), 1);

      // 移动弹跳 + 开火后坐（沿朝向反方向轻推身体）。
      const bob = moveK * Math.abs(Math.sin(this._walkPhase)) * 1.8;
      const recoil = 2.2 * this._firePulse;
      body.setPosition(
        -Math.cos(this._toAim) * recoil,
        bob + Math.sin(this._toAim) * recoil,
        0,
      );
    }

    // 4. 朝向箭头开火脉冲。
    if (this.aimNode) {
      const s = 1 + 0.12 * this._firePulse;
      this.aimNode.setScale(s, s, 1);
    }

    // 5. 无敌光圈脉动。
    if (this.invincibleNode && this.invincibleNode.active) {
      const rs = 1 + 0.07 * Math.sin(this._animT * 7);
      this.invincibleNode.setScale(rs, rs, 1);
    }
  }

  /** easeOutBack：出生时从 0 轻微过冲再回到 1，有「蹦出来」的感觉。 */
  private static _easeOutBack(t: number): number {
    if (t >= 1) return 1;
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const p = t - 1;
    return 1 + c3 * p * p * p + c1 * p * p;
  }

  /** 最短弧插值角度，避免跨 ±π 边界时方向转一整圈。 */
  private static _lerpAngle(from: number, to: number, t: number): number {
    let d = to - from;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return from + d * t;
  }

  private _updateHp(hp: number, maxHp: number): void {
    if (!this.hpFill) return;
    this.hpFill.node.active = hp < maxHp;
    const ratio = Math.max(0, Math.min(1, hp / Math.max(1, maxHp)));
    if (Math.abs(ratio - this._hpRatio) < 0.001) return; // 血量没变，不重建顶点
    this._hpRatio = ratio;
    const g = this.hpFill;
    g.clear();
    if (ratio > 0) {
      // 血条颜色：绿 -> 黄 -> 红
      g.fillColor = new Color(
        Math.round(255 * (1 - ratio)),
        Math.round(255 * ratio),
        60,
        255,
      );
      g.rect(
        -PlayerView.HP_W / 2,
        -PlayerView.HP_H / 2,
        PlayerView.HP_W * ratio,
        PlayerView.HP_H,
      );
      g.fill();
    }
  }

  private _redrawBody(): void {
    if (!this.bodyGraphics) return;
    const g = this.bodyGraphics;
    g.clear();
    g.fillColor = this._flashT > 0 ? Color.WHITE : this._bodyColor;
    g.circle(0, 0, this._radius);
    g.fill();
  }

  /** 朝向指示：沿 +X 方向画一个箭头，由 aim 节点旋转表达朝向。 */
  private _redrawAim(): void {
    const n = this.aimNode;
    if (!n) return;

    const g = n.getComponent(Graphics);
    if (!g) return;

    const len = this._radius + 6;
    g.clear();
    g.strokeColor = new Color(255, 255, 255, 255);
    g.lineWidth = 3;
    // 箭杆
    g.moveTo(this._radius * 0.4, 0);
    g.lineTo(len, 0);
    g.stroke();
    // 箭头
    g.fillColor = new Color(255, 255, 255, 255);
    g.moveTo(len, 4);
    g.lineTo(len + 6, 0);
    g.lineTo(len, -4);
    g.close();
    g.fill();
  }

  /** 无敌光圈：双圈描边，显隐由 setInvincible 控制，缩放由 update 做脉动。 */
  private _redrawInvincible(): void {
    const g = this.invincibleNode?.getComponent(Graphics);
    if (!g) return;

    const r = this._radius + 7;
    g.clear();
    g.strokeColor = new Color(255, 235, 120, 220);
    g.lineWidth = 2;
    g.circle(0, 0, r);
    g.stroke();

    g.strokeColor = new Color(255, 255, 255, 140);
    g.lineWidth = 1;
    g.circle(0, 0, r - 4);
    g.stroke();
    this._invincibleDrawn = true;
  }
}
