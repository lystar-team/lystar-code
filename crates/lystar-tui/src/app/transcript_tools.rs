use lystar_protocol::{ToolCall, ToolDiff, TranscriptItem, TranscriptViewItem};

use super::live_diff::{DiffLineKind, diff_summary, transcript_diff_lines};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptDetailLine {
    pub text: String,
    pub diff_kind: Option<DiffLineKind>,
}

pub(super) fn detail_lines_for_item(
    item: &TranscriptItem,
    round_items: &[TranscriptItem],
) -> Vec<TranscriptDetailLine> {
    let mut lines = vec![TranscriptDetailLine {
        text: format!("{} {}", item.entry_id, item.timestamp),
        diff_kind: Some(DiffLineKind::Metadata),
    }];
    match &item.view {
        TranscriptViewItem::ToolResult {
            detail,
            content_ref,
            diff,
            ..
        } => {
            if let Some(detail) = detail {
                lines.push(TranscriptDetailLine {
                    text: detail.clone(),
                    diff_kind: Some(DiffLineKind::Metadata),
                });
            }
            if let Some(content_ref) = content_ref {
                lines.push(TranscriptDetailLine {
                    text: format!("content_ref: {content_ref}"),
                    diff_kind: Some(DiffLineKind::Metadata),
                });
            }
            if let Some(diff) = diff {
                let diff = diff_with_fallback_path(diff, fallback_path(item, round_items));
                lines.extend(transcript_diff_lines(&diff).into_iter().map(|line| {
                    TranscriptDetailLine {
                        text: line.text,
                        diff_kind: Some(line.kind),
                    }
                }));
            }
        }
        _ => lines.push(TranscriptDetailLine {
            text: item_summary(item),
            diff_kind: None,
        }),
    }
    lines
}

pub(super) fn tool_calls(item: &TranscriptItem) -> &[ToolCall] {
    match &item.view {
        TranscriptViewItem::ToolCall { calls } => calls,
        _ => &[],
    }
}

pub(super) fn tool_result_summary(
    item: &TranscriptItem,
    round_items: &[TranscriptItem],
) -> Option<String> {
    let TranscriptViewItem::ToolResult {
        name,
        status,
        summary,
        diff,
        ..
    } = &item.view
    else {
        return None;
    };
    let fallback_path = fallback_path(item, round_items);
    let diff_summary = diff.as_ref().map_or(String::new(), |value| {
        format!("  {}", diff_summary(value, fallback_path))
    });
    if status == "error" {
        Some(format!("{name} 错误: {summary}{diff_summary}"))
    } else {
        Some(format!("{name} 完成: {summary}{diff_summary}"))
    }
}

pub(super) fn item_summary(item: &TranscriptItem) -> String {
    match &item.view {
        TranscriptViewItem::User { text, .. } => format!("用户  {text}"),
        TranscriptViewItem::Assistant { text, .. } => format!("助手  {text}"),
        TranscriptViewItem::Thinking { text } => format!("思考  {text}"),
        TranscriptViewItem::Bash { text } => format!("Bash  {text}"),
        TranscriptViewItem::Custom { text } => format!("自定义  {text}"),
        TranscriptViewItem::Summary { title, text } => format!("{title}  {text}"),
        TranscriptViewItem::System { text } => format!("系统  {text}"),
        TranscriptViewItem::ToolCall { .. } | TranscriptViewItem::ToolResult { .. } => {
            "Tool".to_owned()
        }
    }
}

fn fallback_path<'a>(item: &TranscriptItem, round_items: &'a [TranscriptItem]) -> Option<&'a str> {
    let TranscriptViewItem::ToolResult { call_id, .. } = &item.view else {
        return None;
    };
    round_items
        .iter()
        .flat_map(tool_calls)
        .find(|call| call.id == *call_id)
        .map(|call| call.summary.as_str())
}

fn diff_with_fallback_path(diff: &ToolDiff, fallback: Option<&str>) -> ToolDiff {
    let Some(path) = fallback else {
        return diff.clone();
    };
    let mut diff = diff.clone();
    if diff.files.len() == 1 && diff.files[0].path.is_none() {
        diff.files[0].path = Some(path.to_owned());
    }
    diff
}
