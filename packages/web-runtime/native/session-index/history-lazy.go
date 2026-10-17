package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
)

func (f *historyFile) readHeader(handle *os.File, maxLine int64) error {
	reader := bufio.NewReaderSize(io.NewSectionReader(handle, 0, f.Complete), int(historyWindowBytes))
	var offset int64
	for offset < f.Complete {
		var line []byte
		for {
			part, err := reader.ReadSlice('\n')
			if int64(len(line)+len(part)-1) > maxLine {
				return historyLineError(maxLine)
			}
			line = append(line, part...)
			if errors.Is(err, bufio.ErrBufferFull) {
				continue
			}
			if err != nil {
				return err
			}
			break
		}
		offset += int64(len(line))
		f.HeaderLineBytes = max(f.HeaderLineBytes, int64(len(line)-1))
		if !json.Valid(line) {
			continue
		}
		var header struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if json.Unmarshal(line, &header) != nil || header.Type != "session" || header.ID == "" {
			break
		}
		f.SessionID, f.HeaderLength = header.ID, offset
		return nil
	}
	return errors.New("Session file has no valid header")
}

// Index another suffix block only when a requested ancestor is not yet known.
func (f *historyFile) expand(handle *os.File, maxLine int64) error {
	end := f.ScannedFrom
	start := max(f.HeaderLength, end-256*1024)
	buffer := make([]byte, historyWindowBytes)
	for start > f.HeaderLength {
		previous := max(f.HeaderLength, start-historyWindowBytes)
		n, err := handle.ReadAt(buffer[:start-previous], previous)
		if err != nil {
			return err
		}
		if newline := bytes.LastIndexByte(buffer[:n], '\n'); newline >= 0 {
			start = previous + int64(newline) + 1
			break
		}
		start = previous
	}
	if err := indexHistoryRows(handle, f, start, end, maxLine); err != nil {
		return err
	}
	f.ScannedFrom = start
	return nil
}

func (s *historyContentStore) refresh(value any) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expire()
	var visit func(any) bool
	visit = func(value any) bool {
		switch item := value.(type) {
		case []any:
			for _, value := range item {
				if !visit(value) {
					return false
				}
			}
		case map[string]any:
			if item["type"] == "content_ref" {
				id, _ := item["contentRef"].(string)
				entry := s.entries[id]
				if entry == nil {
					return false
				}
				s.touch(entry)
				return true
			}
			for _, value := range item {
				if !visit(value) {
					return false
				}
			}
		}
		return true
	}
	return visit(value)
}
