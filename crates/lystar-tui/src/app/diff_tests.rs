use lystar_protocol::{
    SessionProgress, ToolCall, ToolDiff, ToolDiffFile, TranscriptItem, TranscriptViewItem,
};
use ratatui::{buffer::Buffer, layout::Rect, widgets::Widget};

use super::*;

fn diff(path: Option<&str>, text: &str, additions: u64, deletions: u64) -> ToolDiff {
    ToolDiff {
        files: vec![ToolDiffFile {
            path: path.map(str::to_owned),
            operation: Some("updated".to_owned()),
            additions: Some(additions),
            deletions: Some(deletions),
            diff: Some(text.to_owned()),
            truncated: None,
        }],
    }
}

fn rendered_transcript(app: &AppState) -> String {
    let area = Rect::new(0, 0, 80, 20);
    let mut buffer = Buffer::empty(area);
    TranscriptView::new(app).render(area, &mut buffer);
    buffer
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>()
        .replace(' ', "")
}

#[test]
fn live_diff_reuses_start_path_and_replaces_end_snapshot() {
    let mut app = AppState::default();
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "edit-1".to_owned(),
        name: "edit".to_owned(),
        summary: Some("src/lib.rs".to_owned()),
        diff: Some(ToolDiff {
            files: vec![ToolDiffFile {
                path: Some("src/lib.rs".to_owned()),
                operation: None,
                additions: None,
                deletions: None,
                diff: None,
                truncated: None,
            }],
        }),
    });
    app.apply_progress(SessionProgress::ToolUpdate {
        tool_call_id: "edit-1".to_owned(),
        name: "edit".to_owned(),
        summary: "src/lib.rs".to_owned(),
        diff: Some(diff(
            None,
            "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new",
            1,
            1,
        )),
    });
    app.apply_progress(SessionProgress::ToolEnd {
        tool_call_id: "edit-1".to_owned(),
        name: "edit".to_owned(),
        status: "success".to_owned(),
        summary: "已编辑".to_owned(),
        diff: Some(diff(
            None,
            "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old\n+newer",
            1,
            1,
        )),
    });

    app.toggle_tool_expansion();
    let rendered = rendered_transcript(&app);
    assert!(rendered.contains("src/lib.rs更新+1-1"), "{rendered:?}");
    let lines = app
        .live_tools
        .get("edit-1")
        .expect("edit tool")
        .display_lines();
    assert!(lines.iter().any(|line| line == "+newer"), "{lines:?}");
    assert!(!lines.iter().any(|line| line == "+new"), "{lines:?}");
}

#[test]
fn ctrl_o_expands_live_diff_and_bash_with_one_shared_state() {
    let mut app = AppState::default();
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "bash-1".to_owned(),
        name: "bash".to_owned(),
        summary: Some("printf ready".to_owned()),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolUpdate {
        tool_call_id: "bash-1".to_owned(),
        name: "bash".to_owned(),
        summary: "one\ntwo\nthree\nfour".to_owned(),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "edit-1".to_owned(),
        name: "edit".to_owned(),
        summary: Some("src/lib.rs".to_owned()),
        diff: Some(diff(
            Some("src/lib.rs"),
            "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new",
            1,
            1,
        )),
    });

    app.toggle_tool_expansion();
    let rendered = rendered_transcript(&app);
    assert!(rendered.contains("one"), "{rendered:?}");
    assert!(rendered.contains("+new"), "{rendered:?}");
    app.toggle_tool_expansion();
    assert!(
        app.live_tools
            .get("bash-1")
            .and_then(|tool| tool.bash())
            .is_some_and(|bash| !bash.is_expanded())
    );
}

