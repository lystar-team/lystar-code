use lystar_protocol::SessionProgress;
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

fn retry(
    status: &str,
    kind: &str,
    attempt: Option<u64>,
    max_attempts: Option<u64>,
    delay_ms: Option<u64>,
    error: Option<&str>,
) -> SessionProgress {
    SessionProgress::Retry {
        status: status.to_owned(),
        kind: kind.to_owned(),
        attempt,
        max_attempts,
        delay_ms,
        error: error.map(str::to_owned),
    }
}

#[test]
fn model_retry_replaces_failed_stream_and_reports_attempt() {
    let mut app = AppState {
        assistant_stream: "失败回答".to_owned(),
        thinking_stream: "失败思考".to_owned(),
        ..AppState::default()
    };
    app.apply_progress(retry(
        "waiting",
        "model",
        Some(2),
        Some(3),
        Some(1500),
        Some("服务暂时不可用"),
    ));

    assert!(app.assistant_stream.is_empty());
    assert!(app.thinking_stream.is_empty());
    assert_eq!(
        app.retry.as_ref().map(|value| value.status),
        Some(RetryStatus::Waiting)
    );
    let rendered = rendered_transcript(&app);
    assert!(rendered.contains("模型请求重试中"), "{rendered:?}");
    assert!(rendered.contains("第2/3次"), "{rendered:?}");
    assert!(rendered.contains("等待1.5s"), "{rendered:?}");
    assert!(rendered.contains("服务暂时不可用"), "{rendered:?}");
}

#[test]
fn new_assistant_stream_and_completed_retry_clear_retry_state() {
    let mut app = AppState::default();
    app.apply_progress(retry(
        "waiting",
        "model",
        Some(1),
        Some(2),
        Some(100),
        Some("retry"),
    ));
    app.apply_progress(SessionProgress::AssistantDelta {
        text: "新回答".to_owned(),
    });
    assert!(app.retry.is_none());
    assert_eq!(app.assistant_stream, "新回答");

    app.apply_progress(retry(
        "running",
        "branch_summary",
        Some(1),
        Some(2),
        None,
        None,
    ));
    app.apply_progress(retry("completed", "summarization", None, None, None, None));
    assert!(app.retry.is_none());
}

#[test]
fn retry_transitions_preserve_attempt_but_not_elapsed_delay() {
    let mut app = AppState::default();
    app.apply_progress(retry(
        "waiting",
        "summarization",
        Some(2),
        Some(4),
        Some(2000),
        Some("摘要请求失败"),
    ));
    app.apply_progress(retry("running", "compaction", None, None, None, None));

    let rendered = rendered_transcript(&app);
    assert!(rendered.contains("正在重试上下文压缩"), "{rendered:?}");
    assert!(rendered.contains("第2/4次"), "{rendered:?}");
    assert!(!rendered.contains("等待2.0s"), "{rendered:?}");

    app.apply_progress(retry(
        "failed",
        "model",
        Some(4),
        None,
        None,
        Some("最终失败"),
    ));
    let rendered = rendered_transcript(&app);
    assert!(rendered.contains("模型请求重试失败"), "{rendered:?}");
    assert!(rendered.contains("第4/4次"), "{rendered:?}");
    assert!(rendered.contains("最终失败"), "{rendered:?}");
}

#[test]
fn session_cleanup_removes_retry_state() {
    let mut app = AppState::default();
    app.apply_progress(retry(
        "running",
        "branch_summary",
        Some(1),
        Some(3),
        None,
        None,
    ));
    app.clear_connection_state("断开");
    assert!(app.retry.is_none());

    app.apply_progress(retry("waiting", "model", Some(1), Some(3), Some(500), None));
    app.clear_for_reload("重载");
    assert!(app.retry.is_none());
}
