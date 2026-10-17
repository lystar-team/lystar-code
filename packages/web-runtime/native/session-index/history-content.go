package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const historyReferenceThreshold = 64 * 1024
const historyMaxContentBytes = 64 * 1024 * 1024
const historyMaxStoredBytes = 128 * 1024 * 1024
const historyContentTTL = 15 * time.Minute

type historyContent struct {
	SessionPath, FilePath, MimeType string
	Size                            int64
	Expires                         time.Time
	Used                            uint64
}

type historyContentStore struct {
	mu        sync.Mutex
	directory string
	entries   map[string]*historyContent
	bytes     int64
	clock     uint64
}

func (s *historyContentStore) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.directory != "" {
		os.RemoveAll(s.directory)
	}
}

func (s *historyContentStore) delete(id string) {
	entry := s.entries[id]
	os.Remove(entry.FilePath)
	s.bytes -= entry.Size
	delete(s.entries, id)
}

func (s *historyContentStore) expire() {
	now := time.Now()
	for id, entry := range s.entries {
		if !entry.Expires.After(now) {
			s.delete(id)
		}
	}
}

func (s *historyContentStore) touch(entry *historyContent) {
	s.clock++
	entry.Used, entry.Expires = s.clock, time.Now().Add(historyContentTTL)
}

func historyUTF8Preview(data []byte, start, end int) string {
	for start < end && !utf8.RuneStart(data[start]) {
		start++
	}
	for end > start && !utf8.Valid(data[start:end]) {
		end--
	}
	return string(data[start:end])
}

func (s *historyContentStore) reference(path, mime string, data []byte, text bool) (map[string]any, error) {
	if len(data) > historyMaxContentBytes {
		return nil, &indexError{fmt.Sprintf("Tool output exceeds the %d byte content reference limit", historyMaxContentBytes), "content_too_large", false}
	}
	hash := sha256.New()
	io.WriteString(hash, path+"\x00"+mime+"\x00")
	hash.Write(data)
	key := hex.EncodeToString(hash.Sum(nil))
	id := "native:" + key
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expire()
	entry := s.entries[id]
	if entry == nil {
		if s.directory == "" {
			directory, err := os.MkdirTemp("", "lystar-history-content-")
			if err != nil {
				return nil, err
			}
			s.directory = directory
			s.entries = make(map[string]*historyContent)
		}
		for s.bytes+int64(len(data)) > historyMaxStoredBytes {
			var oldest string
			var used uint64 = ^uint64(0)
			for key, candidate := range s.entries {
				if candidate.Used < used {
					oldest, used = key, candidate.Used
				}
			}
			s.delete(oldest)
		}
		filename := filepath.Join(s.directory, key)
		if err := os.WriteFile(filename, data, 0600); err != nil {
			return nil, err
		}
		entry = &historyContent{SessionPath: path, FilePath: filename, MimeType: mime, Size: int64(len(data))}
		s.entries[id] = entry
		s.bytes += entry.Size
	}
	s.touch(entry)
	head, tail, lines := "", "", 0
	if text {
		head = historyUTF8Preview(data, 0, min(len(data), 24*1024))
		tail = historyUTF8Preview(data, max(0, len(data)-8*1024), len(data))
		if len(data) > 0 {
			lines = 1 + bytes.Count(data, []byte("\n"))
		}
	}
	return map[string]any{"type": "content_ref", "contentRef": id, "previewHead": head, "previewTail": tail, "byteLength": len(data), "lineCount": lines, "mimeType": mime}, nil
}