#[test]
fn committed_diff_replaces_matching_live_tail_without_duplicate() {
    let mut app = AppState::default();
    app.transcript.replace_page(
        vec![TranscriptItem {
            entry_id: "call".to_owned(),
            timestamp: String::new(),
            view: TranscriptViewItem::ToolCall {
                calls: vec![ToolCall {
                    id: "edit-1".to_owned(),
                    name: "edit".to_owned(),
                    summary: "src/lib.rs".to_owned(),
                    href: None,
                }],
            },
        }],
        "g".to_owned(),
        1,
        None,
    );
    let value = diff(
        Some("src/lib.rs"),
        "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new",
        1,
        1,
    );
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "edit-1".to_owned(),
        name: "edit".to_owned(),
        summary: Some("src/lib.rs".to_owned()),
        diff: Some(value.clone()),
    });
    app.apply_progress(SessionProgress::ToolEnd {
        tool_call_id: "edit-1".to_owned(),
        name: "edit".to_owned(),
        status: "success".to_owned(),
        summary: "已编辑".to_owned(),
        diff: Some(value.clone()),
    });
    let committed = vec![TranscriptItem {
        entry_id: "result".to_owned(),
        timestamp: String::new(),
        view: TranscriptViewItem::ToolResult {
            call_id: "edit-1".to_owned(),
            name: "edit".to_owned(),
            status: "success".to_owned(),
            summary: "已编辑".to_owned(),
            detail: None,
            content_ref: None,
            diff: Some(diff(
                None,
                "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new",
                1,
                1,
            )),
            images: None,
        },
    }];
    assert!(
        app.transcript
            .append_committed("g", 1, 2, committed.clone())
    );
    app.clear_live_after_commit(&committed);
    app.toggle_tool_expansion();

    let rendered = rendered_transcript(&app);
    assert!(app.live_tools.get("edit-1").is_none());
    assert_eq!(rendered.matches("+new").count(), 1, "{rendered:?}");
    let details = app.transcript.rounds()[0].detail_lines();
    assert!(
        details
            .iter()
            .any(|line| line.text == "src/lib.rs 更新 +1 -1"),
        "{details:?}"
    );
    assert!(
        details
            .iter()
            .any(|line| line.diff_kind == Some(super::live_diff::DiffLineKind::Addition))
    );
    assert!(
        details
            .iter()
            .any(|line| line.diff_kind == Some(super::live_diff::DiffLineKind::HunkHeader))
    );
}

#[test]
fn multi_file_diff_preserves_tool_order_and_statistics() {
    let mut app = AppState::default();
    let files = ToolDiff {
        files: vec![
            ToolDiffFile {
                path: Some("src/first.rs".to_owned()),
                operation: Some("updated".to_owned()),
                additions: Some(2),
                deletions: Some(1),
                diff: Some("--- a/src/first.rs\n+++ b/src/first.rs\n+first".to_owned()),
                truncated: None,
            },
            ToolDiffFile {
                path: Some("src/second.rs".to_owned()),
                operation: Some("created".to_owned()),
                additions: Some(3),
                deletions: Some(0),
                diff: Some("--- /dev/null\n+++ b/src/second.rs\n+second".to_owned()),
                truncated: None,
            },
        ],
    };
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "patch-1".to_owned(),
        name: "apply_patch".to_owned(),
        summary: Some("应用补丁".to_owned()),
        diff: Some(files.clone()),
    });
    app.toggle_tool_expansion();

    let lines = app
        .live_tools
        .get("patch-1")
        .expect("patch tool")
        .display_lines();
    let first = lines
        .iter()
        .position(|line| line == "src/first.rs 更新 +2 -1")
        .expect("first file");
    let second = lines
        .iter()
        .position(|line| line == "src/second.rs 新增 +3 -0")
        .expect("second file");
    assert!(first < second, "{lines:?}");
}

#[test]
fn write_statistics_are_visible_without_inventing_a_diff() {
    let mut app = AppState::default();
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "write-1".to_owned(),
        name: "write".to_owned(),
        summary: Some("src/new.rs".to_owned()),
        diff: Some(ToolDiff {
            files: vec![ToolDiffFile {
                path: Some("src/new.rs".to_owned()),
                operation: None,
                additions: None,
                deletions: None,
                diff: None,
                truncated: None,
            }],
        }),
    });
    app.apply_progress(SessionProgress::ToolEnd {
        tool_call_id: "write-1".to_owned(),
        name: "write".to_owned(),
        status: "success".to_owned(),
        summary: "已写入".to_owned(),
        diff: Some(ToolDiff {
            files: vec![ToolDiffFile {
                path: None,
                operation: Some("created".to_owned()),
                additions: Some(3),
                deletions: Some(0),
                diff: None,
                truncated: None,
            }],
        }),
    });
    let rendered = rendered_transcript(&app);
    assert!(rendered.contains("src/new.rs新增+3-0"), "{rendered:?}");
    assert!(!rendered.contains("@@"), "{rendered:?}");
}
