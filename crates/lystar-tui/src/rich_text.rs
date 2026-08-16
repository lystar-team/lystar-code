use std::{
    collections::{HashMap, VecDeque},
    mem,
};

use ratatui::style::{Color, Modifier, Style};

pub const RICH_TEXT_CACHE_ENTRIES: usize = 256;
pub const RICH_TEXT_CACHE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RichTextKey {
    pub entry_id: String,
    pub content_hash: String,
    pub width: u16,
    pub is_streaming: bool,
}

#[derive(Debug, Clone)]
pub struct RichSpan {
    pub text: String,
    pub style: Style,
    pub href: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RichLine {
    pub spans: Vec<RichSpan>,
}

impl RichLine {
    pub fn plain(&self) -> String {
        self.spans.iter().map(|span| span.text.as_str()).collect()
    }
}

#[derive(Debug, Clone, Default)]
pub struct RenderedRichText {
    pub lines: Vec<RichLine>,
}

impl RenderedRichText {
    fn byte_len(&self) -> usize {
        self.lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.text.len() + span.href.as_ref().map_or(0, String::len) + 64)
            .sum()
    }
}

#[derive(Debug, Clone)]
struct CacheEntry {
    value: RenderedRichText,
    bytes: usize,
}

#[derive(Debug, Default)]
pub struct RichTextCache {
    entries: HashMap<RichTextKey, CacheEntry>,
    lru: VecDeque<RichTextKey>,
    bytes: usize,
}

impl RichTextCache {
    pub fn get(&self, key: &RichTextKey) -> Option<&RenderedRichText> {
        self.entries.get(key).map(|entry| &entry.value)
    }

    pub fn touch(&mut self, key: &RichTextKey) {
        if let Some(index) = self.lru.iter().position(|candidate| candidate == key) {
            let key = self.lru.remove(index).expect("LRU key must exist");
            self.lru.push_back(key);
        }
    }

