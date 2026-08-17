use lystar_protocol::ToolDiff;

use super::transcript::sanitize_render_text;

const MAX_DIFF_BYTES: usize = 12 * 1024;
const MAX_DIFF_LINES: usize = 120;
const COLLAPSED_DIFF_LINES: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffLineKind {
    FileHeader,
    HunkHeader,
    Addition,
    Deletion,
    Context,
    Metadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub text: String,
    pub kind: DiffLineKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DiffFile {
    path: Option<String>,
    operation: Option<String>,
    additions: Option<u64>,
    deletions: Option<u64>,
    lines: Vec<DiffLine>,
    truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LiveDiff {
    files: Vec<DiffFile>,
    expanded: bool,
}

impl LiveDiff {
    pub fn replace_snapshot(&mut self, diff: &ToolDiff) {
        let previous = self.files.clone();
        self.files = build_files(diff, &previous, MAX_DIFF_BYTES, MAX_DIFF_LINES);
    }

    pub fn set_expanded(&mut self, expanded: bool) {
        self.expanded = expanded;
    }

    pub fn is_expanded(&self) -> bool {
        self.expanded
    }

    pub fn has_expandable_diff(&self) -> bool {
        self.files.iter().any(|file| !file.lines.is_empty())
    }

    pub fn display_lines(&self) -> Vec<DiffLine> {
        diff_file_lines(&self.files, self.expanded)
    }
}

pub fn transcript_diff_lines(diff: &ToolDiff) -> Vec<DiffLine> {
    diff_file_lines(
        &build_files(diff, &[], MAX_DIFF_BYTES, MAX_DIFF_LINES),
        true,
    )
}

pub fn diff_summary(diff: &ToolDiff, fallback_path: Option<&str>) -> String {
    let single_file = diff.files.len() == 1;
    diff.files
        .iter()
        .map(|file| {
            let path = file
                .path
                .as_deref()
                .or(if single_file { fallback_path } else { None })
                .unwrap_or("文件");
            let counts = counts(file.additions, file.deletions);
            if counts.is_empty() {
                path.to_owned()
            } else {
                format!("{path} {counts}")
            }
        })
        .collect::<Vec<_>>()
        .join("，")
}

fn build_files(
    diff: &ToolDiff,
    previous: &[DiffFile],
    mut remaining_bytes: usize,
    mut remaining_lines: usize,
) -> Vec<DiffFile> {
    diff.files
        .iter()
        .enumerate()
        .map(|(index, file)| {
            let prior = previous.get(index);
            let mut truncated = file.truncated.unwrap_or(false);
            let mut lines = Vec::new();
            if let Some(source) = &file.diff {
                for source_line in sanitize_diff(source).split('\n') {
                    if remaining_lines == 0 || remaining_bytes == 0 {
                        truncated = true;
                        break;
                    }
                    let (line, cut) = take_utf8_prefix(source_line, remaining_bytes);
                    if cut {
                        truncated = true;
                    }
                    remaining_bytes = remaining_bytes.saturating_sub(line.len());
                    remaining_lines = remaining_lines.saturating_sub(1);
                    lines.push(DiffLine {
                        kind: classify_diff_line(&line),
                        text: line,
                    });
                    if cut {
                        break;
                    }
                }
            }
            DiffFile {
                path: file
                    .path
                    .clone()
                    .or_else(|| prior.and_then(|value| value.path.clone())),
                operation: file
                    .operation
                    .clone()
                    .or_else(|| prior.and_then(|value| value.operation.clone())),
                additions: file
                    .additions
                    .or_else(|| prior.and_then(|value| value.additions)),
                deletions: file
                    .deletions
                    .or_else(|| prior.and_then(|value| value.deletions)),
                lines,
                truncated,
            }
        })
        .collect()
}

fn diff_file_lines(files: &[DiffFile], expanded: bool) -> Vec<DiffLine> {
    let mut output = Vec::new();
    for (index, file) in files.iter().enumerate() {
        if index > 0 {
            output.push(DiffLine {
                text: "-----".to_owned(),
                kind: DiffLineKind::Metadata,
            });
        }
        let path = file.path.as_deref().unwrap_or("文件");
        let counts = counts(file.additions, file.deletions);
        let operation = file.operation.as_deref().map_or(String::new(), |value| {
            format!(" {}", operation_label(value))
        });
        output.push(DiffLine {
            text: format!("{path}{operation} {counts}").trim_end().to_owned(),
            kind: DiffLineKind::FileHeader,
        });
        let preview = if expanded {
            &file.lines[..]
        } else {
            &file.lines[..file.lines.len().min(COLLAPSED_DIFF_LINES)]
        };
        output.extend_from_slice(preview);
        if !expanded && file.lines.len() > preview.len() {
            output.push(DiffLine {
                text: "...".to_owned(),
                kind: DiffLineKind::Metadata,
            });
        }
        if file.truncated {
            output.push(DiffLine {
                text: "Diff 已截断".to_owned(),
                kind: DiffLineKind::Metadata,
            });
        }
    }
    output
}

fn counts(additions: Option<u64>, deletions: Option<u64>) -> String {
    match (additions, deletions) {
        (Some(additions), Some(deletions)) => format!("+{additions} -{deletions}"),
        (Some(additions), None) => format!("+{additions}"),
        (None, Some(deletions)) => format!("-{deletions}"),
        (None, None) => String::new(),
    }
}

fn operation_label(operation: &str) -> &str {
    match operation {
        "add" | "created" => "新增",
        "update" | "updated" => "更新",
        "write" | "written" => "写入",
        "delete" | "deleted" => "删除",
        value => value,
    }
}

fn sanitize_diff(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(sanitize_render_text)
        .collect::<Vec<_>>()
        .join("\n")
}

fn take_utf8_prefix(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_owned(), false);
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_owned(), true)
}

