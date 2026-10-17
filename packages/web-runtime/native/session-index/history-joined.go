package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Materialize grouped text in Go so the public reference remains a short ID.
func (s *historyContentStore) join(path, descriptor string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(descriptor, "native:join:"))
	var joined historyJoin
	if err != nil || json.Unmarshal(raw, &joined) != nil || len(joined.Parts) == 0 {
		return "", &indexError{"Content reference is missing or expired", "content_ref_expired", true}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expire()
	parts, total, err := s.parts(path, joined.Parts)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte("lystar-joined-text\x00" + path + "\x00" + descriptor))
	key := hex.EncodeToString(digest[:])
	id := "native:" + key
	if existing := s.entries[id]; existing != nil {
		s.touch(existing)
		return id, nil
	}
	file, err := os.CreateTemp(s.directory, "joined-")
	if err != nil {
		return "", err
	}
	defer os.Remove(file.Name())
	var copyErr error
	for _, part := range parts {
		if part.entry == nil {
			_, copyErr = io.WriteString(file, part.text)
		} else {
			source, err := os.Open(part.entry.FilePath)
			if err != nil {
				copyErr = err
				break
			}
			_, copyErr = io.Copy(file, source)
			closeErr := source.Close()
			if copyErr == nil {
				copyErr = closeErr
			}
		}
		if copyErr != nil {
			break
		}
	}
	closeErr := file.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	for s.bytes+total > historyMaxStoredBytes {
		var oldest string
		var used uint64 = ^uint64(0)
		for candidate, entry := range s.entries {
			if entry.Used < used {
				oldest, used = candidate, entry.Used
			}
		}
		s.delete(oldest)
	}
	filename := filepath.Join(s.directory, key)
	if err := os.Rename(file.Name(), filename); err != nil {
		return "", err
	}
	entry := &historyContent{SessionPath: path, FilePath: filename, MimeType: "text/plain; charset=utf-8", Size: total}
	s.touch(entry)
	s.entries[id] = entry
	s.bytes += total
	return id, nil
}

func (s *historyContentStore) register(input request) (json.RawMessage, error) {
	result := make(map[string]string, len(input.Joins))
	for _, descriptor := range input.Joins {
		id, err := s.join(input.Path, descriptor)
		if err != nil {
			return nil, err
		}
		result[descriptor] = id
	}
	return json.Marshal(result)
}
