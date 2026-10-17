package main

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/tidwall/gjson"
)

// 正文只保留原始字节；元数据仍校验完整 JSON，并按原类型解码其余字段。
func parseIndexEntry(raw []byte) *entry {
	if !gjson.ValidBytes(raw) {
		return nil
	}
	var parsed entry
	raw = bytes.TrimSpace(raw)
	if raw[0] != '{' {
		if json.Unmarshal(raw, &parsed) != nil {
			return nil
		}
		return &parsed
	}
	fields := make([]byte, 1, 1024)
	fields[0] = '{'
	historyJSONObject(raw, func(key string, value []byte) {
		if strings.EqualFold(key, "data") {
			parsed.Data = value
			return
		}
		encodedKey, _ := json.Marshal(key)
		fields = append(fields, encodedKey...)
		fields = append(fields, ':')
		if strings.EqualFold(key, "message") && value[0] == '{' {
			fields = append(fields, '{')
			historyJSONObject(value, func(key string, value []byte) {
				switch {
				case strings.EqualFold(key, "content"):
					parsed.Message.Content = value
					return
				case strings.EqualFold(key, "details"):
					parsed.Message.Details = value
					return
				}
				encodedKey, _ := json.Marshal(key)
				fields = append(fields, encodedKey...)
				fields = append(fields, ':')
				fields = append(fields, value...)
				fields = append(fields, ',')
			})
			if fields[len(fields)-1] == ',' {
				fields = fields[:len(fields)-1]
			}
			fields = append(fields, '}')
		} else {
			fields = append(fields, value...)
		}
		fields = append(fields, ',')
	})
	if fields[len(fields)-1] == ',' {
		fields = fields[:len(fields)-1]
	}
	fields = append(fields, '}')
	if json.Unmarshal(fields, &parsed) != nil {
		return nil
	}
	return &parsed
}
