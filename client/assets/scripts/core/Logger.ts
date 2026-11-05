/**
 * 分级日志。
 *
 * 开发环境输出 Debug 及以上，生产环境只输出 Warn 及以上。
 * 每条日志带模块标签，方便在控制台过滤。
 *
 * 用法：
 *   const log = createLogger('NetClient');
 *   log.i('已连接', url);
 */

import { DEV } from 'cc/env';

export enum LogLevel {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
    None = 4,
}

let globalLevel: LogLevel = DEV ? LogLevel.Debug : LogLevel.Warn;

export function setLogLevel(level: LogLevel): void {
    globalLevel = level;
}

export interface Logger {
    d(...args: unknown[]): void;
    i(...args: unknown[]): void;
    w(...args: unknown[]): void;
    e(...args: unknown[]): void;
}

export function createLogger(module: string): Logger {
    const prefix = `[${module}]`;
    return {
        d(...args: unknown[]) {
            if (globalLevel <= LogLevel.Debug) {
                console.debug(prefix, ...args);
            }
        },
        i(...args: unknown[]) {
            if (globalLevel <= LogLevel.Info) {
                console.info(prefix, ...args);
            }
        },
        w(...args: unknown[]) {
            if (globalLevel <= LogLevel.Warn) {
                console.warn(prefix, ...args);
            }
        },
        e(...args: unknown[]) {
            if (globalLevel <= LogLevel.Error) {
                console.error(prefix, ...args);
            }
        },
    };
}
