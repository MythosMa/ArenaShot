/**
 * 坐标系转换。
 *
 * 两种坐标系：
 *  1. 「服务器空间」：原点在左上角，y 向下增加。与 game.json 中的坐标一致，
 *     也是未来服务端快照使用的坐标（左上角原点）。
 *  2. 「节点空间」：game_root 位于场景中央，node (0,0) 即地图中心，y 向上。
 *
 * 服务器空间坐标 sx, sy  ->  节点空间  (sx - W/2, H/2 - sy)
 * 角度：服务器空间弧度 θ（+y 向下）-> 节点角度（y 向上）旋转 = -θ。
 */

import { Vec3 } from 'cc';

export class Coord {
    static mapW = 1920;
    static mapH = 1080;

    /** 由配置初始化地图尺寸。 */
    static init(mapW: number, mapH: number): void {
        Coord.mapW = mapW;
        Coord.mapH = mapH;
    }

    /** 服务器空间 -> 节点空间位置。 */
    static toNode(sx: number, sy: number): Vec3 {
        return new Vec3(sx - Coord.mapW / 2, Coord.mapH / 2 - sy, 0);
    }

    /** 节点空间 -> 服务器空间位置。 */
    static toServer(nx: number, ny: number): Vec2Out {
        return { x: nx + Coord.mapW / 2, y: Coord.mapH / 2 - ny };
    }

    /** 服务器角度（弧度，+y 向下）-> 节点旋转角（度，y 向上）。 */
    static serverAngleToNodeDeg(rad: number): number {
        return -rad * 180 / Math.PI;
    }

    /** 节点空间的指向向量 -> 服务器空间角度（弧度）。 */
    static nodeDirToServerAngle(dx: number, dy: number): number {
        return Math.atan2(-dy, dx);
    }
}

export interface Vec2Out {
    x: number;
    y: number;
}