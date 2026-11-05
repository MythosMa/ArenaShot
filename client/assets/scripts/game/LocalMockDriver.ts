/**
 * P1 本地模拟器 —— 单机跑通战斗闭环用。
 *
 * 它模拟「你 + 一个 Enya 敌人」的小型对战，内部按服务器相同的规则
 * （固定 Tick、左上角原点坐标、圆-AABB 碰撞）推进，并产出**与未来
 * 服务端完全相同的快照/事件结构**。这样 P3 接入真实 Go 服务器时，
 * 客户端世界控制器只需把数据源从 Mock 换成 NetClient，视图层零改动。
 *
 * 注意：这是临时代码，P3 联调后由服务端替换删除，但它的碰撞/伤害规则
 * 会作为服务端 Go 版本实现的逻辑参考。
 */

import { getConfig, GameConfigData } from '../config/GameConfig';
import {
    BulletSnapshot, HitEvent, InputRequest, ItemPickedEvent, ItemSnapshot,
    KillEvent, LeaderboardEntry, ObstacleSnapshot, PlayerSnapshot, Snapshot,
} from '../net/NetTypes';

const LOCAL_ID = 'local';
const ENEMY_ID = 'enemy_1';

interface Pm {
    id: string; name: string;
    x: number; y: number; aim: number;
    radius: number;
    hp: number; maxHp: number;
    alive: boolean;
    respawnAt: number;           // 毫秒时间戳
    fireCdRemain: number;        // 毫秒
    kills: number; deaths: number;
    invincibleUntil: number;
    powerUntil: number;          // 威力 buff 到期时间戳
    speedUntil: number;          // 加速 buff 到期时间戳
}

interface Bm {
    id: string; owner: string; x: number; y: number;
    vx: number; vy: number;
    lifeRemain: number;          // 毫秒
}

interface Obm {
    id: string; type: string; x: number; y: number; w: number; h: number;
    hp: number; broken: boolean; respawnAt: number;
}

interface Im {
    id: string; type: string; x: number; y: number;
}

export class LocalMockDriver {
    /** 每 tick 产生的事件缓冲，供 WorldController 消费后清空。 */
    readonly events: { key: 'hit' | 'kill' | 'item' | 'obstacle' | 'log'; payload: unknown }[] = [];

    get now(): number {
        return this._now;
    }

    private readonly cfg: GameConfigData;
    private _now = Date.now();
    private _tick = 0;
    private _lastTickAt = this._now;
    private _inputSeq = 0;
    private _pending: InputRequest | null = null;

    private readonly players: Pm[] = [];
    private bullets: Bm[] = [];
    private obstacles: Obm[] = [];
    private items: Im[] = [];
    private itemSpawnAccum = 0;
    private idCounter = 0;

    constructor() {
        this.cfg = getConfig();

        const spawn = this.cfg.map.spawnPoints;
        this.players.push(this._newPlayer(LOCAL_ID, '你', spawn[0]));
        this.players.push(this._newPlayer(ENEMY_ID, 'Enya', spawn[1]));
        this.players[1].fireCdRemain = 1200; // 敌人晚点开火，给玩家反应时间

        for (const d of this.cfg.map.obstacles) {
            this.obstacles.push({
                id: d.id, type: d.type, x: d.x, y: d.y, w: d.w, h: d.h,
                hp: this.cfg.obstacles.breakableHp, broken: false, respawnAt: 0,
            });
        }
    }

    /** WorldController 每帧调用：注入本地玩家输入。 */
    feedInput(req: InputRequest): void {
        this._pending = { ...req };
    }

    /** 本地玩家当前位置（服务器坐标），用于计算瞄准；死亡时返回原地。 */
    localPlayerServerPos(): { x: number; y: number } {
        const p = this.players[0];
        return { x: p.x, y: p.y };
    }

    /** 推进模拟（固定 Tick）。dtMs 为渲染帧间隔，内部累积后按步长补帧。 */
    update(dtMs: number): void {
        this._now += dtMs;
        const interval = this.cfg.room.snapshotIntervalMs;
        while (this._now - this._lastTickAt >= interval) {
            this._lastTickAt += interval;
            this._step();
        }
    }

