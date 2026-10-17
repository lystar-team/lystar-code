package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
)

func marshalHistoryItem(item historyItem) ([]byte, error) {
	if item.Encoded != nil {
		return item.Encoded, nil
	}
	payload := item.Payload
	if payload == nil {
		var err error
		payload, err = json.Marshal(item.Value)
		if err != nil {
			return nil, err
		}
	}
	metadata := item
	metadata.Payload, metadata.Value, metadata.Encoded = nil, nil, nil
	header, err := json.Marshal(metadata)
	if err != nil {
		return nil, err
	}
	result := make([]byte, 0, len(header)+len(payload)+12)
	result = append(result, header[:len(header)-1]...)
	result = append(result, `,"payload":`...)
	result = append(result, bytes.TrimSpace(payload)...)
	return append(result, '}'), nil
}

func writeIndexResponse(output *bufio.Writer, reply response) (err error) {
	defer func() {
		if flushErr := output.Flush(); err == nil {
			err = flushErr
		}
	}()
	if reply.Error != nil {
		return json.NewEncoder(output).Encode(reply)
	}
	result := reply.Result
	if page := reply.Transcript; page != nil {
		metadata := *page
		metadata.Items, metadata.ContextCalls, metadata.StepItems = nil, nil, nil
		result, err = json.Marshal(metadata)
		if err != nil {
			return err
		}
		groups := []struct {
			key   string
			items []historyItem
		}{{"items", page.Items}, {"stepItems", page.StepItems}, {"contextCalls", page.ContextCalls}}
		// 每条记录只编码、传输一次，TS 无需组装和解析整页字符串。
		for _, group := range groups {
			for _, item := range group.items {
				encoded, err := marshalHistoryItem(item)
				if err != nil {
					return err
				}
				if _, err := fmt.Fprintf(output, "{\"id\":%d,\"transcriptPart\":%q,\"item\":", reply.ID, group.key); err != nil {
					return err
				}
				if _, err := output.Write(encoded); err != nil {
					return err
				}
				if _, err := output.WriteString("}\n"); err != nil {
					return err
				}
			}
		}
	}
	if _, err := fmt.Fprintf(output, "{\"id\":%d,\"result\":", reply.ID); err != nil {
		return err
	}
	if _, err := output.Write(result); err != nil {
		return err
	}
	_, err = output.WriteString("}\n")
	return err
}
