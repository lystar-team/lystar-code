package main

import "os"

type historyBranchStep struct {
	Source   *historyEntry
	Position int
}

// 分支按需向前延伸，游标直接复用已定位的位置。
type historyBranch struct {
	Leaf       string
	LeafOffset int64
	Entries    []*historyEntry
	Positions  map[int64]int
	Steps      []historyBranchStep
	SeenSteps  map[string]bool
	NextID     string
	Boundary   int64
	Bytes      int64
}

func (f *historyFile) branch(leaf string, leafOffset int64) *historyBranch {
	for position, branch := range f.Branches {
		if branch.Leaf == leaf && branch.LeafOffset == leafOffset {
			copy(f.Branches[1:position+1], f.Branches[:position])
			f.Branches[0] = branch
			return branch
		}
	}
	branch := &historyBranch{Leaf: leaf, LeafOffset: leafOffset, NextID: leaf, Boundary: leafOffset + 1, Positions: make(map[int64]int), SeenSteps: make(map[string]bool)}
	if len(f.Branches) == 4 {
		f.Bytes -= f.Branches[3].Bytes
		f.Branches = f.Branches[:3]
	}
	f.Branches = append(f.Branches, nil)
	copy(f.Branches[1:], f.Branches[:len(f.Branches)-1])
	f.Branches[0] = branch
	return branch
}

func (b *historyBranch) entry(handle *os.File, file *historyFile, position int, maxLine int64) (*historyEntry, error) {
	for len(b.Entries) <= position && b.NextID != "" {
		source, err := file.lookup(handle, b.NextID, b.Boundary, maxLine)
		if err != nil {
			return nil, err
		}
		b.Positions[source.Offset] = len(b.Entries)
		if source.Step != nil && !b.SeenSteps[source.Step.ID] {
			b.SeenSteps[source.Step.ID] = true
			b.Steps = append(b.Steps, historyBranchStep{source, len(b.Entries)})
		}
		b.Entries = append(b.Entries, source)
		b.NextID, b.Boundary = source.ParentID, source.Offset
		b.Bytes += 64
		file.Bytes += 64
	}
	if position >= len(b.Entries) {
		return nil, nil
	}
	return b.Entries[position], nil
}

func (b *historyBranch) start(handle *os.File, file *historyFile, cursor *historyCursor, maxLine int64) (int, error) {
	if cursor == nil {
		return 0, nil
	}
	source, err := file.lookup(handle, cursor.WantedID, cursor.Offset, maxLine)
	if err != nil {
		return 0, err
	}
	for {
		if position, found := b.Positions[source.Offset]; found {
			return position, nil
		}
		entry, err := b.entry(handle, file, len(b.Entries), maxLine)
		if err != nil {
			return 0, err
		}
		if entry == nil || entry.Offset < source.Offset {
			return 0, changed()
		}
	}
}