func (s *historyContentStore) compact(path string, value any, compactText bool) (any, error) {
	switch item := value.(type) {
	case string:
		if compactText && len(item) > historyReferenceThreshold {
			return s.reference(path, "text/plain; charset=utf-8", []byte(item), true)
		}
	case []any:
		for position, part := range item {
			compacted, err := s.compact(path, part, compactText)
			if err != nil {
				return nil, err
			}
			item[position] = compacted
		}
	case map[string]any:
		if item["type"] == "image" {
			data, hasData := item["data"].(string)
			mime, hasMime := item["mimeType"].(string)
			if hasData && hasMime {
				decoded, err := base64.StdEncoding.DecodeString(data)
				if err != nil {
					return nil, err
				}
				reference, err := s.reference(path, mime, decoded, false)
				if err != nil {
					return nil, err
				}
				item["data"] = reference
			}
		}
		for key, part := range item {
			compacted, err := s.compact(path, part, compactText)
			if err != nil {
				return nil, err
			}
			item[key] = compacted
		}
	}
	return value, nil
}

type historyJoinPart struct {
	ContentRef string `json:"contentRef,omitempty"`
	Text       string `json:"text,omitempty"`
}

type historyJoin struct {
	Parts []historyJoinPart `json:"parts"`
}

type historyContentPart struct {
	entry *historyContent
	text  string
	size  int64
}

func (s *historyContentStore) parts(path string, input []historyJoinPart) ([]historyContentPart, int64, error) {
	parts := make([]historyContentPart, 0, len(input))
	var total int64
	for _, source := range input {
		part := historyContentPart{text: source.Text, size: int64(len(source.Text))}
		if source.ContentRef != "" {
			entry := s.entries[source.ContentRef]
			if entry == nil {
				return nil, 0, &indexError{"Content reference is missing or expired", "content_ref_expired", true}
			}
			if entry.SessionPath != path {
				return nil, 0, &indexError{"Content reference does not belong to this Session", "content_ref_session_mismatch", false}
			}
			s.touch(entry)
			part.entry, part.size = entry, entry.Size
		}
		total += part.size
		parts = append(parts, part)
	}
	if total > historyMaxContentBytes {
		return nil, 0, &indexError{"Joined content exceeds the content reference limit", "content_too_large", false}
	}
	return parts, total, nil
}

func readHistoryParts(parts []historyContentPart, offset, length int64) ([]byte, error) {
	result := make([]byte, 0, length)
	for _, part := range parts {
		if offset >= part.size {
			offset -= part.size
			continue
		}
		count := min(length-int64(len(result)), part.size-offset)
		if count == 0 {
			break
		}
		if part.entry != nil {
			file, err := os.Open(part.entry.FilePath)
			if err != nil {
				return nil, err
			}
			buffer := make([]byte, count)
			_, readErr := file.ReadAt(buffer, offset)
			closeErr := file.Close()
			if readErr != nil {
				return nil, readErr
			}
			if closeErr != nil {
				return nil, closeErr
			}
			result = append(result, buffer...)
		} else {
			result = append(result, part.text[offset:offset+count]...)
		}
		offset = 0
	}
	return result, nil
}

func (s *historyContentStore) read(input request) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expire()
	parts, total, err := s.parts(input.Path, []historyJoinPart{{ContentRef: input.ContentRef}})
	if err != nil {
		return nil, err
	}
	if input.Command == "history_image" {
		if len(parts) != 1 || parts[0].entry == nil || !strings.HasPrefix(parts[0].entry.MimeType, "image/") {
			return nil, &indexError{"Content reference is not an image", "image_content_not_image", false}
		}
		if total > 8*1024*1024 {
			return nil, &indexError{"Image content exceeds the 8 MiB display limit", "image_content_too_large", false}
		}
		data, err := readHistoryParts(parts, 0, total)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"contentRef": input.ContentRef, "mimeType": parts[0].entry.MimeType, "byteLength": total, "data": base64.StdEncoding.EncodeToString(data)})
	}
	if input.Offset < 0 || input.Offset > total || input.Limit < 1 {
		return nil, &indexError{"Content offset exceeds the referenced value", "content_offset_invalid", false}
	}
	next := min(total, input.Offset+input.Limit)
	data, err := readHistoryParts(parts, input.Offset, next-input.Offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return json.Marshal(map[string]any{"contentRef": input.ContentRef, "offset": input.Offset, "nextOffset": next, "byteLength": total, "data": base64.StdEncoding.EncodeToString(data), "encoding": "base64", "done": next == total})
}
