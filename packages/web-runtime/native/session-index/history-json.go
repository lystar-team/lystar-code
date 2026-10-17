package main

import (
	"bytes"
	"encoding/json"
)

// 输入已由 json.Valid 校验；这里只定位值的边界，不重复解码正文。
func historyJSONEnd(raw []byte, start int) int {
	if raw[start] == '"' {
		position := start + 1
		for position < len(raw) {
			next := bytes.IndexByte(raw[position:], '"')
			if next < 0 {
				return len(raw)
			}
			position += next
			escapes := 0
			for before := position - 1; before > start && raw[before] == '\\'; before-- {
				escapes++
			}
			position++
			if escapes%2 == 0 {
				return position
			}
		}
		return position
	}
	if raw[start] == '{' || raw[start] == '[' {
		depth := 1
		for position := start + 1; position < len(raw); {
			next := bytes.IndexAny(raw[position:], "\"{}[]")
			if next < 0 {
				return len(raw)
			}
			position += next
			switch raw[position] {
			case '"':
				position = historyJSONEnd(raw, position)
			case '{', '[':
				depth++
				position++
			case '}', ']':
				depth--
				position++
				if depth == 0 {
					return position
				}
			}
		}
		return len(raw)
	}
	position := start
	for position < len(raw) {
		switch raw[position] {
		case ',', ']', '}', ' ', '\n', '\r', '\t':
			return position
		}
		position++
	}
	return position
}

func historyJSONSpace(raw []byte, position int) int {
	for position < len(raw) {
		switch raw[position] {
		case ' ', '\n', '\r', '\t':
			position++
		default:
			return position
		}
	}
	return position
}

func historyJSONString(raw []byte) string {
	if len(raw) < 2 || raw[0] != '"' {
		return ""
	}
	if bytes.IndexByte(raw, '\\') < 0 {
		return string(raw[1 : len(raw)-1])
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return value
}

func historyJSONObject(raw []byte, visit func(string, []byte)) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' {
		return
	}
	for position := historyJSONSpace(raw, 1); position < len(raw) && raw[position] != '}'; {
		end := historyJSONEnd(raw, position)
		key := historyJSONString(raw[position:end])
		position = historyJSONSpace(raw, end) + 1
		position = historyJSONSpace(raw, position)
		end = historyJSONEnd(raw, position)
		visit(key, raw[position:end])
		position = historyJSONSpace(raw, end)
		if position < len(raw) && raw[position] == ',' {
			position = historyJSONSpace(raw, position+1)
		}
	}
}

func historyJSONArray(raw []byte, visit func([]byte)) bool {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '[' {
		return false
	}
	for position := historyJSONSpace(raw, 1); position < len(raw) && raw[position] != ']'; {
		end := historyJSONEnd(raw, position)
		visit(raw[position:end])
		position = historyJSONSpace(raw, end)
		if position < len(raw) && raw[position] == ',' {
			position = historyJSONSpace(raw, position+1)
		}
	}
	return true
}
