/**
 * 协议编解码（与服务端 internal/protocol/codec.go 对称）。
 *
 * 当前实现：JSON。切换 Protobuf 时只需替换本文件，
 * 业务代码通过 NetCodec.send / NetClient 收发，不受影响。
 */

import { Envelope } from './NetTypes';

/** 编解码接口，未来 Protobuf 实现遵循同一契约。 */
export interface ICodec {
    encode(type: string, seq: number, data: unknown): string;
    decode(raw: string): Envelope;
}

export class Codec implements ICodec {
    encode(type: string, seq: number, data: unknown): string {
        const env: Envelope = { type, seq, data: data ?? undefined };
        return JSON.stringify(env);
    }

    decode(raw: string): Envelope {
        const parsed = JSON.parse(raw) as Partial<Envelope>;
        if (!parsed || typeof parsed.type !== 'string' || parsed.type.length === 0) {
            throw new Error(`[Codec] 非法消息: 缺少 type 字段`);
        }
        return { type: parsed.type, seq: parsed.seq ?? 0, data: parsed.data };
    }
}