    pub fn insert(&mut self, key: RichTextKey, value: RenderedRichText) {
        let bytes = value.byte_len();
        if let Some(previous) = self.entries.remove(&key) {
            self.bytes = self.bytes.saturating_sub(previous.bytes);
            self.lru.retain(|candidate| candidate != &key);
        }
        self.bytes = self.bytes.saturating_add(bytes);
        self.lru.push_back(key.clone());
        self.entries.insert(key, CacheEntry { value, bytes });
        while self.entries.len() > RICH_TEXT_CACHE_ENTRIES || self.bytes > RICH_TEXT_CACHE_BYTES {
            let Some(oldest) = self.lru.pop_front() else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(entry.bytes);
            }
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.lru.clear();
        self.bytes = 0;
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

pub fn parse_ansi_lines(lines: &[String]) -> RenderedRichText {
    RenderedRichText {
        lines: lines.iter().map(|line| parse_ansi_line(line)).collect(),
    }
}

fn parse_ansi_line(input: &str) -> RichLine {
    let bytes = input.as_bytes();
    let mut index = 0;
    let mut style = Style::default();
    let mut href: Option<String> = None;
    let mut spans = Vec::new();
    let mut text = String::new();
    while index < bytes.len() {
        if bytes[index] != 0x1b {
            let character = input[index..]
                .chars()
                .next()
                .expect("valid UTF-8 character");
            if !character.is_control() {
                text.push(character);
            }
            index += character.len_utf8();
            continue;
        }
        flush_span(&mut spans, &mut text, style, &href);
        index += 1;
        match bytes.get(index).copied() {
            Some(b'[') => {
                index += 1;
                let start = index;
                while index < bytes.len() && !(0x40..=0x7e).contains(&bytes[index]) {
                    index += 1;
                }
                if bytes.get(index) == Some(&b'm') {
                    apply_sgr(&input[start..index], &mut style);
                }
                index = index.saturating_add(1);
            }
            Some(b']') => {
                index += 1;
                let start = index;
                while index < bytes.len() && bytes[index] != 0x07 {
                    if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
                        break;
                    }
                    index += 1;
                }
                let sequence = &input[start..index];
                if let Some(target) = sequence.strip_prefix("8;;") {
                    href = (!target.is_empty()).then(|| target.to_owned());
                }
                if bytes.get(index) == Some(&0x07) {
                    index += 1;
                } else if bytes.get(index) == Some(&0x1b) && bytes.get(index + 1) == Some(&b'\\') {
                    index += 2;
                }
            }
            Some(_) => index += 1,
            None => break,
        }
    }
    flush_span(&mut spans, &mut text, style, &href);
    RichLine { spans }
}

fn flush_span(spans: &mut Vec<RichSpan>, text: &mut String, style: Style, href: &Option<String>) {
    if text.is_empty() {
        return;
    }
    let value = mem::take(text);
    if let Some(last) = spans.last_mut()
        && last.style == style
        && last.href == *href
    {
        last.text.push_str(&value);
    } else {
        spans.push(RichSpan {
            text: value,
            style,
            href: href.clone(),
        });
    }
}

fn apply_sgr(raw: &str, style: &mut Style) {
    let values = if raw.is_empty() {
        vec![0]
    } else {
        raw.split(';')
            .map(|value| value.parse::<u16>().unwrap_or(0))
            .collect()
    };
    let mut index = 0;
    while index < values.len() {
        match values[index] {
            0 => *style = Style::default(),
            1 => style.add_modifier |= Modifier::BOLD,
            3 => style.add_modifier |= Modifier::ITALIC,
            4 => style.add_modifier |= Modifier::UNDERLINED,
            9 => style.add_modifier |= Modifier::CROSSED_OUT,
            22 => style.sub_modifier |= Modifier::BOLD,
            23 => style.sub_modifier |= Modifier::ITALIC,
            24 => style.sub_modifier |= Modifier::UNDERLINED,
            29 => style.sub_modifier |= Modifier::CROSSED_OUT,
            30..=37 | 90..=97 => style.fg = Some(ansi_color(values[index] as u8)),
            39 => style.fg = None,
            40..=47 | 100..=107 => style.bg = Some(ansi_color(values[index] as u8 - 10)),
            49 => style.bg = None,
            38 | 48 => {
                let foreground = values[index] == 38;
                match values.get(index + 1).copied() {
                    Some(5) if values.get(index + 2).is_some() => {
                        let color = Color::Indexed(values[index + 2] as u8);
                        if foreground {
                            style.fg = Some(color)
                        } else {
                            style.bg = Some(color)
                        }
                        index += 2;
                    }
                    Some(2) if values.len() >= index + 5 => {
                        let color = Color::Rgb(
                            values[index + 2] as u8,
                            values[index + 3] as u8,
                            values[index + 4] as u8,
                        );
                        if foreground {
                            style.fg = Some(color)
                        } else {
                            style.bg = Some(color)
                        }
                        index += 4;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        index += 1;
    }
}

fn ansi_color(value: u8) -> Color {
    match value {
        30 | 40 => Color::Black,
        31 | 41 => Color::Red,
        32 | 42 => Color::Green,
        33 | 43 => Color::Yellow,
        34 | 44 => Color::Blue,
        35 | 45 => Color::Magenta,
        36 | 46 => Color::Cyan,
        37 | 47 => Color::Gray,
        90 | 100 => Color::DarkGray,
        91 | 101 => Color::LightRed,
        92 | 102 => Color::LightGreen,
        93 | 103 => Color::LightYellow,
        94 | 104 => Color::LightBlue,
        95 | 105 => Color::LightMagenta,
        96 | 106 => Color::LightCyan,
        97 | 107 => Color::White,
        _ => Color::Reset,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sgr_truecolor_and_osc8_without_retaining_unknown_controls() {
        let value = parse_ansi_lines(&["\u{1b}[1;38;2;1;2;3mBold\u{1b}[0m \u{1b}]8;;https://example.test\u{1b}\\link\u{1b}]8;;\u{1b}\\\u{1b}[?25l".to_owned()]);
        let spans = &value.lines[0].spans;
        assert_eq!(spans[0].text, "Bold");
        assert!(spans[0].style.add_modifier.contains(Modifier::BOLD));
        assert_eq!(spans[0].style.fg, Some(Color::Rgb(1, 2, 3)));
        assert_eq!(spans[2].href.as_deref(), Some("https://example.test"));
        assert_eq!(value.lines[0].plain(), "Bold link");
    }

    #[test]
    fn evicts_least_recently_used_entries_within_the_fixed_budget() {
        let mut cache = RichTextCache::default();
        for index in 0..RICH_TEXT_CACHE_ENTRIES + 1 {
            cache.insert(
                RichTextKey {
                    entry_id: index.to_string(),
                    content_hash: index.to_string(),
                    width: 80,
                    is_streaming: false,
                },
                RenderedRichText::default(),
            );
        }
        assert_eq!(cache.len(), RICH_TEXT_CACHE_ENTRIES);
        assert!(
            cache
                .get(&RichTextKey {
                    entry_id: "0".to_owned(),
                    content_hash: "0".to_owned(),
                    width: 80,
                    is_streaming: false
                })
                .is_none()
        );
    }
}
