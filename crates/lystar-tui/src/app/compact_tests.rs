use lystar_protocol::{SessionProgress, TranscriptItem, TranscriptViewItem};
use ratatui::{buffer::Buffer, layout::Rect, widgets::Widget};

use super::*;

fn rendered_transcript(app: &AppState) -> String {
    let area = Rect::new(0, 0, 80, 12);
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
fn compaction_preserves_live_conversation_and_reports_reason() {
    let mut app = AppState::default();
    app.apply_progress(SessionProgress::AssistantDelta {
        text: "压缩前回答".to_owned(),
    });
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "read-1".to_owned(),
        name: "read".to_owned(),
        summary: Some("src/lib.rs".to_owned()),
        diff: None,
    });
    app.apply_progress(SessionProgress::Compaction {
        status: "running".to_owned(),
        reason: "manual".to_owned(),
        error: None,
    });

    assert_eq!(app.assistant_stream, "压缩前回答");
    assert!(app.live_tools.get("read-1").is_some());
    assert_eq!(
        app.compaction.as_ref().map(|value| value.status),
        Some(CompactionStatus::Running)
    );
    let rendered = rendered_transcript(&app);
    assert!(rendered.contains("正在压缩上下文手动"), "{rendered:?}");
}

#[test]
fn compaction_terminal_states_remain_visible_until_replaced() {
    for (status, expected, text) in [
        ("completed", CompactionStatus::Completed, "上下文压缩完成"),
        ("cancelled", CompactionStatus::Cancelled, "上下文压缩已取消"),
        ("failed", CompactionStatus::Failed, "上下文压缩失败"),
        (
            "waiting_retry",
            CompactionStatus::WaitingRetry,
            "上下文压缩失败，等待重试",
        ),
    ] {
        let mut app = AppState::default();
        app.apply_progress(SessionProgress::Compaction {
            status: status.to_owned(),
            reason: "overflow".to_owned(),
            error: (status == "failed").then(|| "摘要服务不可用".to_owned()),
        });
        assert_eq!(
            app.compaction.as_ref().map(|value| value.status),
            Some(expected)
        );
        let rendered = rendered_transcript(&app);
        assert!(rendered.contains(&text.replace(' ', "")), "{rendered:?}");
        if status == "failed" {
            assert!(rendered.contains("摘要服务不可用"), "{rendered:?}");
        }
    }
}

#[test]
fn committed_summary_and_session_cleanup_remove_live_compaction() {
    let mut app = AppState::default();
    app.apply_progress(SessionProgress::Compaction {
        status: "completed".to_owned(),
        reason: "threshold".to_owned(),
        error: None,
    });
    app.clear_live_after_commit(&[TranscriptItem {
        entry_id: "compact-1".to_owned(),
        timestamp: String::new(),
        view: TranscriptViewItem::Summary {
            title: "上下文压缩".to_owned(),
            text: "摘要".to_owned(),
        },
    }]);
    assert!(app.compaction.is_none());

    app.apply_progress(SessionProgress::Compaction {
        status: "running".to_owned(),
        reason: "manual".to_owned(),
        error: None,
    });
    app.clear_connection_state("断开");
    assert!(app.compaction.is_none());

    app.apply_progress(SessionProgress::Compaction {
        status: "running".to_owned(),
        reason: "manual".to_owned(),
        error: None,
    });
    app.clear_for_reload("重载");
    assert!(app.compaction.is_none());
}
