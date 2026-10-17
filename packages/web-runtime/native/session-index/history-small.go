package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"

	"github.com/tidwall/gjson"
)

// 仅供 encoding/json 的路由字段使用，切片由当前行的缓冲区持有。
type historyJSONView []byte

func (value *historyJSONView) UnmarshalJSON(raw []byte) error { *value = raw; return nil }

// 小行已在索引时验证；路由只提取字段，正文保持原始 JSON。
func readRawHistoryItem(handle *os.File, source *historyEntry) (historyItem, error) {
	raw := make([]byte, source.Length)
	if _, err := handle.ReadAt(raw, source.Offset); err != nil {
		return historyItem{}, err
	}
	if source.Length > historyWindowBytes && !gjson.ValidBytes(raw) {
		return historyItem{}, errors.New("Invalid transcript JSON")
	}
	var parent *string
	if source.ParentID != "" {
		parent = &source.ParentID
	}
	item := historyItem{EntryID: source.ID, ParentID: parent, Timestamp: source.Timestamp, Kind: source.Type, Payload: raw}
	needsReference := false
	// 图片无论大小都由 Go 管理；工具正文只在存在大字符串时解码。
	if source.Role == "toolResult" && source.Length > historyReferenceThreshold || bytes.Contains(raw, []byte("image")) || bytes.Contains(raw, []byte("\\u")) {
		for position := 0; position < len(raw); {
			quote := bytes.IndexByte(raw[position:], '"')
			if quote < 0 {
				break
			}
			start := position + quote
			position = historyJSONEnd(raw, start)
			token := raw[start:position]
			if source.Role == "toolResult" && len(token)-2 > historyReferenceThreshold || len(token) <= 32 && historyJSONString(token) == "image" {
				needsReference = true
				break
			}
		}
	}
	if source.Role == "toolResult" {
		item.Value = map[string]any{"message": map[string]any{
			"role":       source.Role,
			"toolName":   gjson.GetBytes(raw, "message.toolName").Str,
			"toolCallId": gjson.GetBytes(raw, "message.toolCallId").Str,
		}}
	} else if source.Type == "message" && source.Role == "assistant" {
		var messageRaw, content []byte
		for position := historyJSONSpace(raw, 1); position < len(raw) && raw[position] != '}'; {
			end := historyJSONEnd(raw, position)
			key := historyJSONString(raw[position:end])
			position = historyJSONSpace(raw, historyJSONSpace(raw, end)+1)
			if key == "message" {
				messageRaw = raw[position:]
				break
			}
			position = historyJSONSpace(raw, historyJSONEnd(raw, position))
			if position < len(raw) && raw[position] == ',' {
				position = historyJSONSpace(raw, position+1)
			}
		}
		message := map[string]any{"role": source.Role}
		historyJSONObject(messageRaw, func(key string, value []byte) {
			switch key {
			case "toolName", "toolCallId":
				if text := historyJSONString(value); text != "" {
					message[key] = text
				}
			case "content":
				content = value
			}
		})
		calls := make([]any, 0)
		if historyJSONArray(content, func(part []byte) {
			var id, kind string
			var text, thinking []byte
			historyJSONObject(part, func(key string, value []byte) {
				switch key {
				case "id":
					id = historyJSONString(value)
				case "type":
					kind = historyJSONString(value)
				case "text":
					text = value
				case "thinking":
					thinking = value
				}
			})
			if id != "" {
				calls = append(calls, map[string]any{"id": id})
			}
			if source.Role == "assistant" && (kind == "text" && len(text) > historyReferenceThreshold || kind == "thinking" && len(thinking) > historyReferenceThreshold) {
				needsReference = true
			}
		}) {
			message["content"] = calls
		} else if len(content) > historyReferenceThreshold && content[0] == '"' && source.Role == "assistant" {
			needsReference = true
		}
		item.Value = map[string]any{"message": message}
	}
	if needsReference {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&item.Value); err != nil {
			return historyItem{}, err
		}
		item.Payload = nil
	}
	return item, nil
}
