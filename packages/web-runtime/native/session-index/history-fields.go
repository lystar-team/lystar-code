package main

import (
	"bytes"
	"strconv"

	"github.com/tidwall/gjson"
)

func historyParseFields(raw []byte) (historyFields, bool) {
	var fields historyFields
	if !gjson.ValidBytes(raw) {
		return fields, false
	}
	valid := true
	historyJSONObject(raw, func(key string, value []byte) {
		var target *string
		switch key {
		case "type":
			target = &fields.Type
		case "id":
			target = &fields.ID
		case "parentId":
			target = &fields.ParentID
		case "customType":
			target = &fields.CustomType
		case "timestamp":
			target = &fields.Timestamp
		case "data":
			fields.Data = value
		case "message":
			if value[0] != '{' && !bytes.Equal(value, []byte("null")) {
				valid = false
			}
			role := gjson.GetBytes(value, "role")
			if role.Type != gjson.String && role.Type != gjson.Null {
				valid = false
			}
			fields.Message.Role = role.Str
		}
		if target != nil {
			if value[0] != '"' && !bytes.Equal(value, []byte("null")) {
				valid = false
			}
			*target = historyJSONString(value)
		}
	})
	return fields, valid
}

// 旧更新只保存经过验证的步骤 ID，不分配整套关联数组。
func historyStepID(raw []byte) (string, bool) {
	var version, step []byte
	historyJSONObject(raw, func(key string, value []byte) {
		switch key {
		case "version":
			version = value
		case "step":
			step = value
		}
	})
	if !bytes.Equal(version, []byte("1")) {
		return "", false
	}
	var id, title, status, started, calls, entries []byte
	historyJSONObject(step, func(key string, value []byte) {
		switch key {
		case "id":
			id = value
		case "title":
			title = value
		case "status":
			status = value
		case "startedAt":
			started = value
		case "toolCallIds":
			calls = value
		case "messageEntryIds":
			entries = value
		}
	})
	if len(id) == 0 || id[0] != '"' || len(title) == 0 || title[0] != '"' || len(started) == 0 {
		return "", false
	}
	if _, err := strconv.ParseFloat(string(started), 64); err != nil {
		return "", false
	}
	switch historyJSONString(status) {
	case "running", "completed", "failed", "interrupted":
	default:
		return "", false
	}
	valid := true
	if !historyJSONArray(calls, func(value []byte) {
		if value[0] != '"' {
			valid = false
		}
	}) {
		return "", false
	}
	if len(entries) > 0 && !historyJSONArray(entries, func(value []byte) {
		if value[0] != '"' {
			valid = false
		}
	}) {
		return "", false
	}
	return historyJSONString(id), valid
}
