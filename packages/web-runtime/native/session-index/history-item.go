package main

func (h *historyEngine) pageItem(handle *historyReader, path string, file *historyFile, source *historyEntry, options historyOptions) (historyItem, int64, error) {
	if err := handle.ctx.Err(); err != nil {
		return historyItem{}, 0, err
	}
	if options.Compact {
		if cached, ok := file.Compacted[source.Offset]; ok && h.content.refresh(cached.item.Value) {
			return cached.item, cached.bytes, nil
		}
	}
	var value historyItem
	var err error
	if options.Compact {
		value, err = readRawHistoryItem(handle, source)
	} else {
		value, err = readHistoryItem(handle, source, options.MaxLineBytes)
	}
	if err != nil {
		return value, 0, err
	}
	if !options.Compact {
		return value, source.Length - 1, nil
	}
	if value.Payload == nil {
		role, _ := historyMessage(value)["role"].(string)
		if _, err := h.content.compact(path, value.Value, role == "toolResult"); err != nil {
			return value, 0, err
		}
		if role == "assistant" {
			message := historyMessage(value)
			if _, ok := message["content"].(string); ok {
				compacted, err := h.content.compact(path, message["content"], true)
				if err != nil {
					return value, 0, err
				}
				message["content"] = compacted
			} else if parts, ok := message["content"].([]any); ok {
				for _, part := range parts {
					block, ok := part.(map[string]any)
					if !ok {
						continue
					}
					field := ""
					if block["type"] == "text" {
						field = "text"
					} else if block["type"] == "thinking" {
						field = "thinking"
					}
					if field == "" {
						continue
					}
					if text, ok := block[field].(string); ok && len(text) > historyReferenceThreshold {
						reference, err := h.content.reference(path, "text/plain; charset=utf-8", []byte(text), true)
						if err != nil {
							return value, 0, err
						}
						block[field] = reference
					}
				}
			}
		}
	}
	if value.Payload != nil {
		return value, source.Length - 1, nil
	}
	encoded, err := marshalHistoryItem(value)
	if err != nil {
		return value, 0, err
	}
	length := int64(len(encoded))
	value.Encoded = encoded
	cacheBytes := length*3 + 128
	if file.PageBytes+cacheBytes <= 8*1024*1024 {
		if previous, ok := file.Compacted[source.Offset]; ok {
			file.Bytes -= previous.bytes*3 + 128
			file.PageBytes -= previous.bytes*3 + 128
		}
		file.Compacted[source.Offset] = historyCachedItem{value, length}
		file.Bytes += cacheBytes
		file.PageBytes += cacheBytes
	}
	return value, length, nil
}
