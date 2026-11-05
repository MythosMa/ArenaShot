package protocol

import (
	"encoding/json"
	"fmt"
)

// Codec 协议编解码接口。切换 Protobuf 时替换实现即可。
type Codec interface {
	// Encode 将一条业务消息编码为待发送字节。
	Encode(msgType string, seq uint64, data any) ([]byte, error)

	// Decode 解码接收到的字节为一个封套。
	Decode(raw []byte) (*Envelope, error)
}

// JSONCodec 基于 JSON 的编解码实现。
//
// 优点：可读、调试方便、抓包直观。
// 缺点：包体偏大、解析稍慢。后续可切换为 ProtobufCodec。
type JSONCodec struct{}

// NewJSONCodec 创建 JSON 编解码器。
func NewJSONCodec() *JSONCodec { return &JSONCodec{} }

func (c *JSONCodec) Encode(msgType string, seq uint64, data any) ([]byte, error) {
	env := Envelope{Type: msgType, Seq: seq}
	if data != nil {
		raw, err := json.Marshal(data)
		if err != nil {
			return nil, fmt.Errorf("JSON 编码 data 失败: %w", err)
		}
		env.Data = raw
	}
	return json.Marshal(env)
}

func (c *JSONCodec) Decode(raw []byte) (*Envelope, error) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("JSON 解码失败: %w", err)
	}
	if env.Type == "" {
		return nil, fmt.Errorf("消息缺少 type 字段")
	}
	return &env, nil
}