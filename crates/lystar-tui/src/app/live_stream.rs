use std::collections::VecDeque;

use ratatui::style::{Color, Modifier, Style};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use super::{
    AppState, CompactionStatus, LiveToolStatus, RetryStatus, live_diff::DiffLineKind,
    transcript::sanitize_render_text,
};

pub(super) fn streaming_tail_lines(
    state: &AppState,
    width: usize,
    max_lines: u16,
) -> Vec<(String, Style)> {
    if max_lines == 0
        || state.transcript.current.saturating_add(1) < state.transcript.cached_rounds()
    {
        return Vec::new();
    }

    let mut lines = VecDeque::new();
    if !state.thinking_stream.is_empty() {
        push_stream_lines(
            &mut lines,
            &state.thinking_stream,
            width,
            max_lines,
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::ITALIC),
        );
    }
    if !state.thinking_stream.is_empty() && !state.assistant_stream.is_empty() {
        push_stream_line(&mut lines, String::new(), Style::default(), max_lines);
    }
    if !state.assistant_stream.is_empty() {
        push_stream_lines(
            &mut lines,
            &state.assistant_stream,
            width,
            max_lines,
            Style::default().fg(Color::White),
        );
    }
    if !state.live_tools.is_empty() {
        if !lines.is_empty() {
            push_stream_line(&mut lines, String::new(), Style::default(), max_lines);
        }
        for (_, tool) in state.live_tools.iter() {
            for line in tool.rendered_lines() {
                push_stream_lines(
                    &mut lines,
                    &line.text,
                    width,
                    max_lines,
                    line.diff_kind
                        .map_or_else(|| live_tool_style(tool.status), diff_line_style),
                );
            }
        }
    }
    if let Some(compaction) = &state.compaction {
        if !lines.is_empty() {
            push_stream_line(&mut lines, String::new(), Style::default(), max_lines);
        }
        push_stream_lines(
            &mut lines,
            &compaction.display(),
            width,
            max_lines,
            compaction_style(compaction.status),
        );
    }
    if let Some(retry) = &state.retry {
        if !lines.is_empty() {
            push_stream_line(&mut lines, String::new(), Style::default(), max_lines);
        }
        push_stream_lines(
            &mut lines,
            &retry.display(),
            width,
            max_lines,
            retry_style(retry.status),
        );
    }
    lines.into_iter().collect()
}

fn retry_style(status: RetryStatus) -> Style {
    match status {
        RetryStatus::Waiting | RetryStatus::Running => Style::default().fg(Color::Yellow),
        RetryStatus::Failed => Style::default().fg(Color::Red),
    }
}

fn compaction_style(status: CompactionStatus) -> Style {
    match status {
        CompactionStatus::Running | CompactionStatus::WaitingRetry => {
            Style::default().fg(Color::Yellow)
        }
        CompactionStatus::Completed => Style::default().fg(Color::Green),
        CompactionStatus::Cancelled => Style::default().fg(Color::DarkGray),
        CompactionStatus::Failed => Style::default().fg(Color::Red),
    }
}

fn live_tool_style(status: LiveToolStatus) -> Style {
    match status {
        LiveToolStatus::Pending => Style::default().fg(Color::DarkGray),
        LiveToolStatus::Running => Style::default().fg(Color::Yellow),
        LiveToolStatus::Success => Style::default().fg(Color::Green),
        LiveToolStatus::Error => Style::default().fg(Color::Red),
        LiveToolStatus::Cancelled => Style::default().fg(Color::DarkGray),
    }
}

fn diff_line_style(kind: DiffLineKind) -> Style {
    match kind {
        DiffLineKind::FileHeader => Style::default().fg(Color::Cyan),
        DiffLineKind::HunkHeader => Style::default().fg(Color::Yellow),
        DiffLineKind::Addition => Style::default().fg(Color::Green),
        DiffLineKind::Deletion => Style::default().fg(Color::Red),
        DiffLineKind::Context => Style::default().fg(Color::DarkGray),
        DiffLineKind::Metadata => Style::default().fg(Color::DarkGray),
    }
}

fn push_stream_lines(
    lines: &mut VecDeque<(String, Style)>,
    text: &str,
    width: usize,
    max_lines: u16,
    style: Style,
) {
    let width = width.max(1);
    for source_line in text.split('\n') {
        let source_line = sanitize_render_text(source_line);
        if source_line.is_empty() {
            push_stream_line(lines, String::new(), style, max_lines);
            continue;
        }
        let mut line = String::new();
        let mut line_width = 0_usize;
        for grapheme in source_line.graphemes(true) {
            let grapheme_width = UnicodeWidthStr::width(grapheme);
            if line_width.saturating_add(grapheme_width) > width && !line.is_empty() {
                push_stream_line(lines, line, style, max_lines);
                line = String::new();
                line_width = 0;
            }
            if grapheme_width <= width {
                line.push_str(grapheme);
                line_width = line_width.saturating_add(grapheme_width);
            }
        }
        if !line.is_empty() {
            push_stream_line(lines, line, style, max_lines);
        }
    }
}

fn push_stream_line(
    lines: &mut VecDeque<(String, Style)>,
    line: String,
    style: Style,
    max_lines: u16,
) {
    if max_lines == 0 {
        return;
    }
    if lines.len() == usize::from(max_lines) {
        lines.pop_front();
    }
    lines.push_back((line, style));
}
