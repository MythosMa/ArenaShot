#!/usr/bin/env node
/**
 * 由 ASCII 布局生成地图配置（写入 server/config/game.json 的 map 段）。
 *
 * 用法：bash scripts/gen-map.sh（会同时同步到客户端 resources）
 *
 * 设计：布局是唯一的「人肉可编辑」来源；生成器把相邻同类格子合并成
 * 尽可能大的矩形，既能表达坦克大战式的墙块，又能控制障碍总数，
 * 避免快照里障碍条目过多。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAYOUT_PATH = join(ROOT, 'scripts/map-layout.txt');
const CONFIG_PATH = join(ROOT, 'server/config/game.json');

/** 每格边长（像素）。 */
const TILE = 96;
const VALID_CHARS = new Set(['.', '#', '*', 'S', 'I']);

function fail(msg) {
    console.error(`[gen-map] ${msg}`);
    process.exit(1);
}

// ---- 1. 读取并校验布局 ----
const lines = readFileSync(LAYOUT_PATH, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'));

if (lines.length === 0) fail('布局为空');
const cols = lines[0].length;
lines.forEach((line, i) => {
    if (line.length !== cols) {
        fail(`第 ${i + 1} 行长度 ${line.length}，应与第一行一致（${cols}）`);
    }
    for (const ch of line) {
        if (!VALID_CHARS.has(ch)) fail(`第 ${i + 1} 行含非法字符 '${ch}'`);
    }
});
const rows = lines.length;
const grid = lines.map((line) => [...line]);

// ---- 2. 合并同类相邻格为矩形（贪心：先向右扩展，再整行向下扩展）----
function mergeRects(target) {
    const used = grid.map((row) => row.map(() => false));
    const out = [];
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            if (used[y][x] || grid[y][x] !== target) continue;

            let w = 1;
            while (x + w < cols && !used[y][x + w] && grid[y][x + w] === target) w++;

            let h = 1;
            for (;;) {
                const ny = y + h;
                if (ny >= rows) break;
                let ok = true;
                for (let i = 0; i < w; i++) {
                    if (used[ny][x + i] || grid[ny][x + i] !== target) {
                        ok = false;
                        break;
                    }
                }
                if (!ok) break;
                h++;
            }

            for (let dy = 0; dy < h; dy++) {
                for (let dx = 0; dx < w; dx++) used[y + dy][x + dx] = true;
            }
            out.push({ x, y, w, h });
        }
    }
    return out;
}

// ---- 3. 生成障碍列表 ----
const obstacles = [];
for (const [ch, type, prefix] of [['#', 'solid', 's'], ['*', 'breakable', 'b']]) {
    mergeRects(ch).forEach((r, i) => {
        obstacles.push({
            id: `${prefix}_${i + 1}`,
            type,
            x: (r.x + r.w / 2) * TILE,
            y: (r.y + r.h / 2) * TILE,
            w: r.w * TILE,
            h: r.h * TILE,
        });
    });
}

// ---- 4. 收集出生点与道具点（格子中心）----
const spawnPoints = [];
const itemSpawnPoints = [];
for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
        const ch = grid[y][x];
        if (ch !== 'S' && ch !== 'I') continue;
        const pt = { x: (x + 0.5) * TILE, y: (y + 0.5) * TILE };
        if (ch === 'S') spawnPoints.push(pt);
        else itemSpawnPoints.push(pt);
    }
}
if (spawnPoints.length === 0) fail('布局中没有 S 出生点');

// ---- 5. 写回配置 ----
const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
cfg.map.width = cols * TILE;
cfg.map.height = rows * TILE;
cfg.map.obstacles = obstacles;
cfg.map.spawnPoints = spawnPoints;
cfg.map.itemSpawnPoints = itemSpawnPoints;
writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');

const solidCount = obstacles.filter((o) => o.type === 'solid').length;
console.log(
    `[gen-map] 地图 ${cfg.map.width}×${cfg.map.height}，瓦片 ${TILE}，网格 ${cols}×${rows}`,
);
console.log(
    `[gen-map] 障碍 ${obstacles.length} 个（solid ${solidCount} / breakable ${obstacles.length - solidCount}），` +
    `出生点 ${spawnPoints.length}，道具点 ${itemSpawnPoints.length}`,
);
