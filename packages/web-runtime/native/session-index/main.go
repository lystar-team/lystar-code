package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type request struct {
	ID           int64           `json:"id"`
	Command      string          `json:"command"`
	Path         string          `json:"path"`
	WriterLocked bool            `json:"writerLocked"`
	Transcript   *historyOptions `json:"transcript,omitempty"`
	ContentRef   string          `json:"contentRef,omitempty"`
	Offset       int64           `json:"offset,omitempty"`
	Limit        int64           `json:"limit,omitempty"`
	Joins        []string        `json:"joins,omitempty"`
}

type indexError struct {
	Message   string `json:"message"`
	Code      string `json:"code,omitempty"`
	Retryable bool   `json:"retryable,omitempty"`
}

func (e *indexError) Error() string { return e.Message }
func changed() error {
	return &indexError{"会话文件已重写，请重新读取", "cursor_stale", true}
}

type response struct {
	ID         int64           `json:"id"`
	Result     json.RawMessage `json:"result,omitempty"`
	Error      *indexError     `json:"error,omitempty"`
	Transcript *historyPage    `json:"-"`
}

type fileVersion struct {
	Dev   int64
	Ino   int64
	Birth float64
	Size  int64
	Mtime float64
	Ctime float64
}

func (v fileVersion) sameIdentity(other fileVersion) bool {
	return v.Dev == other.Dev && v.Ino == other.Ino && v.Birth == other.Birth
}

type fileRow struct {
	Path string
	fileVersion
	ReadOffset     int64
	PrefixHash     string
	TailHash       string
	Epoch          string
	Metadata       json.RawMessage
	SubagentOffset int64
}

type metadata struct {
	Header              json.RawMessage `json:"header"`
	LeafID              *string         `json:"leafId"`
	Name                *string         `json:"name,omitempty"`
	NameResolved        bool            `json:"nameResolved,omitempty"`
	Model               *model          `json:"model,omitempty"`
	ThinkingLevel       *string         `json:"thinkingLevel,omitempty"`
	MessageCount        int64           `json:"messageCount"`
	FirstMessage        string          `json:"firstMessage"`
	LastOutcome         string          `json:"lastOutcome,omitempty"`
	ModifiedMs          float64         `json:"modifiedMs"`
	CollaborationResult json.RawMessage `json:"collaborationResult,omitempty"`
	Snapshot            *snapshot       `json:"snapshot,omitempty"`
}

type model struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
}

type snapshot struct {
	Generation string  `json:"generation"`
	Revision   int64   `json:"revision"`
	UpdatedAt  float64 `json:"updatedAt"`
}

type entry struct {
	Type          string          `json:"type"`
	ID            string          `json:"id"`
	Timestamp     string          `json:"timestamp"`
	Name          *string         `json:"name"`
	Provider      string          `json:"provider"`
	ModelID       string          `json:"modelId"`
	ThinkingLevel *string         `json:"thinkingLevel"`
	CustomType    string          `json:"customType"`
	Data          json.RawMessage `json:"data"`
	Message       struct {
		Role       string          `json:"role"`
		StopReason string          `json:"stopReason"`
		Cancelled  bool            `json:"cancelled"`
		ExitCode   *int            `json:"exitCode"`
		Timestamp  *float64        `json:"timestamp"`
		Content    json.RawMessage `json:"content"`
		ToolName   string          `json:"toolName"`
		Details    json.RawMessage `json:"details"`
	} `json:"message"`
}

type subagent struct {
	RunID         string          `json:"runId"`
	AgentID       string          `json:"agentId"`
	Agent         string          `json:"agent"`
	AgentSource   string          `json:"agentSource"`
	Task          *string         `json:"task,omitempty"`
	State         string          `json:"state"`
	CurrentAction string          `json:"currentAction,omitempty"`
	StartedAt     *float64        `json:"startedAt"`
	UpdatedAt     *float64        `json:"updatedAt"`
	ElapsedMs     float64         `json:"elapsedMs"`
	Controllable  bool            `json:"controllable"`
	Session       json.RawMessage `json:"session,omitempty"`
}

