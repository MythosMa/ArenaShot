/**
 * 通用对象池。
 *
 * 适用场景：子弹、伤害飘字、命中特效等「高频创建/销毁」的对象。
 * 直接频繁 instantiate/destroy 会造成 GC 抖动和卡顿，池化后复用节点。
 *
 * 用法：
 *   const pool = new ObjectPool<BulletView>(
 *       () => new BulletView(),
 *       (b) => b.reset(),
 *   );
 */

export class ObjectPool<T> {
    private readonly _free: T[] = [];
    private _created = 0;

    /**
     * @param create 创建新对象
     * @param reset  回收时重置对象状态（可选）
     * @param maxSize 池内最多缓存数量，超出部分直接丢弃（可选）
     */
    constructor(
        private readonly create: () => T,
        private readonly reset?: (item: T) => void,
        private readonly maxSize: number = 256,
    ) { }

    /** 取出一个对象，池空则新建。 */
    get(): T {
        const item = this._free.pop();
        if (item !== undefined) {
            return item;
        }
        this._created++;
        return this.create();
    }

    /** 归还对象。池满则丢弃，交由 GC 处理。 */
    put(item: T): void {
        if (this._free.length >= this.maxSize) {
            return;
        }
        this.reset?.(item);
        this._free.push(item);
    }

    /** 当前缓存数量。 */
    get size(): number {
        return this._free.length;
    }

    /** 累计创建过的对象数量，用于调试对象池是否生效。 */
    get createdCount(): number {
        return this._created;
    }

    /** 清空池。切换场景时调用，避免引用旧场景节点。 */
    clear(): void {
        this._free.length = 0;
    }
}
