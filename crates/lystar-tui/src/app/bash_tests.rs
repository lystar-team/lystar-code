use lystar_protocol::{
    OperationSnapshot, SessionProgress, ToolCall, TranscriptItem, TranscriptViewItem,
};
use ratatui::{buffer::Buffer, layout::Rect, widgets::Widget};

use super::*;

fn operation(status: &str) -> OperationSnapshot {
    OperationSnapshot {
        operation_id: "operation-1".to_owned(),
        client_instance_id: "client".to_owned(),
        client_request_id: "request".to_owned(),
        session_path: "/tmp/session.jsonl".to_owned(),
        operation_type: "prompt".to_owned(),
        status: status.to_owned(),
        progress: None,
        result: None,
        error: None,
    }
}

fn rendered_transcript(app: &AppState) -> String {
    let area = Rect::new(0, 0, 40, 8);
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
fn shows_command_and_start_order() {
    let mut app = AppState::default();
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "bash".to_owned(),
        name: "bash".to_owned(),
        summary: Some("printf ready".to_owned()),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "read".to_owned(),
        name: "read".to_owned(),
        summary: Some("src/main.rs".to_owned()),
        diff: None,
    });

    assert_eq!(
        app.live_tools.iter().map(|(id, _)| id).collect::<Vec<_>>(),
        vec!["bash", "read"]
    );
    assert!(
        app.live_tools
            .get("bash")
            .expect("bash tool")
            .display_lines()
            .contains(&"Bash 运行中  printf ready".to_owned())
    );
}

#[test]
fn replaces_output_snapshots_and_toggles_with_ctrl_o() {
    let mut app = AppState::default();
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "bash".to_owned(),
        name: "bash".to_owned(),
        summary: Some("printf one".to_owned()),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolUpdate {
        tool_call_id: "bash".to_owned(),
        name: "bash".to_owned(),
        summary: "one".to_owned(),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolUpdate {
        tool_call_id: "bash".to_owned(),
        name: "bash".to_owned(),
        summary: "one\ntwo\nthree\nfour".to_owned(),
        diff: None,
    });

    let bash = app
        .live_tools
        .get("bash")
        .and_then(|tool| tool.bash())
        .expect("bash state");
    assert_eq!(bash.output(), "one\ntwo\nthree\nfour");
    assert!(!bash.is_expanded());
    assert!(
        !app.live_tools
            .get("bash")
            .expect("bash tool")
            .display_lines()
            .contains(&"one".to_owned())
    );

    app.toggle_tool_expansion();
    let bash = app
        .live_tools
        .get("bash")
        .and_then(|tool| tool.bash())
        .expect("bash state");
    assert!(bash.is_expanded());
    let lines = app
        .live_tools
        .get("bash")
        .expect("bash tool")
        .display_lines();
    assert_eq!(
        lines.iter().filter(|line| line.as_str() == "one").count(),
        1
    );
    assert!(lines.contains(&"four".to_owned()));

    app.toggle_tool_expansion();
    assert!(
        !app.live_tools
            .get("bash")
            .and_then(|tool| tool.bash())
            .expect("bash state")
            .is_expanded()
    );
}

#[test]
fn surfaces_success_error_and_cancellation_without_inventing_metadata() {
    let mut app = AppState::default();
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "success".to_owned(),
        name: "bash".to_owned(),
        summary: Some("true".to_owned()),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolEnd {
        tool_call_id: "success".to_owned(),
        name: "bash".to_owned(),
        status: "success".to_owned(),
        summary: "done".to_owned(),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "failed".to_owned(),
        name: "bash".to_owned(),
        summary: Some("false".to_owned()),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolEnd {
        tool_call_id: "failed".to_owned(),
        name: "bash".to_owned(),
        status: "error".to_owned(),
        summary: "Command exited with code 7".to_owned(),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "cancelled".to_owned(),
        name: "bash".to_owned(),
        summary: Some("sleep 60".to_owned()),
        diff: None,
    });
    app.apply_operation(operation("aborted"));

    assert_eq!(
        app.live_tools.get("success").map(|tool| tool.status),
        Some(LiveToolStatus::Success)
    );
    assert_eq!(
        app.live_tools.get("failed").map(|tool| tool.status),
        Some(LiveToolStatus::Error)
    );
    assert_eq!(
        app.live_tools.get("cancelled").map(|tool| tool.status),
        Some(LiveToolStatus::Cancelled)
    );
    assert!(
        app.live_tools
            .get("failed")
            .expect("failed tool")
            .display_lines()
            .contains(&"Command exited with code 7".to_owned())
    );
}

