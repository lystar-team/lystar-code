package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"sync"

	"github.com/tidwall/gjson"
)

const historyWindowBytes int64 = 64 * 1024
const historyCacheBytes int64 = 64 * 1024 * 1024

var historyScanReaders = sync.Pool{New: func() any { return bufio.NewReaderSize(nil, 256*1024) }}

// The index contains locations and relationships, never message bodies.
type historyEntry struct {
	ID, ParentID, Type, Role, CustomType, Timestamp string
	Offset, Length                                  int64
	Step                                            *historyStep
}

type historyCachedItem struct {
	item  historyItem
	bytes int64
}
type historyFile struct {
	Version                                             fileVersion
	Complete                                            int64
	SessionID, LeafID, Generation, PrefixHash, TailHash string
	HeaderLength                                        int64
	Entries                                             map[string][]*historyEntry
	Bytes                                               int64
	ScannedFrom, HeaderLineBytes, LeafOffset            int64
	Compacted                                           map[int64]historyCachedItem
	PageBytes                                           int64
	StepStates                                          map[int64]*historyStep
	StepBytes                                           int64
	Branches                                            []*historyBranch
}

type historyCacheEntry struct {
	file  *historyFile
	bytes int64
	used  uint64
}

type historyEngine struct {
	mu      sync.Mutex
	files   map[string]historyCacheEntry
	bytes   int64
	clock   uint64
	content historyContentStore
}

func (h *historyEngine) take(path string) *historyFile {
	h.mu.Lock()
	defer h.mu.Unlock()
	cached, ok := h.files[path]
	if !ok {
		return nil
	}
	delete(h.files, path)
	h.bytes -= cached.bytes
	return cached.file
}

func (h *historyEngine) remember(path string, file *historyFile) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if previous, ok := h.files[path]; ok {
		h.bytes -= previous.bytes
		delete(h.files, path)
	}
	if file.Bytes > historyCacheBytes {
		return
	}
	if h.files == nil {
		h.files = make(map[string]historyCacheEntry)
	}
	for len(h.files) >= 32 || h.bytes+file.Bytes > historyCacheBytes {
		var oldest string
		var used uint64 = ^uint64(0)
		for key, entry := range h.files {
			if entry.used < used {
				oldest, used = key, entry.used
			}
		}
		h.bytes -= h.files[oldest].bytes
		delete(h.files, oldest)
	}
	h.clock++
	h.files[path] = historyCacheEntry{file, file.Bytes, h.clock}
	h.bytes += file.Bytes
}

func historyLineError(limit int64) error {
	return &indexError{fmt.Sprintf("Transcript JSONL line exceeds the %d byte limit", limit), "transcript_line_too_large", false}
}

func completeHistorySize(file *historyReader, size int64) (int64, error) {
	buffer := make([]byte, historyWindowBytes)
	for end := size; end > 0; {
		start := max(int64(0), end-historyWindowBytes)
		n, err := file.ReadAt(buffer[:end-start], start)
		if err != nil && !errors.Is(err, io.EOF) {
			return 0, err
		}
		if offset := bytes.LastIndexByte(buffer[:n], '\n'); offset >= 0 {
			return start + int64(offset) + 1, nil
		}
		end = start
	}
	return 0, nil
}

type historyFields struct {
	Type       string          `json:"type"`
	ID         string          `json:"id"`
	ParentID   string          `json:"parentId"`
	CustomType string          `json:"customType"`
	Timestamp  string          `json:"timestamp"`
	Data       historyJSONView `json:"data"`
	Message    struct {
		Role string `json:"role"`
	} `json:"message"`
}

var historyMessageKey = regexp.MustCompile(`"message"\s*:`)

