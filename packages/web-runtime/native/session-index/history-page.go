package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
)

type historyOptions struct {
	Cursor          string          `json:"cursor"`
	Limit           int             `json:"limit"`
	EmptyGeneration string          `json:"emptyGeneration"`
	ByteBudget      *int64          `json:"byteBudget"`
	LeafID          json.RawMessage `json:"leafId"`
	Compact         bool            `json:"compact"`
	MaxLineBytes    int64           `json:"maxJsonlLineBytes"`
}

type historyCursor struct {
	Version    int         `json:"version"`
	SessionID  string      `json:"sessionId"`
	LeafID     string      `json:"leafId"`
	WantedID   string      `json:"wantedId"`
	Offset     int64       `json:"offset"`
	Complete   int64       `json:"complete"`
	File       fileVersion `json:"file"`
	PrefixHash string      `json:"prefixHash"`
	TailHash   string      `json:"tailHash"`
	Generation string      `json:"generation"`
}

type historyItem struct {
	EntryID   string          `json:"entryId"`
	ParentID  *string         `json:"parentId"`
	Timestamp string          `json:"timestamp"`
	Kind      string          `json:"kind"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Value     map[string]any  `json:"-"`
	Encoded   json.RawMessage `json:"-"`
}

type historyPage struct {
	Items           []historyItem `json:"items,omitempty"`
	ContextCalls    []historyItem `json:"contextCalls,omitempty"`
	StepItems       []historyItem `json:"stepItems,omitempty"`
	PreviousCursor  string        `json:"previousCursor,omitempty"`
	HasMorePrevious bool          `json:"hasMorePrevious"`
	LeafID          *string       `json:"leafId"`
	Generation      string        `json:"transcriptGeneration"`
	Revision        int64         `json:"transcriptRevision"`
	Complete        bool          `json:"complete"`
}

func historyVisible(item *historyEntry) bool {
	switch item.Type {
	case "message", "custom", "compaction", "branch_summary", "custom_message":
		return true
	}
	return false
}

func readHistoryItem(file *os.File, item *historyEntry, maxLine int64) (historyItem, error) {
	if item.Length-1 > maxLine {
		return historyItem{}, historyLineError(maxLine)
	}
	decoder := json.NewDecoder(io.NewSectionReader(file, item.Offset, item.Length))
	decoder.UseNumber()
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil {
		return historyItem{}, err
	}
	return historyItemFromPayload(item, payload), nil
}

func historyItemFromPayload(item *historyEntry, payload map[string]any) historyItem {
	var parent *string
	if value, ok := payload["parentId"].(string); ok {
		parent = &value
	}
	timestamp, _ := payload["timestamp"].(string)
	return historyItem{EntryID: item.ID, ParentID: parent, Timestamp: timestamp, Kind: item.Type, Value: payload}
}

type historyStep struct {
	ID             string
	Calls, Entries []string
	Data           json.RawMessage
}

func historyStringArray(array []*string) ([]string, bool) {
	if array == nil {
		return nil, false
	}
	result := make([]string, 0, len(array))
	for _, value := range array {
		if value == nil {
			return nil, false
		}
		result = append(result, *value)
	}
	return result, true
}

// Validate association fields without building generic maps for every update.
func historyStepData(raw json.RawMessage) *historyStep {
	var data struct {
		Version int `json:"version"`
		Step    struct {
			ID        *string         `json:"id"`
			Title     *string         `json:"title"`
			Status    string          `json:"status"`
			StartedAt *float64        `json:"startedAt"`
			Calls     []*string       `json:"toolCallIds"`
			Entries   json.RawMessage `json:"messageEntryIds"`
		} `json:"step"`
	}
	if json.Unmarshal(raw, &data) != nil || data.Version != 1 {
		return nil
	}
	step := data.Step
	if step.ID == nil || step.Title == nil || step.StartedAt == nil {
		return nil
	}
	switch step.Status {
	case "running", "completed", "failed", "interrupted":
	default:
		return nil
	}
	calls, valid := historyStringArray(step.Calls)
	if !valid {
		return nil
	}
	entries := []string{}
	if len(step.Entries) > 0 {
		var input []*string
		if json.Unmarshal(step.Entries, &input) != nil {
			return nil
		}
		entries, valid = historyStringArray(input)
		if !valid {
			return nil
		}
	}
	return &historyStep{*step.ID, calls, entries, raw}
}

func historyMessage(item historyItem) map[string]any {
	message, _ := item.Value["message"].(map[string]any)
	return message
}

func (h *historyEngine) read(path string, options historyOptions) (*historyPage, error) {
	if options.Limit < 1 || options.MaxLineBytes < 1 {
		return nil, errors.New("Invalid transcript read limits")
	}
	var cursor *historyCursor
	if options.Cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(options.Cursor)
		var decoded historyCursor
		if err != nil || json.Unmarshal(raw, &decoded) != nil || decoded.Version != 4 || decoded.SessionID == "" || decoded.LeafID == "" || decoded.WantedID == "" || decoded.Complete < 0 || decoded.Offset < 0 || decoded.Offset > decoded.Complete {
			return nil, &indexError{"Transcript cursor is malformed", "cursor_stale", true}
		}
		cursor = &decoded
	}
	before, err := statVersion(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) && options.EmptyGeneration != "" && cursor == nil {
			return &historyPage{Items: []historyItem{}, StepItems: []historyItem{}, Generation: options.EmptyGeneration, Complete: true}, nil
		}
		return nil, err
	}
	handle, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer handle.Close()
	file, err := h.load(path, handle, options.MaxLineBytes)
	if err != nil {
		return nil, err
	}
	if before != file.Version {
		return nil, changed()
	}
	defer h.remember(path, file)
	leaf := file.LeafID
	leafRequested := len(options.LeafID) > 0
	requestedLeaf := ""
	if leafRequested && !bytes.Equal(options.LeafID, []byte("null")) {
		if err := json.Unmarshal(options.LeafID, &requestedLeaf); err != nil {
			return nil, err
		}
	}
	if leafRequested {
		leaf = requestedLeaf
	}
	if cursor != nil {
		if cursor.SessionID != file.SessionID || cursor.File.Dev != file.Version.Dev || cursor.File.Ino != file.Version.Ino || file.Complete < cursor.Complete {
			return nil, changed()
		}
		matches := cursor.PrefixHash == file.PrefixHash && cursor.TailHash == file.TailHash
		if cursor.File != file.Version || cursor.Complete != file.Complete {
			matches, err = historyAnchors(path, cursor.Complete, cursor.PrefixHash, cursor.TailHash)
			if err != nil {
				return nil, err
			}
		}
		if !matches || file.Complete == cursor.Complete && file.Version != cursor.File && file.Version.Size <= file.Complete {
			return nil, changed()
		}
		if leafRequested && leaf != cursor.LeafID {
			wanted, boundary := leaf, file.Complete
			for wanted != "" && wanted != cursor.LeafID {
				item, err := file.lookup(handle, wanted, boundary, options.MaxLineBytes)
				if err != nil {
					return nil, err
				}
				wanted, boundary = item.ParentID, item.Offset
			}
			if wanted != cursor.LeafID {
				return nil, changed()
			}
		}
		leaf = cursor.LeafID
	}
	page := historyPage{Items: []historyItem{}, StepItems: []historyItem{}, Generation: file.Generation, Revision: file.Complete, Complete: true}
	if leaf == "" {
		if err := file.validate(path); err != nil {
			return nil, err
		}
		return &page, nil
	}
	page.LeafID = &leaf
	leafBoundary := file.Complete
	if cursor != nil {
		leafBoundary = cursor.Complete
	}
	leafEntry, err := file.lookup(handle, leaf, leafBoundary, options.MaxLineBytes)
	if err != nil {
		return nil, err
	}
	branch := file.branch(leaf, leafEntry.Offset)
	start, err := branch.start(handle, file, cursor, options.MaxLineBytes)
	if err != nil {
		return nil, err
	}
	if cursor != nil {
		page.Generation = cursor.Generation
	}
	position := start
	selected := make([]*historyEntry, 0, options.Limit)
	var pageBytes int64
	wanted, boundary := "", file.Complete
	for {
		item, err := branch.entry(handle, file, position, options.MaxLineBytes)
		if err != nil {
			return nil, err
		}
		if item == nil {
			break
		}
		position++
		wanted, boundary = item.ParentID, item.Offset
		if item.Length-1 > options.MaxLineBytes {
			return nil, historyLineError(options.MaxLineBytes)
		}
		if historyVisible(item) {
			if !options.Compact && options.ByteBudget != nil && item.Length-1 >= 16*1024*1024 {
				return nil, historyLineError(16 * 1024 * 1024)
			}
			selected = append(selected, item)
			pageBytes += item.Length - 1
		}
		if (len(selected) >= options.Limit || options.ByteBudget != nil && pageBytes >= *options.ByteBudget) && item.Role != "toolResult" && item.Step == nil {
			break
		}
	}
	// TS 只展示同页内每个步骤的最后一次更新，旧版本不再跨进程传输。
	seenSteps := make(map[string]bool)
	for _, item := range selected {
		if options.Compact && item.Step != nil {
			if seenSteps[item.Step.ID] {
				continue
			}
			seenSteps[item.Step.ID] = true
		}
		value, length, err := h.pageItem(handle, path, file, item, options)
		if err != nil {
			return nil, err
		}
		if options.ByteBudget != nil && length >= 16*1024*1024 {
			return nil, historyLineError(16 * 1024 * 1024)
		}
		page.Items = append(page.Items, value)
	}
	for left, right := 0, len(page.Items)-1; left < right; left, right = left+1, right-1 {
		page.Items[left], page.Items[right] = page.Items[right], page.Items[left]
	}
	if err := h.associations(handle, file, branch, position, selected, &page, options.MaxLineBytes); err != nil {
		return nil, err
	}
	if wanted != "" {
		page.HasMorePrevious = true
		encoded, err := json.Marshal(historyCursor{Version: 4, SessionID: file.SessionID, LeafID: leaf, WantedID: wanted, Offset: boundary, Complete: file.Complete, File: file.Version, PrefixHash: file.PrefixHash, TailHash: file.TailHash, Generation: page.Generation})
		if err != nil {
			return nil, err
		}
		page.PreviousCursor = base64.RawURLEncoding.EncodeToString(encoded)
	}
	if err := file.validate(path); err != nil {
		return nil, err
	}
	return &page, nil
}

func (h *historyEngine) associations(handle *os.File, file *historyFile, branch *historyBranch, end int, selected []*historyEntry, page *historyPage, maxLine int64) error {
	entries, calls, stepIDs, missing := map[string]bool{}, map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, item := range selected {
		entries[item.ID] = true
		if item.Step != nil {
			stepIDs[item.Step.ID] = true
		}
	}
	for _, item := range page.Items {
		message := historyMessage(item)
		if id, ok := message["toolCallId"].(string); ok {
			calls[id] = true
			if message["role"] == "toolResult" && (message["toolName"] == "read" || message["toolName"] == "edit" || message["toolName"] == "write") {
				missing[id] = true
			}
		}
		if parts, ok := message["content"].([]any); ok {
			for _, part := range parts {
				if value, ok := part.(map[string]any); ok {
					if id, ok := value["id"].(string); ok {
						calls[id] = true
					}
				}
			}
		}
	}
	for _, item := range page.Items {
		message := historyMessage(item)
		if message["role"] != "assistant" {
			continue
		}
		if parts, ok := message["content"].([]any); ok {
			for _, part := range parts {
				if value, ok := part.(map[string]any); ok {
					if id, ok := value["id"].(string); ok {
						delete(missing, id)
					}
				}
			}
		}
	}
	needBoundary := true
	position := end
	for needBoundary || len(missing) > 0 {
		item, err := branch.entry(handle, file, position, maxLine)
		if err != nil {
			return err
		}
		if item == nil {
			break
		}
		position++
		if item.Step == nil {
			needBoundary = false
		}
		if len(missing) == 0 || item.Role != "assistant" {
			continue
		}
		value, err := readHistoryItem(handle, item, maxLine)
		if err != nil {
			return err
		}
		message := historyMessage(value)
		parts, ok := message["content"].([]any)
		if !ok {
			continue
		}
		selected := make([]any, 0)
		for _, part := range parts {
			call, ok := part.(map[string]any)
			if !ok || call["type"] != "toolCall" {
				continue
			}
			id, _ := call["id"].(string)
			if missing[id] {
				selected = append(selected, call)
				delete(missing, id)
			}
		}
		if len(selected) > 0 {
			value.Value["message"] = map[string]any{"role": "assistant", "content": selected}
			page.ContextCalls = append(page.ContextCalls, value)
		}
	}
	for _, source := range branch.Steps {
		if source.Position >= position {
			continue
		}
		step, err := file.stepState(handle, source.Source, maxLine)
		if err != nil {
			return err
		}
		relevant := stepIDs[step.ID]
		for _, id := range step.Calls {
			relevant = relevant || calls[id]
		}
		for _, id := range step.Entries {
			relevant = relevant || entries[id]
		}
		if relevant {
			page.StepItems = append(page.StepItems, historyItemFromPayload(source.Source, map[string]any{"type": "custom", "customType": "lystar.web.agent-step", "data": step.Data}))
		}
	}
	return nil
}