    /** 构建当前快照（供 GameState / 视图消费）。 */
    buildSnapshot(): Snapshot {
        const pc = this.cfg.player;
        return {
            tick: this._tick,
            serverTime: this._now,
            lastProcessedSeq: this._inputSeq,
            players: this.players.map((p) => this._playerSnap(p)),
            bullets: this.bullets.map((b) => ({ id: b.id, owner: b.owner, x: b.x, y: b.y, vx: b.vx, vy: b.vy } as BulletSnapshot)),
            obstacles: this.obstacles.map((o) => ({ id: o.id, type: o.type, broken: o.broken, hp: o.hp, respawnAt: o.respawnAt } as ObstacleSnapshot)),
            items: this.items.map((i) => ({ id: i.id, type: i.type, x: i.x, y: i.y } as ItemSnapshot)),
            leaderboard: this.leaderboard(),
        };
    }

    // ---------------- 模拟核心 ----------------

    private _step(): void {
        this._tick++;
        const dt = this.cfg.room.snapshotIntervalMs / 1000; // 秒

        this._applyLocalInput(dt);
        this._aiUpdate(dt);
        this._stepBullets(dt);
        this._tickDownCooldowns(dt);
        this._handleRespawn();
        this._handleItemSpawn(dt);
        this._handleItemPickup();
    }

    /** 把上帧本地输入应用到玩家。 */
    private _applyLocalInput(dt: number): void {
        const p = this.players[0];
        const inp = this._pending;
        if (inp) {
            p.aim = inp.aim;
            this._pending = null;
            if (p.alive) {
                const speed = this._speedOf(p);
                this._tryMove(p, inp.moveX * speed * dt, inp.moveY * speed * dt);
                if (inp.fire && p.fireCdRemain <= 0) {
                    this._shoot(p);
                }
            }
        }
    }

    /** Enya 简单 AI：靠近 / 保持距离 / 开火。 */
    private _aiUpdate(dt: number): void {
        const me = this.players[0];
        const enemy = this.players[1];
        if (!enemy.alive) return;

        const dx = me.x - enemy.x;
        const dy = me.y - enemy.y;
        const dist = Math.hypot(dx, dy) || 1;

        const sp = this._speedOf(enemy) * dt;
        let tx = 0;
        let ty = 0;
        // 保持距离 240 左右
        if (dist > 340) {
            tx = (dx / dist) * sp;
            ty = (dy / dist) * sp;
        } else if (dist < 200) {
            tx = -(dx / dist) * sp;
            ty = -(dy / dist) * sp;
        }
        this._tryMove(enemy, tx, ty);

        enemy.aim = Math.atan2(dy, dx);
        if (dist < 900 && enemy.fireCdRemain <= 0 && me.alive) {
            enemy.aim += (Math.random() - 0.5) * 0.08; // 少量随机偏移
            this._shoot(enemy);
        }
    }

    private _stepBullets(dt: number): void {
        const pc = this.cfg.player;
        const bulletRadius = pc.radius * 0.4;
        const next: Bm[] = [];
        for (const b of this.bullets) {
            b.lifeRemain -= dt * 1000;
            if (b.lifeRemain <= 0) continue;

            let nx = b.x + b.vx * dt;
            let ny = b.y + b.vy * dt;

            // 越界 -> 消失
            if (nx < 0 || ny < 0 || nx > this.cfg.map.width || ny > this.cfg.map.height) continue;

            // 命中障碍
            const hitObj = this._collideObstacle(nx, ny, bulletRadius);
            if (hitObj) {
                if (hitObj.type === 'breakable' && !hitObj.broken) {
                    this._damageObstacle(hitObj, pc.bulletDamage);
                }
                continue;
            }

            // 命中玩家（不包括自己）
            let hitPlayer: Pm | null = null;
            for (const p of this.players) {
                if (p.id === b.owner || !p.alive) continue;
                if (Math.hypot(p.x - nx, p.y - ny) < p.radius + bulletRadius) {
                    hitPlayer = p;
                    break;
                }
            }
            if (hitPlayer) {
                this._damagePlayer(hitPlayer, b.owner, pc.bulletDamage, nx, ny);
                continue;
            }

            b.x = nx;
            b.y = ny;
            next.push(b);
        }
        this.bullets = next;
    }