type pathLock struct {
	token chan struct{}
	users int
}
type index struct {
	db      *sql.DB
	mu      sync.Mutex
	locks   map[string]*pathLock
	history historyEngine
}

func openIndex(path string) (*index, error) {
	dsn := ":memory:?_txlock=immediate"
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return nil, err
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		uriPath := filepath.ToSlash(absolute)
		if !strings.HasPrefix(uriPath, "/") {
			uriPath = "/" + uriPath
		}
		dsn = (&url.URL{Scheme: "file", Path: uriPath, RawQuery: "_txlock=immediate"}).String()
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
		CREATE TABLE IF NOT EXISTS session_files (
			path TEXT PRIMARY KEY, dev INTEGER NOT NULL, ino INTEGER NOT NULL, birth REAL NOT NULL,
			size INTEGER NOT NULL, mtime REAL NOT NULL, ctime REAL NOT NULL, read_offset INTEGER NOT NULL,
			prefix_hash TEXT NOT NULL, tail_hash TEXT NOT NULL, epoch TEXT NOT NULL,
			metadata_json TEXT NOT NULL, subagent_offset INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS subagents (
			path TEXT NOT NULL, entry_offset INTEGER NOT NULL, entry_length INTEGER NOT NULL,
			result_index INTEGER NOT NULL, run_id TEXT NOT NULL, agent_id TEXT NOT NULL,
			updated_at REAL NOT NULL, snapshot_json TEXT NOT NULL,
			PRIMARY KEY(path, entry_offset, result_index));
		CREATE INDEX IF NOT EXISTS subagents_order ON subagents(path, updated_at DESC, run_id, agent_id);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return &index{db: db, locks: make(map[string]*pathLock)}, nil
}

func (i *index) find(path string) (*fileRow, error) {
	row := &fileRow{Path: path}
	var metadata string
	err := i.db.QueryRow("SELECT dev,ino,birth,size,mtime,ctime,read_offset,prefix_hash,tail_hash,epoch,metadata_json,subagent_offset FROM session_files WHERE path=?", path).Scan(
		&row.Dev, &row.Ino, &row.Birth, &row.Size, &row.Mtime, &row.Ctime, &row.ReadOffset,
		&row.PrefixHash, &row.TailHash, &row.Epoch, &metadata, &row.SubagentOffset)
	row.Metadata = json.RawMessage(metadata)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

func hashWindow(path string, offset, length int64) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	bytes := make([]byte, length)
	count, err := file.ReadAt(bytes, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	hash := sha256.Sum256(bytes[:count])
	return hex.EncodeToString(hash[:]), nil
}
func (row *fileRow) checkpointMatches() (bool, error) {
	length := min(row.ReadOffset, 64*1024)
	prefix, err := hashWindow(row.Path, 0, length)
	if err != nil {
		return false, err
	}
	tail, err := hashWindow(row.Path, row.ReadOffset-length, length)
	return prefix == row.PrefixHash && tail == row.TailHash, err
}

var typePattern = regexp.MustCompile(`^\{"type":"([A-Za-z_]+)"`)
var idPattern = regexp.MustCompile(`^\{"type":"[A-Za-z_]+","id":"([A-Za-z0-9._-]+)"`)
var rolePattern = regexp.MustCompile(`"message":\{"role":"([^"]+)"`)
var customPattern = regexp.MustCompile(`"customType":"([^"]+)"`)
var toolPattern = regexp.MustCompile(`"toolName":"([^"]+)"`)

func fieldMatch(pattern *regexp.Regexp, prefix []byte) string {
	match := pattern.FindSubmatch(prefix)
	if len(match) == 0 {
		return ""
	}
	return string(match[1])
}

// 只保留当前查询需要的行；大工具输出不进入 JSON 解码，也不累计到内存。
func scan(path string, start, end int64, subagents bool, visit func(*entry, []byte, []byte, int64, int64) error) (int64, error) {
	if start >= end {
		return start, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return start, err
	}
	defer file.Close()
	input := bufio.NewReaderSize(io.NewSectionReader(file, start, end-start), 1024*1024)
	offset := start
	for offset < end {
		var content, prefix []byte
		var length int64
		retain := true
		for {
			part, readErr := input.ReadSlice('\n')
			length += int64(len(part))
			if len(prefix) < 1024 {
				prefix = append(prefix, part[:min(len(part), 1024-len(prefix))]...)
			}
			typ, role := fieldMatch(typePattern, prefix), fieldMatch(rolePattern, prefix)
			if subagents {
				if typ != "" && typ != "message" || role != "" && role != "toolResult" {
					retain = false
				}
				if tool := fieldMatch(toolPattern, prefix); role == "toolResult" && tool != "" && tool != "subagent" {
					retain = false
				}
			} else if fieldMatch(idPattern, prefix) != "" {
				if typ == "message" && role == "toolResult" || typ == "compaction" || typ == "branch_summary" {
					retain = false
				}
				if custom := fieldMatch(customPattern, prefix); typ == "custom" && custom != "" && custom != "lystar.collaboration.result" {
					retain = false
				}
			}
			if retain {
				content = append(content, part...)
			} else {
				content = nil
			}
			if errors.Is(readErr, bufio.ErrBufferFull) {
				continue
			}
			if errors.Is(readErr, io.EOF) {
				return offset, nil
			}
			if readErr != nil {
				return offset, readErr
			}
			var item *entry
			if retain {
				item = parseIndexEntry(content)
			}
			if !retain || item != nil {
				if err := visit(item, content, prefix, offset, length); err != nil {
					return offset, err
				}
			}
			offset += length
			break
		}
	}
	return offset, nil
}

func timestamp(value string) float64 {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return 0
	}
	return float64(parsed.UnixMilli())
}

func (i *index) metadata(path string, writerLocked bool) (*fileRow, error) {
	stat, err := statVersion(path)
	if err != nil {
		return nil, err
	}
	cached, err := i.find(path)
	if err != nil {
		return nil, err
	}
	if cached != nil && cached.fileVersion == stat {
		return cached, nil
	}
	appendOnly := false
	if cached != nil && writerLocked && cached.sameIdentity(stat) && stat.Size > cached.Size {
		appendOnly, err = cached.checkpointMatches()
		if err != nil {
			return nil, err
		}
	}
	info := metadata{}
	var start int64
	if appendOnly {
		if err := json.Unmarshal(cached.Metadata, &info); err != nil {
			return nil, err
		}
		start = cached.ReadOffset
	}
	readOffset, err := scan(path, start, stat.Size, false, func(item *entry, raw, prefix []byte, _, _ int64) error {
		if item == nil {
			if id := fieldMatch(idPattern, prefix); id != "" {
				info.LeafID = &id
			}
			if bytes.HasPrefix(prefix, []byte(`{"type":"message",`)) {
				info.MessageCount++
				info.LastOutcome = "interrupted"
			}
			return nil
		}
		if item.Type == "session" {
			info.Header = bytes.TrimSpace(raw)
			return nil
		}
		if item.ID != "" {
			info.LeafID = &item.ID
		}
		switch item.Type {
		case "session_info":
			info.Name = item.Name
			info.NameResolved = true
		case "model_change":
			info.Model = &model{item.Provider, item.ModelID}
		case "thinking_level_change":
			info.ThinkingLevel = item.ThinkingLevel
		case "custom":
			if item.CustomType != "lystar.collaboration.result" {
				break
			}
			var result struct {
				TaskID      *string `json:"taskId"`
				CompletedAt *string `json:"completedAt"`
				Outcome     string  `json:"outcome"`
			}
			if json.Unmarshal(item.Data, &result) == nil && result.TaskID != nil && result.CompletedAt != nil {
				switch result.Outcome {
				case "completed", "failed", "aborted", "interrupted":
					info.CollaborationResult = item.Data
				}
			}
			info.ModifiedMs = max(info.ModifiedMs, timestamp(item.Timestamp))
		case "message":
			info.MessageCount++
			message := item.Message
			switch message.Role {
			case "assistant":
				switch message.StopReason {
				case "stop":
					info.LastOutcome = "completed"
				case "error":
					info.LastOutcome = "failed"
				case "aborted":
					info.LastOutcome = "aborted"
				default:
					info.LastOutcome = "interrupted"
				}
			case "user", "toolResult":
				info.LastOutcome = "interrupted"
			case "bashExecution":
				switch {
				case message.Cancelled:
					info.LastOutcome = "aborted"
				case message.ExitCode == nil:
					info.LastOutcome = "interrupted"
				case *message.ExitCode == 0:
					info.LastOutcome = "completed"
				default:
					info.LastOutcome = "failed"
				}
			}
			time := timestamp(item.Timestamp)
			if message.Timestamp != nil {
				time = *message.Timestamp
			}
			info.ModifiedMs = max(info.ModifiedMs, time)
			if info.FirstMessage == "" && message.Role == "user" {
				if json.Unmarshal(message.Content, &info.FirstMessage) != nil {
					var parts []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					}
					if json.Unmarshal(message.Content, &parts) == nil {
						var texts []string
						for _, part := range parts {
							if part.Type == "text" {
								texts = append(texts, part.Text)
							}
						}
						info.FirstMessage = strings.Join(texts, "\n")
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	var header struct {
		ID        string `json:"id"`
		Timestamp string `json:"timestamp"`
	}
	if len(info.Header) == 0 || json.Unmarshal(info.Header, &header) != nil {
		return nil, &indexError{"Session file is not a valid pi session: " + path, "session_invalid", false}
	}
	if info.ModifiedMs <= 0 {
		info.ModifiedMs = timestamp(header.Timestamp)
		if info.ModifiedMs == 0 {
			info.ModifiedMs = stat.Mtime
		}
	}
	current, err := statVersion(path)
	if err != nil {
		return nil, err
	}
	if !stat.sameIdentity(current) || current != stat && !(writerLocked && current.Size > stat.Size) {
		return nil, changed()
	}
	info.Snapshot = &snapshot{fmt.Sprintf("%s:%d:%d:%s", header.ID, stat.Dev, stat.Ino, strconv.FormatFloat(stat.Birth, 'f', -1, 64)), readOffset, stat.Mtime}
	encoded, err := json.Marshal(info)
	if err != nil {
		return nil, err
	}
	row := &fileRow{Path: path, fileVersion: stat, ReadOffset: readOffset, Epoch: rand.Text(), Metadata: encoded}
	if appendOnly {
		row.Epoch = cached.Epoch
		row.SubagentOffset = cached.SubagentOffset
	}
	length := min(readOffset, 64*1024)
	row.PrefixHash, err = hashWindow(path, 0, length)
	if err != nil {
		return nil, err
	}
	row.TailHash, err = hashWindow(path, readOffset-length, length)
	if err != nil {
		return nil, err
	}
	tx, err := i.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// 其他 Runtime 可能同时重建缓存，只能复用同一轮索引的子任务偏移。
	var previousEpoch string
	var previousOffset int64
	err = tx.QueryRow("SELECT epoch,subagent_offset FROM session_files WHERE path=?", path).Scan(&previousEpoch, &previousOffset)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if appendOnly && previousEpoch == row.Epoch {
		row.SubagentOffset = previousOffset
	} else {
		row.SubagentOffset = 0
		if _, err = tx.Exec("DELETE FROM subagents WHERE path=?", path); err != nil {
			return nil, err
		}
	}
	_, err = tx.Exec(`INSERT INTO session_files VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
		dev=excluded.dev,ino=excluded.ino,birth=excluded.birth,size=excluded.size,mtime=excluded.mtime,ctime=excluded.ctime,
		read_offset=excluded.read_offset,prefix_hash=excluded.prefix_hash,tail_hash=excluded.tail_hash,epoch=excluded.epoch,
		metadata_json=excluded.metadata_json,subagent_offset=excluded.subagent_offset`,
		path, row.Dev, row.Ino, row.Birth, row.Size, row.Mtime, row.Ctime, row.ReadOffset, row.PrefixHash, row.TailHash, row.Epoch, string(row.Metadata), row.SubagentOffset)
	if err != nil {
		return nil, err
	}
	return row, tx.Commit()
}

func (i *index) subagents(row *fileRow) (json.RawMessage, error) {
	if row.SubagentOffset < row.ReadOffset {
		type stored struct {
			offset, length int64
			position       int
			value          subagent
			encoded        []byte
		}
		var snapshots []stored
		_, err := scan(row.Path, row.SubagentOffset, row.ReadOffset, true, func(item *entry, _, _ []byte, offset, length int64) error {
			if item == nil || item.Type != "message" || item.Message.Role != "toolResult" || item.Message.ToolName != "subagent" {
				return nil
			}
			var details struct {
				Results []subagent `json:"results"`
			}
			if json.Unmarshal(item.Message.Details, &details) != nil {
				return nil
			}
			for position, value := range details.Results {
				if value.RunID == "" || value.AgentID == "" || value.Agent == "" {
					continue
				}
				if value.AgentSource == "" {
					value.AgentSource = "unknown"
				}
				if value.State == "" {
					value.State = "succeeded"
				}
				if value.StartedAt == nil {
					t := timestamp(item.Timestamp)
					value.StartedAt = &t
				}
				if value.UpdatedAt == nil {
					t := timestamp(item.Timestamp)
					value.UpdatedAt = &t
				}
				value.Controllable = false
				encoded, err := json.Marshal(value)
				if err != nil {
					return err
				}
				snapshots = append(snapshots, stored{offset, length, position, value, encoded})
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		stat, err := statVersion(row.Path)
		if err != nil {
			return nil, err
		}
		matches, err := row.checkpointMatches()
		if err != nil {
			return nil, err
		}
		if !row.sameIdentity(stat) || stat.Size < row.Size || !matches {
			return nil, changed()
		}
		tx, err := i.db.Begin()
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		var epoch string
		if err = tx.QueryRow("SELECT epoch FROM session_files WHERE path=?", row.Path).Scan(&epoch); err != nil {
			return nil, err
		}
		if epoch != row.Epoch {
			return nil, changed()
		}
		for _, value := range snapshots {
			if _, err = tx.Exec("INSERT OR REPLACE INTO subagents VALUES(?,?,?,?,?,?,?,?)", row.Path, value.offset, value.length, value.position, value.value.RunID, value.value.AgentID, *value.value.UpdatedAt, string(value.encoded)); err != nil {
				return nil, err
			}
		}
		if _, err = tx.Exec("UPDATE session_files SET subagent_offset=MAX(subagent_offset,?) WHERE path=?", row.ReadOffset, row.Path); err != nil {
			return nil, err
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
	}
	rows, err := i.db.Query("SELECT snapshot_json FROM subagents WHERE path=? ORDER BY entry_offset,result_index", row.Path)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]json.RawMessage, 0)
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		result = append(result, json.RawMessage(raw))
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// localeCompare 的排序仍由 TS 边界完成，避免改变已有界面的排列顺序。
	return json.Marshal(result)
}

type commandResult struct {
	data       json.RawMessage
	transcript *historyPage
}

func commandJSON(data json.RawMessage, err error) (*commandResult, error) {
	return &commandResult{data: data}, err
}

func (i *index) handle(ctx context.Context, input request) (*commandResult, error) {
	i.mu.Lock()
	lock := i.locks[input.Path]
	if lock == nil {
		lock = &pathLock{token: make(chan struct{}, 1)}
		i.locks[input.Path] = lock
	}
	lock.users++
	i.mu.Unlock()
	defer func() {
		i.mu.Lock()
		lock.users--
		if lock.users == 0 {
			delete(i.locks, input.Path)
		}
		i.mu.Unlock()
	}()
	select {
	case lock.token <- struct{}{}:
		defer func() { <-lock.token }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if input.Command == "history" {
		if input.Transcript == nil {
			return nil, errors.New("Transcript options are required")
		}
		page, err := i.history.read(ctx, input.Path, *input.Transcript)
		return &commandResult{transcript: page}, err
	}
	if input.Command == "history_content" || input.Command == "history_image" {
		return commandJSON(i.history.content.read(input))
	}
	if input.Command == "history_join" {
		return commandJSON(i.history.content.register(input))
	}
	if input.Command == "remove" {
		i.history.take(input.Path)
		tx, err := i.db.Begin()
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		if _, err = tx.Exec("DELETE FROM subagents WHERE path=?", input.Path); err != nil {
			return nil, err
		}
		if _, err = tx.Exec("DELETE FROM session_files WHERE path=?", input.Path); err != nil {
			return nil, err
		}
		return commandJSON(json.RawMessage("null"), tx.Commit())
	}
	if input.Command != "metadata" && input.Command != "subagents" {
		return nil, fmt.Errorf("Unknown session index command: %s", input.Command)
	}
	row, err := i.metadata(input.Path, input.WriterLocked)
	if err != nil {
		return nil, err
	}
	if input.Command == "metadata" {
		return commandJSON(row.Metadata, nil)
	}
	return commandJSON(i.subagents(row))
}

func run() error {
	databasePath := flag.String("database", "", "Session index database path")
	flag.Parse()
	if *databasePath == "" {
		return errors.New("--database is required")
	}
	index, err := openIndex(*databasePath)
	if err != nil {
		return err
	}
	defer index.db.Close()
	defer index.history.content.close()
	input, output := json.NewDecoder(os.Stdin), bufio.NewWriterSize(os.Stdout, 64*1024)
	var outputMu sync.Mutex
	var jobs sync.WaitGroup
	var readsMu sync.Mutex
	reads := make(map[int64]context.CancelFunc)
	defer jobs.Wait()
	for {
		var message request
		if err := input.Decode(&message); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if message.Command == "cancel" {
			readsMu.Lock()
			if cancel := reads[message.ID]; cancel != nil {
				cancel()
			}
			readsMu.Unlock()
			continue
		}
		ctx := context.Background()
		if message.Command == "history" {
			var cancel context.CancelFunc
			ctx, cancel = context.WithCancel(ctx)
			readsMu.Lock()
			reads[message.ID] = cancel
			readsMu.Unlock()
		}
		jobs.Add(1)
		go func() {
			defer jobs.Done()
			if message.Command == "history" {
				defer func() {
					readsMu.Lock()
					reads[message.ID]()
					delete(reads, message.ID)
					readsMu.Unlock()
				}()
			}
			result, err := index.handle(ctx, message)
			reply := response{ID: message.ID}
			if result != nil {
				reply.Result, reply.Transcript = result.data, result.transcript
			}
			if err != nil {
				var reason *indexError
				if !errors.As(err, &reason) {
					reason = &indexError{Message: err.Error()}
					if errors.Is(err, context.Canceled) {
						reason = cancelledHistoryRead()
					} else if errors.Is(err, os.ErrNotExist) {
						reason.Code = "ENOENT"
					}
				}
				reply.Error = reason
			}
			outputMu.Lock()
			defer outputMu.Unlock()
			if err := writeIndexResponse(ctx, output, reply); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		}()
	}
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