// Large canonical message rows expose their routing fields before the body.
// Unusual property order is decoded from disk rather than guessed from a prefix.
func historyRowFields(file *historyReader, prefix []byte, offset, length, maxLine int64) (historyFields, bool, error) {
	var fields historyFields
	if key := historyMessageKey.FindIndex(prefix); key != nil {
		header := bytes.TrimRight(bytes.TrimSpace(prefix[:key[0]]), ",")
		partial := append(append([]byte(nil), header...), '}')
		if json.Unmarshal(partial, &fields) == nil && fields.Type == "message" && fields.ID != "" {
			fields.Message.Role = gjson.GetBytes(prefix[key[1]:], "role").Str
			if fields.Message.Role != "" {
				if int64(len(prefix)) == length && !gjson.ValidBytes(prefix) {
					return fields, false, nil
				}
				return fields, true, nil
			}
		}
	}
	if int64(len(prefix)) == length {
		fields, valid := historyParseFields(prefix)
		return fields, valid, nil
	}
	if length-1 > maxLine {
		return fields, false, historyLineError(maxLine)
	}
	raw := make([]byte, length)
	if _, err := file.ReadAt(raw, offset); err != nil {
		return fields, false, err
	}
	fields, valid := historyParseFields(raw)
	return fields, valid, nil
}

func indexHistoryRows(file *historyReader, index *historyFile, start, end, maxLine int64) error {
	if err := file.ctx.Err(); err != nil {
		return err
	}
	reader := historyScanReaders.Get().(*bufio.Reader)
	reader.Reset(io.NewSectionReader(file, start, end-start))
	defer func() { reader.Reset(nil); historyScanReaders.Put(reader) }()
	for offset := start; offset < end; {
		if err := file.ctx.Err(); err != nil {
			return err
		}
		var prefix []byte
		var length int64
		for {
			part, err := reader.ReadSlice('\n')
			length += int64(len(part))
			if prefix == nil {
				prefix = part[:min(len(part), int(historyWindowBytes))]
				if errors.Is(err, bufio.ErrBufferFull) {
					prefix = append([]byte(nil), prefix...)
				}
			}
			if errors.Is(err, bufio.ErrBufferFull) {
				continue
			}
			if err != nil {
				return err
			}
			break
		}
		if index.SessionID == "" {
			index.HeaderLineBytes = max(index.HeaderLineBytes, length-1)
			if length-1 > maxLine {
				return historyLineError(maxLine)
			}
		}
		fields, valid, err := historyRowFields(file, prefix, offset, length, maxLine)
		if err != nil {
			return err
		}
		if valid && index.SessionID == "" {
			if fields.Type != "session" || fields.ID == "" {
				return errors.New("Session file has no valid header")
			}
			index.SessionID = fields.ID
			index.HeaderLength = offset + length
		} else if valid && fields.Type != "session" && fields.ID != "" {
			item := &historyEntry{ID: fields.ID, ParentID: fields.ParentID, Type: fields.Type, Role: fields.Message.Role, CustomType: fields.CustomType, Timestamp: fields.Timestamp, Offset: offset, Length: length}
			if item.Type == "custom" && item.CustomType == "lystar.web.agent-step" {
				if id, valid := historyStepID(fields.Data); valid {
					item.Step = &historyStep{ID: id}
				}
			}
			entries := index.Entries[item.ID]
			position := sort.Search(len(entries), func(n int) bool { return entries[n].Offset >= item.Offset })
			if position < len(entries) && entries[position].Offset == item.Offset {
				offset += length
				continue
			}
			entries = append(entries, nil)
			copy(entries[position+1:], entries[position:])
			entries[position] = item
			index.Entries[item.ID] = entries
			if item.Step != nil {
				index.Bytes += 72 + int64(len(item.Step.ID))
			}
			if item.Offset >= index.LeafOffset {
				index.LeafID, index.LeafOffset = item.ID, item.Offset
			}
			index.Bytes += 192 + int64(len(item.ID)+len(item.ParentID)+len(item.Type)+len(item.Role)+len(item.CustomType)+len(item.Timestamp))
		}
		offset += length
	}
	return nil
}