    private _damagePlayer(target: Pm, shooterId: string, base: number, x: number, y: number): void {
        if (target.invincibleUntil > this._now) return;

        let dmg = base;
        const shooter = this._p(shooterId);
        if (shooter && shooter.powerUntil > this._now) {
            dmg *= this.cfg.items.powerMultiplier;
        }

        target.hp -= dmg;
        this.events.push({ key: 'hit', payload: { shooterId, targetId: target.id, damage: Math.round(dmg), x, y } as HitEvent });
        this.events.push({ key: 'log', payload: `${shooter?.name ?? '?'} 命中 ${target.name} ${Math.round(dmg)} 点` });

        if (target.hp <= 0) {
            target.alive = false;
            target.respawnAt = this._now + this.cfg.room.respawnDelayMs;
            target.deaths++;
            if (shooter) {
                shooter.kills++;
                this.events.push({
                    key: 'kill',
                    payload: {
                        killerId: shooter.id, killerName: shooter.name,
                        victimId: target.id, victimName: target.name,
                    } as KillEvent,
                });
            }
        }
    }

    private _damageObstacle(o: Obm, dmg: number): void {
        o.hp -= dmg;
        if (o.hp <= 0) {
            o.broken = true;
            o.respawnAt = this._now + this.cfg.obstacles.respawnMs;
            this.events.push({ key: 'obstacle', payload: { obstacleId: o.id, x: o.x, y: o.y } });
        }
    }

    private _shoot(p: Pm): void {
        const pc = this.cfg.player;
        p.fireCdRemain = pc.fireIntervalMs;
        this.bullets.push({
            id: `b_${++this.idCounter}`, owner: p.id,
            x: p.x + Math.cos(p.aim) * (p.radius + 4),
            y: p.y + Math.sin(p.aim) * (p.radius + 4),
            vx: Math.cos(p.aim) * pc.bulletSpeed,
            vy: Math.sin(p.aim) * pc.bulletSpeed,
            lifeRemain: pc.bulletLifeMs,
        });
    }

    private _speedOf(p: Pm): number {
        let s = this.cfg.player.moveSpeed;
        if (p.speedUntil > this._now) s *= this.cfg.items.speedMultiplier;
        return s;
    }

    private _tickDownCooldowns(dt: number): void {
        for (const p of this.players) {
            p.fireCdRemain = Math.max(0, p.fireCdRemain - dt * 1000);
        }
    }

    private _handleRespawn(): void {
        const spawn = this.cfg.map.spawnPoints;
        for (let i = 0; i < this.players.length; i++) {
            const p = this.players[i];
            if (p.alive || this._now < p.respawnAt) continue;
            // 选离其他玩家最远的出生点
            let best = spawn[i % spawn.length];
            let bestDist = -1;
            for (const s of spawn) {
                let dmin = Infinity;
                for (const q of this.players) {
                    if (q === p) continue;
                    dmin = Math.min(dmin, Math.hypot(q.x - s.x, q.y - s.y));
                }
                if (dmin > bestDist) {
                    bestDist = dmin;
                    best = s;
                }
            }
            p.x = best.x;
            p.y = best.y;
            p.hp = p.maxHp;
            p.alive = true;
            p.invincibleUntil = this._now + this.cfg.player.invincibleAfterRespawnMs;
        }
    }

    private _handleItemSpawn(dt: number): void {
        this.itemSpawnAccum += dt * 1000;
        if (this.itemSpawnAccum < this.cfg.items.spawnIntervalMs) return;
        this.itemSpawnAccum = 0;
        if (this.items.length >= this.cfg.items.maxOnMap) return;

        const pt = this.cfg.map.itemSpawnPoints;
        const from = pt[Math.floor(Math.random() * pt.length)];
        const types = ['heal', 'power', 'speed'];
        this.items.push({
            id: `i_${++this.idCounter}`,
            type: types[Math.floor(Math.random() * types.length)],
            x: from.x, y: from.y,
        });
    }

