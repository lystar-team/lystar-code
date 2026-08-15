#[path = "../src/app.rs"]
#[allow(dead_code)]
mod app;

use app::{TranscriptItem, TranscriptView, TranscriptWindow};
use ratatui::{Terminal, backend::TestBackend};

#[test]
fn keeps_a_bounded_tool_window_and_composer_at_small_sizes() {
    let mut transcript = TranscriptWindow::default();
    transcript.extend_page((0..10_000).map(|id| TranscriptItem {
        id,
        text: format!("中文 {id} क्षि \x1b]8;;https://example.test\x07link\x1b]8;;\x07"),
    }));
    assert_eq!(transcript.cached_items(), 400);
    transcript.scroll_by(10_000);

    let backend = TestBackend::new(80, 8);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| {
            frame.render_stateful_widget(TranscriptView::new(&transcript), frame.area(), &mut ())
        })
        .unwrap();
    let output = terminal.backend().buffer().content();
    assert!(output.iter().any(|cell| cell.symbol() == "中"));
    assert_eq!(
        terminal.backend().buffer().cell((1, 6)).unwrap().symbol(),
        ">"
    );

    terminal
        .resize(ratatui::layout::Rect::new(0, 0, 120, 36))
        .unwrap();
    terminal
        .draw(|frame| {
            frame.render_stateful_widget(TranscriptView::new(&transcript), frame.area(), &mut ())
        })
        .unwrap();
}