#[test]
fn sanitizes_controls_and_stays_bounded() {
    let mut app = AppState::default();
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "bash".to_owned(),
        name: "bash".to_owned(),
        summary: Some("printf safe".to_owned()),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolUpdate {
        tool_call_id: "bash".to_owned(),
        name: "bash".to_owned(),
        summary: "\u{1b}]0;injected\u{7}safe\0".to_owned(),
        diff: None,
    });
    let bash = app
        .live_tools
        .get("bash")
        .and_then(|tool| tool.bash())
        .expect("bash state");
    assert_eq!(bash.output(), "safe");
    assert!(!rendered_transcript(&app).contains('\u{1b}'));

    let output = (0..130)
        .map(|index| format!("line-{index}"))
        .collect::<Vec<_>>()
        .join("\n");
    app.apply_progress(SessionProgress::ToolUpdate {
        tool_call_id: "bash".to_owned(),
        name: "bash".to_owned(),
        summary: output,
        diff: None,
    });
    let bash = app
        .live_tools
        .get("bash")
        .and_then(|tool| tool.bash())
        .expect("bash state");
    assert!(bash.is_truncated());
    assert!(!bash.output().contains("line-0"));
    assert!(
        app.live_tools
            .get("bash")
            .expect("bash tool")
            .display_lines()
            .contains(&"输出已截断".to_owned())
    );

    app.apply_progress(SessionProgress::ToolUpdate {
        tool_call_id: "bash".to_owned(),
        name: "bash".to_owned(),
        summary: format!("{}\n输出已截断", "x".repeat(13 * 1024)),
        diff: None,
    });
    let bash = app
        .live_tools
        .get("bash")
        .and_then(|tool| tool.bash())
        .expect("bash state");
    assert!(bash.is_truncated());
    assert!(bash.output().len() <= 12 * 1024);
    assert_eq!(
        app.live_tools
            .get("bash")
            .expect("bash tool")
            .display_lines()
            .iter()
            .filter(|line| line.as_str() == "输出已截断")
            .count(),
        1
    );
}

#[test]
fn committed_result_replaces_matching_live_tail_once() {
    let mut app = AppState::default();
    app.transcript.replace_page(
        vec![TranscriptItem {
            entry_id: "call".to_owned(),
            timestamp: String::new(),
            view: TranscriptViewItem::ToolCall {
                calls: vec![ToolCall {
                    id: "bash".to_owned(),
                    name: "bash".to_owned(),
                    summary: "printf done".to_owned(),
                    href: None,
                }],
            },
        }],
        "g".to_owned(),
        1,
        None,
    );
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "bash".to_owned(),
        name: "bash".to_owned(),
        summary: Some("printf done".to_owned()),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolEnd {
        tool_call_id: "bash".to_owned(),
        name: "bash".to_owned(),
        status: "success".to_owned(),
        summary: "done".to_owned(),
        diff: None,
    });
    let committed = vec![TranscriptItem {
        entry_id: "result".to_owned(),
        timestamp: String::new(),
        view: TranscriptViewItem::ToolResult {
            call_id: "bash".to_owned(),
            name: "bash".to_owned(),
            status: "success".to_owned(),
            summary: "done".to_owned(),
            detail: None,
            content_ref: None,
            diff: None,
            images: None,
        },
    }];
    assert!(
        app.transcript
            .append_committed("g", 1, 2, committed.clone())
    );
    app.clear_live_after_commit(&committed);

    assert!(app.live_tools.get("bash").is_none());
    assert_eq!(rendered_transcript(&app).matches("done").count(), 1);
}