    private _handleItemPickup(): void {
        const rad = this.cfg.player.radius + 24;
        let changed = false;
        for (let i = this.items.length - 1; i >= 0; i--) {
            const it = this.items[i];
            for (const p of this.players) {
                if (!p.alive) continue;
                if (Math.hypot(p.x - it.x, p.y - it.y) < rad) {
                    this._applyItem(p, it.type);
                    this.events.push({
                        key: 'item',
                        payload: { playerId: p.id, itemId: it.id, itemType: it.type, x: it.x, y: it.y } as ItemPickedEvent,
                    });
                    this.items.splice(i, 1);
                    changed = true;
                    break;
                }
            }
        }
        void changed;
    }

    private _applyItem(p: Pm, type: string): void {
        const it = this.cfg.items;
        switch (type) {
            case 'heal':
                p.hp = Math.min(p.maxHp, p.hp + it.healAmount);
                break;
            case 'power':
                p.powerUntil = this._now + it.powerDurationMs;
                break;
            case 'speed':
                p.speedUntil = this._now + it.speedDurationMs;
                break;
        }
    }

    // ---------------- 碰撞与工具 ----------------

    /** 分轴移动 + 碰撞滑动。 */
    private _tryMove(p: Pm, dx: number, dy: number): void {
        if (dx !== 0) {
            const nx = p.x + dx;
            if (!this._circleBlocked(nx, p.y, p.radius)) {
                p.x = nx;
            }
        }
        if (dy !== 0) {
            const ny = p.y + dy;
            if (!this._circleBlocked(p.x, ny, p.radius)) {
                p.y = ny;
            }
        }
        this._clampToMap(p);
    }

    private _circleBlocked(x: number, y: number, r: number): boolean {
        return this._collideObstacle(x, y, r) !== null;
    }

    private _collideObstacle(x: number, y: number, r: number): Obm | null {
        for (const o of this.obstacles) {
            if (o.type === 'breakable' && o.broken) continue;
            if (this._circleRectOverlap(x, y, r, o.x - o.w / 2, o.y - o.h / 2, o.w, o.h)) {
                return o;
            }
        }
        return null;
    }

    private _circleRectOverlap(cx: number, cy: number, cr: number, rx: number, ry: number, rw: number, rh: number): boolean {
        const nx = Math.max(rx, Math.min(cx, rx + rw));
        const ny = Math.max(ry, Math.min(cy, ry + rh));
        return Math.hypot(cx - nx, cy - ny) <= cr;
    }

    private _clampToMap(p: Pm): void {
        const m = this.cfg.map;
        p.x = Math.max(p.radius, Math.min(m.width - p.radius, p.x));
        p.y = Math.max(p.radius, Math.min(m.height - p.radius, p.y));
    }

    private _p(id: string): Pm | undefined {
        return this.players.find((v) => v.id === id);
    }

    private _newPlayer(id: string, name: string, spawn: { x: number; y: number }): Pm {
        return {
            id, name, x: spawn.x, y: spawn.y, aim: 0,
            radius: this.cfg.player.radius,
            hp: this.cfg.player.maxHp, maxHp: this.cfg.player.maxHp, alive: true,
            respawnAt: 0, fireCdRemain: 0, kills: 0, deaths: 0,
            invincibleUntil: this._now + this.cfg.player.invincibleAfterRespawnMs,
            powerUntil: 0, speedUntil: 0,
        };
    }

    private _playerSnap(p: Pm): PlayerSnapshot {
        const buffs: Record<string, number> = {};
        if (p.powerUntil > this._now) buffs['power'] = p.powerUntil;
        if (p.speedUntil > this._now) buffs['speed'] = p.speedUntil;
        return {
            id: p.id, name: p.name, x: p.x, y: p.y, aim: p.aim,
            hp: p.hp, maxHp: p.maxHp, alive: p.alive, respawnAt: p.respawnAt,
            buffs, kills: p.kills, deaths: p.deaths,
        };
    }

    private leaderboard(): LeaderboardEntry[] {
        return this.players
            .map((p) => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths }))
            .sort((a, b) => b.kills - a.kills);
    }
}