pub fn classify_diff_line(line: &str) -> DiffLineKind {
    if line.starts_with("diff --git ") || line.starts_with("--- ") || line.starts_with("+++ ") {
        DiffLineKind::FileHeader
    } else if line.starts_with("@@") {
        DiffLineKind::HunkHeader
    } else if line.starts_with('+') {
        DiffLineKind::Addition
    } else if line.starts_with('-') {
        DiffLineKind::Deletion
    } else if line.starts_with(' ') {
        DiffLineKind::Context
    } else {
        DiffLineKind::Metadata
    }
}

#[cfg(test)]
mod tests {
    use lystar_protocol::ToolDiffFile;

    use super::*;

    fn file(path: &str, diff: &str) -> ToolDiffFile {
        ToolDiffFile {
            path: Some(path.to_owned()),
            operation: None,
            additions: Some(1),
            deletions: Some(1),
            diff: Some(diff.to_owned()),
            truncated: None,
        }
    }

    #[test]
    fn classifies_unified_diff_lines() {
        assert_eq!(classify_diff_line("--- a/file"), DiffLineKind::FileHeader);
        assert_eq!(classify_diff_line("@@ -1 +1 @@"), DiffLineKind::HunkHeader);
        assert_eq!(classify_diff_line("+added"), DiffLineKind::Addition);
        assert_eq!(classify_diff_line("-removed"), DiffLineKind::Deletion);
        assert_eq!(classify_diff_line(" context"), DiffLineKind::Context);
        assert_eq!(classify_diff_line("\\ No newline"), DiffLineKind::Metadata);
    }

    #[test]
    fn replaces_snapshots_and_bounds_controlled_diff() {
        let mut live = LiveDiff::default();
        live.replace_snapshot(&ToolDiff {
            files: vec![file("src/a.rs", "+one\n+two")],
        });
        live.replace_snapshot(&ToolDiff {
            files: vec![file("src/a.rs", "+three\0")],
        });
        let lines = live.display_lines();
        assert_eq!(lines.iter().filter(|line| line.text == "+three").count(), 1);
        assert!(!lines.iter().any(|line| line.text.contains('\0')));

        live.replace_snapshot(&ToolDiff {
            files: vec![file("src/a.rs", &"+x\n".repeat(MAX_DIFF_LINES + 1))],
        });
        assert!(
            live.display_lines()
                .iter()
                .any(|line| line.text == "Diff 已截断")
        );

        live.replace_snapshot(&ToolDiff {
            files: vec![file("src/a.rs", &"+界".repeat(MAX_DIFF_BYTES))],
        });
        assert!(
            live.display_lines()
                .iter()
                .any(|line| line.text == "Diff 已截断")
        );
    }
}
