use crate::rich_text::parse_ansi_lines;

use super::{LiveToolStatus, transcript::sanitize_render_text};

const MAX_OUTPUT_BYTES: usize = 12 * 1024;
const MAX_OUTPUT_LINES: usize = 120;
const COLLAPSED_OUTPUT_LINES: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveBash {
    command: String,
    output: String,
    truncated: bool,
    expanded: bool,
}

impl LiveBash {
    pub fn new(command: String) -> Self {
        Self {
            command: sanitize_bash_text(&command),
            output: String::new(),
            truncated: false,
            expanded: false,
        }
    }

    pub fn replace_output(&mut self, output: String) {
        let (output, truncated) = bounded_output(sanitize_bash_text(&output));
        self.output = output;
        self.truncated = truncated;
    }

    pub fn set_expanded(&mut self, expanded: bool) {
        self.expanded = expanded;
    }

    pub fn is_expanded(&self) -> bool {
        self.expanded
    }

    #[cfg(test)]
    pub(crate) fn output(&self) -> &str {
        &self.output
    }

    #[cfg(test)]
    pub(crate) fn is_truncated(&self) -> bool {
        self.truncated
    }

    pub fn display_lines(&self, status: LiveToolStatus) -> Vec<String> {
        let mut lines = Vec::new();
        let title = if self.command.is_empty() {
            format!("Bash {}", status.label())
        } else {
            format!("Bash {}  {}", status.label(), self.command)
        };
        lines.extend(title.split('\n').map(str::to_owned));
        if !self.output.is_empty() {
            let output_lines = self.output.lines().collect::<Vec<_>>();
            let start = if self.expanded {
                0
            } else {
                output_lines.len().saturating_sub(COLLAPSED_OUTPUT_LINES)
            };
            if start > 0 {
                lines.push("...".to_owned());
            }
            lines.extend(output_lines[start..].iter().map(|line| (*line).to_owned()));
        }
        if self.truncated && self.output.lines().last() != Some("输出已截断") {
            lines.push("输出已截断".to_owned());
        }
        lines
    }
}

fn sanitize_bash_text(value: &str) -> String {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let source = normalized
        .split('\n')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    parse_ansi_lines(&source)
        .lines
        .into_iter()
        .map(|line| {
            line.spans
                .into_iter()
                .map(|span| sanitize_render_text(&span.text))
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn bounded_output(output: String) -> (String, bool) {
    let lines = output.split('\n').collect::<Vec<_>>();
    let line_start = lines.len().saturating_sub(MAX_OUTPUT_LINES);
    let mut output = lines[line_start..].join("\n");
    let mut truncated = line_start > 0;
    if output.len() > MAX_OUTPUT_BYTES {
        let mut start = output.len().saturating_sub(MAX_OUTPUT_BYTES);
        while start < output.len() && !output.is_char_boundary(start) {
            start += 1;
        }
        output = output[start..].to_owned();
        truncated = true;
    }
    (output, truncated)
}