func (f *historyFile) before(id string, boundary int64) *historyEntry {
	entries := f.Entries[id]
	position := sort.Search(len(entries), func(n int) bool { return entries[n].Offset >= boundary }) - 1
	if position < 0 {
		return nil
	}
	return entries[position]
}

func (f *historyFile) lookup(handle *historyReader, id string, boundary, maxLine int64) (*historyEntry, error) {
	for {
		if err := handle.ctx.Err(); err != nil {
			return nil, err
		}
		if item := f.before(id, boundary); item != nil {
			return item, nil
		}
		if f.ScannedFrom <= f.HeaderLength {
			return nil, changed()
		}
		if err := f.expand(handle, maxLine); err != nil {
			return nil, err
		}
	}
}

func (h *historyEngine) load(path string, handle *historyReader, maxLine int64) (*historyFile, error) {
	version, err := statVersion(path)
	if err != nil {
		return nil, err
	}
	cached := h.take(path)
	if cached != nil && cached.Version == version {
		if cached.HeaderLineBytes > maxLine {
			return nil, historyLineError(maxLine)
		}
		return cached, nil
	}
	complete, err := completeHistorySize(handle, version.Size)
	if err != nil {
		return nil, err
	}
	appendOnly := false
	if cached != nil && cached.Version.Dev == version.Dev && cached.Version.Ino == version.Ino && complete >= cached.Complete && version.Size >= cached.Version.Size {
		matches, err := historyAnchors(path, cached.Complete, cached.PrefixHash, cached.TailHash)
		if err != nil {
			return nil, err
		}
		appendOnly = matches && (complete > cached.Complete || version.Size > complete)
	}
	file := cached
	if appendOnly {
		if err := indexHistoryRows(handle, file, cached.Complete, complete, maxLine); err != nil {
			return nil, err
		}
	} else {
		file = &historyFile{Entries: make(map[string][]*historyEntry), Compacted: make(map[int64]historyCachedItem), Complete: complete, ScannedFrom: complete}
		if err := file.readHeader(handle, maxLine); err != nil {
			return nil, err
		}
		for file.LeafID == "" && file.ScannedFrom > file.HeaderLength {
			if err := file.expand(handle, maxLine); err != nil {
				return nil, err
			}
		}
	}
	if file.HeaderLineBytes > maxLine {
		return nil, historyLineError(maxLine)
	}
	file.Version, file.Complete = version, complete
	if !appendOnly {
		file.Generation = fmt.Sprintf("%s:%d:%d:%s", file.SessionID, version.Dev, version.Ino, strconv.FormatFloat(version.Birth, 'f', -1, 64))
		if cached != nil {
			file.Generation += ":" + rand.Text()
		}
	}
	length := min(complete, historyWindowBytes)
	file.PrefixHash, err = hashWindow(path, 0, length)
	if err != nil {
		return nil, err
	}
	file.TailHash, err = hashWindow(path, complete-length, length)
	return file, err
}

func historyAnchors(path string, size int64, prefix, tail string) (bool, error) {
	length := min(size, historyWindowBytes)
	actualPrefix, err := hashWindow(path, 0, length)
	if err != nil {
		return false, err
	}
	actualTail, err := hashWindow(path, size-length, length)
	return actualPrefix == prefix && actualTail == tail, err
}

func (f *historyFile) validate(path string) error {
	after, err := statVersion(path)
	if err != nil {
		return err
	}
	if after == f.Version {
		return nil
	}
	if after.Dev != f.Version.Dev || after.Ino != f.Version.Ino || after.Size < f.Version.Size {
		return changed()
	}
	matches, err := historyAnchors(path, f.Complete, f.PrefixHash, f.TailHash)
	if err != nil {
		return err
	}
	if !matches || after.Size <= f.Complete {
		return changed()
	}
	return nil
}
