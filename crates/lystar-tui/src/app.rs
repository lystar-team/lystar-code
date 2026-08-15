use std::collections::VecDeque;

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
    widgets::{Block, Borders, StatefulWidget, Widget},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

const PAGE_CACHE_LIMIT: usize = 400;

#[derive(Debug, Clone)]
pub struct TranscriptItem {
    pub id: usize,
    pub text: String,
}

#[derive(Debug, Default)]
pub struct TranscriptWindow {
    items: VecDeque<TranscriptItem>,
    pub scroll: usize,
}

impl TranscriptWindow {
    pub fn replace_page(&mut self, page: impl IntoIterator<Item = TranscriptItem>) {
        self.items.clear();
        self.extend_page(page);
        self.scroll = self.scroll.min(self.items.len().saturating_sub(1));
    }

    pub fn extend_page(&mut self, page: impl IntoIterator<Item = TranscriptItem>) {
        self.items.extend(page);
        while self.items.len() > PAGE_CACHE_LIMIT {
            self.items.pop_front();
            self.scroll = self.scroll.saturating_sub(1);
        }
    }

    pub fn scroll_by(&mut self, delta: isize) {
        self.scroll = self
            .scroll
            .saturating_add_signed(delta)
            .min(self.items.len().saturating_sub(1));
    }

    pub fn cached_items(&self) -> usize {
        self.items.len()
    }
}

pub struct TranscriptView<'a> {
    state: &'a TranscriptWindow,
}

impl<'a> TranscriptView<'a> {
    pub fn new(state: &'a TranscriptWindow) -> Self {
        Self { state }
    }
}

impl StatefulWidget for TranscriptView<'_> {
    type State = ();

    fn render(self, area: Rect, buffer: &mut Buffer, _state: &mut Self::State) {
        Block::default()
            .borders(Borders::ALL)
            .title("LYStar Rust B0")
            .render(area, buffer);
        let inner = area.inner(ratatui::layout::Margin {
            vertical: 1,
            horizontal: 1,
        });
        for (row, item) in self
            .state
            .items
            .iter()
            .skip(self.state.scroll)
            .take(usize::from(inner.height))
            .enumerate()
        {
            let text = truncate_graphemes(
                &format!("{:05} {}", item.id, item.text),
                usize::from(inner.width),
            );
            buffer.set_string(
                inner.x,
                inner.y + row as u16,
                text,
                Style::default().fg(Color::White),
            );
        }
    }
}

pub fn truncate_graphemes(input: &str, width: usize) -> String {
    let mut output = String::new();
    let mut used = 0;
    for grapheme in input.graphemes(true) {
        let next = UnicodeWidthStr::width(grapheme);
        if used + next > width {
            break;
        }
        output.push_str(grapheme);
        used += next;
    }
    output
}
