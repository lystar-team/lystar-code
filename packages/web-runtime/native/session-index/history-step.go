package main

import (
	"encoding/json"
)

// Old updates retain only their validated step ID in the offset index.
// Cache full association data only for versions actually used by a branch.
func (f *historyFile) stepState(handle *historyReader, source *historyEntry, maxLine int64) (*historyStep, error) {
	if step := f.StepStates[source.Offset]; step != nil {
		return step, nil
	}
	if source.Length-1 > maxLine {
		return nil, historyLineError(maxLine)
	}
	raw := make([]byte, source.Length)
	if _, err := handle.ReadAt(raw, source.Offset); err != nil {
		return nil, err
	}
	var entry struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &entry); err != nil {
		return nil, err
	}
	step := historyStepData(entry.Data)
	if step == nil || step.ID != source.Step.ID {
		return nil, changed()
	}
	bytes := int64(len(step.Data))*3 + 128
	if f.StepBytes+bytes <= 8*1024*1024 {
		if f.StepStates == nil {
			f.StepStates = make(map[int64]*historyStep)
		}
		f.StepStates[source.Offset] = step
		f.StepBytes += bytes
		f.Bytes += bytes
	}
	return step, nil
}
