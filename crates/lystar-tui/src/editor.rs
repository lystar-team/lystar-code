use std::collections::VecDeque;

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub const MAX_EDITOR_BYTES: usize = 64 * 1024;
pub const MAX_HISTORY_ENTRIES: usize = 200;
pub const MAX_UNDO_ENTRIES: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
struct EditorSnapshot {
    text: String,
    cursor: usize,
}

#[derive(Debug, Clone, Default)]
pub struct EditorState {
    text: String,
    cursor: usize,
    preferred_column: Option<usize>,
    scroll_line: usize,
    undo: Vec<EditorSnapshot>,
    redo: Vec<EditorSnapshot>,
    history: VecDeque<String>,
    history_index: Option<usize>,
    history_draft: Option<EditorSnapshot>,
}

impl EditorState {
    pub fn scroll_line(&self) -> usize {
        self.scroll_line
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn insert(&mut self, input: &str) {
        if input.is_empty() || self.text.len() >= MAX_EDITOR_BYTES {
            return;
        }
        let remaining = MAX_EDITOR_BYTES - self.text.len();
        let accepted = truncate_utf8(input, remaining);
        if accepted.is_empty() {
            return;
        }
        self.record_edit();
        self.text.insert_str(self.cursor, accepted);
        self.cursor += accepted.len();
        self.after_move();
    }

    pub fn clear(&mut self) {
        if self.text.is_empty() {
            return;
        }
        self.record_edit();
        self.text.clear();
        self.cursor = 0;
        self.after_move();
    }

    pub fn backspace(&mut self) {
        let Some(start) = self.previous_grapheme_boundary() else {
            return;
        };
        self.record_edit();
        self.text.replace_range(start..self.cursor, "");
        self.cursor = start;
        self.after_move();
    }

    pub fn delete(&mut self) {
        let Some(end) = self.next_grapheme_boundary() else {
            return;
        };
        self.record_edit();
        self.text.replace_range(self.cursor..end, "");
        self.after_move();
    }

    pub fn move_left(&mut self) {
        if let Some(start) = self.previous_grapheme_boundary() {
            self.cursor = start;
            self.after_move();
        }
    }

    pub fn move_right(&mut self) {
        if let Some(end) = self.next_grapheme_boundary() {
            self.cursor = end;
            self.after_move();
        }
    }

    pub fn move_home(&mut self) {
        self.cursor = self.line_start(self.cursor);
        self.after_move();
    }

    pub fn move_end(&mut self) {
        self.cursor = self.line_end(self.cursor);
        self.after_move();
    }

    pub fn move_up(&mut self) {
        self.move_vertical(-1);
    }

    pub fn move_down(&mut self) {
        self.move_vertical(1);
    }

    pub fn undo(&mut self) {
        let Some(snapshot) = self.undo.pop() else {
            return;
        };
        self.redo.push(self.snapshot());
        self.restore(snapshot);
    }

    pub fn redo(&mut self) {
        let Some(snapshot) = self.redo.pop() else {
            return;
        };
        self.undo.push(self.snapshot());
        self.restore(snapshot);
    }

    pub fn submit(&mut self) -> Option<String> {
        let submitted = self.text.trim_end().to_owned();
        if submitted.trim().is_empty() {
            return None;
        }
        if self.history.back() != Some(&submitted) {
            self.history.push_back(submitted.clone());
            while self.history.len() > MAX_HISTORY_ENTRIES {
                self.history.pop_front();
            }
        }
        self.text.clear();
        self.cursor = 0;
        self.preferred_column = None;
        self.scroll_line = 0;
        self.undo.clear();
        self.redo.clear();
        self.history_index = None;
        self.history_draft = None;
        Some(submitted)
    }

    pub fn history_previous(&mut self) -> bool {
        if self.history.is_empty() {
            return false;
        }
        let next = match self.history_index {
            Some(index) => index.saturating_sub(1),
            None => {
                self.history_draft = Some(self.snapshot());
                self.history.len() - 1
            }
        };
        self.history_index = Some(next);
        self.replace_from_history(next);
        true
    }

    pub fn history_next(&mut self) -> bool {
        let Some(index) = self.history_index else {
            return false;
        };
        if index + 1 < self.history.len() {
            let next = index + 1;
            self.history_index = Some(next);
            self.replace_from_history(next);
        } else {
            self.history_index = None;
            let draft = self.history_draft.take().unwrap_or(EditorSnapshot {
                text: String::new(),
                cursor: 0,
            });
            self.restore(draft);
        }
        true
    }

    pub fn visual_cursor(&self, width: u16) -> (usize, usize) {
        let segments = visual_segments(&self.text, usize::from(width).max(1));
        for (index, (start, end)) in segments.iter().enumerate() {
            if self.cursor < *end || (self.cursor == *end && index + 1 == segments.len()) {
                return (index, display_width(&self.text[*start..self.cursor]));
            }
        }
        (0, 0)
    }

    pub fn ensure_cursor_visible(&mut self, width: u16, rows: u16) {
        let visual_lines = visual_segments(&self.text, usize::from(width).max(1)).len();
        let (cursor_line, _) = self.visual_cursor(width);
        let rows = usize::from(rows.max(1));
        if cursor_line < self.scroll_line {
            self.scroll_line = cursor_line;
        } else if cursor_line >= self.scroll_line + rows {
            self.scroll_line = cursor_line + 1 - rows;
        }
        self.scroll_line = self.scroll_line.min(visual_lines.saturating_sub(rows));
    }

    pub fn at_first_visual_line_start(&self, width: u16) -> bool {
        self.cursor == 0 && self.visual_cursor(width).0 == 0
    }

    pub fn at_last_visual_line(&self, width: u16) -> bool {
        let segments = visual_segments(&self.text, usize::from(width).max(1));
        self.visual_cursor(width).0 + 1 == segments.len()
    }

    pub fn visual_lines_with_cursor(&self, width: u16) -> Vec<String> {
        let segments = visual_segments(&self.text, usize::from(width).max(1));
        segments
            .iter()
            .enumerate()
            .map(|(index, (start, end))| {
                let mut line = self.text[*start..*end].to_owned();
                if self.cursor < *end || (self.cursor == *end && index + 1 == segments.len()) {
                    let cursor = self.cursor.saturating_sub(*start).min(line.len());
                    line.insert(cursor, '|');
                }
                line
            })
            .collect()
    }

    pub fn cursor_line_column(&self) -> (usize, usize) {
        let line_start = self.line_start(self.cursor);
        (
            self.line_index(self.cursor),
            self.text[line_start..self.cursor].graphemes(true).count(),
        )
    }

    fn replace_from_history(&mut self, index: usize) {
        self.text = self.history[index].clone();
        self.cursor = self.text.len();
        self.undo.clear();
        self.redo.clear();
        self.after_move();
    }

    fn record_edit(&mut self) {
        self.undo.push(self.snapshot());
        while self.undo.len() > MAX_UNDO_ENTRIES {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.history_index = None;
    }

    fn snapshot(&self) -> EditorSnapshot {
        EditorSnapshot {
            text: self.text.clone(),
            cursor: self.cursor,
        }
    }

    fn restore(&mut self, snapshot: EditorSnapshot) {
        self.text = snapshot.text;
        self.cursor = snapshot.cursor;
        self.after_move();
    }

    fn after_move(&mut self) {
        self.preferred_column = None;
        self.cursor = self.cursor.min(self.text.len());
        let visual_lines = visual_segments(&self.text, usize::MAX).len();
        self.scroll_line = self.scroll_line.min(visual_lines.saturating_sub(1));
    }

    fn previous_grapheme_boundary(&self) -> Option<usize> {
        self.text[..self.cursor]
            .grapheme_indices(true)
            .next_back()
            .map(|(index, _)| index)
    }

    fn next_grapheme_boundary(&self) -> Option<usize> {
        let tail = &self.text[self.cursor..];
        tail.grapheme_indices(true)
            .next()
            .map(|(_, grapheme)| self.cursor + grapheme.len())
    }

    fn line_start(&self, cursor: usize) -> usize {
        self.text[..cursor].rfind('\n').map_or(0, |index| index + 1)
    }

    fn line_end(&self, cursor: usize) -> usize {
        self.text[cursor..]
            .find('\n')
            .map_or(self.text.len(), |index| cursor + index)
    }

    fn line_index(&self, cursor: usize) -> usize {
        self.text[..cursor]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
    }

    fn line_count(&self) -> usize {
        self.text.bytes().filter(|byte| *byte == b'\n').count() + 1
    }

    fn move_vertical(&mut self, delta: isize) {
        let (line, column) = self.cursor_line_column();
        let target = line.saturating_add_signed(delta).min(self.line_count() - 1);
        if target == line {
            return;
        }
        let column = self.preferred_column.unwrap_or(column);
        let start = nth_line_start(&self.text, target);
        let end = self.text[start..]
            .find('\n')
            .map_or(self.text.len(), |index| start + index);
        self.cursor = grapheme_offset(&self.text[start..end], column) + start;
        self.preferred_column = Some(column);
    }
}

fn visual_segments(text: &str, width: usize) -> Vec<(usize, usize)> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut columns = 0;
    for (index, grapheme) in text.grapheme_indices(true) {
        if grapheme == "\n" {
            segments.push((start, index));
            start = index + grapheme.len();
            columns = 0;
            continue;
        }
        let grapheme_width = UnicodeWidthStr::width(grapheme).max(1);
        if columns > 0 && columns + grapheme_width > width {
            segments.push((start, index));
            start = index;
            columns = 0;
        }
        columns += grapheme_width;
    }
    segments.push((start, text.len()));
    segments
}

fn display_width(text: &str) -> usize {
    text.graphemes(true).map(UnicodeWidthStr::width).sum()
}

fn truncate_utf8(input: &str, limit: usize) -> &str {
    if input.len() <= limit {
        return input;
    }
    let mut end = limit;
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    &input[..end]
}

fn nth_line_start(text: &str, target: usize) -> usize {
    if target == 0 {
        return 0;
    }
    text.match_indices('\n')
        .nth(target - 1)
        .map_or(text.len(), |(index, _)| index + 1)
}

fn grapheme_offset(text: &str, column: usize) -> usize {
    text.grapheme_indices(true)
        .nth(column)
        .map_or(text.len(), |(index, _)| index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edits_graphemes_and_multiline_cursor() {
        let mut editor = EditorState::default();
        editor.insert("a😀\n中文");
        editor.move_left();
        editor.delete();
        assert_eq!(editor.text, "a😀\n中");
        editor.move_up();
        assert_eq!(editor.cursor_line_column(), (0, 1));
        editor.move_end();
        assert_eq!(editor.cursor_line_column(), (0, 2));
    }

    #[test]
    fn limits_input_and_restores_history_draft() {
        let mut editor = EditorState::default();
        editor.insert("first");
        assert_eq!(editor.submit(), Some("first".to_owned()));
        editor.insert("draft");
        assert!(editor.history_previous());
        assert_eq!(editor.text, "first");
        assert!(editor.history_next());
        assert_eq!(editor.text, "draft");
        editor.insert(&"x".repeat(MAX_EDITOR_BYTES));
        assert!(editor.text.len() <= MAX_EDITOR_BYTES);
    }

    #[test]
    fn keeps_visual_cursor_and_history_draft_at_wrapped_boundaries() {
        let mut editor = EditorState::default();
        editor.insert("1234567890");
        editor.ensure_cursor_visible(4, 1);
        assert_eq!(editor.visual_cursor(4), (2, 2));
        assert_eq!(editor.scroll_line(), 2);
        assert!(!editor.at_first_visual_line_start(4));
        assert!(editor.at_last_visual_line(4));
        assert_eq!(editor.submit(), Some("1234567890".to_owned()));
        editor.insert("draft");
        editor.move_left();
        assert!(editor.history_previous());
        assert!(editor.history_next());
        assert_eq!(editor.text, "draft");
        assert_eq!(editor.cursor_line_column(), (0, 4));
    }
    #[test]
    fn undo_and_redo_keep_cursor() {
        let mut editor = EditorState::default();
        editor.insert("abc");
        editor.backspace();
        editor.undo();
        assert_eq!(editor.text, "abc");
        editor.redo();
        assert_eq!(editor.text, "ab");
    }
}
