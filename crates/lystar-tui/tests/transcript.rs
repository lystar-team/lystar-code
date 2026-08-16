use lystar_protocol::{TranscriptItem, TranscriptViewItem};
use lystar_tui::app::{
    AppState, ComposerView, ROUND_CACHE_LIMIT, TranscriptView, composer_area, transcript_area,
};
use ratatui::{Terminal, backend::TestBackend};

fn item(id: usize) -> TranscriptItem {
    TranscriptItem {
        entry_id: format!("entry-{id}"),
        timestamp: "2026-08-16T00:00:00Z".to_owned(),
        view: TranscriptViewItem::User {
            text: format!("中文 {id}"),
        },
    }
}

#[test]
fn keeps_a_bounded_round_window_and_status_at_small_sizes() {
    let mut app = AppState::default();
    app.transcript.replace_page(
        (0..10_000).map(item).collect(),
        "generation-1".to_owned(),
        1,
        Some("older".to_owned()),
    );
    assert_eq!(app.transcript.cached_rounds(), ROUND_CACHE_LIMIT);
    assert!(app.transcript.diagnostics().cached_items <= 800);
    app.transcript.scroll_by(-10_000);
    assert!(app.transcript.needs_previous_page());

    for (width, height) in [(80, 8), (80, 24), (120, 36), (200, 60)] {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                let area = frame.area();
                frame.render_widget(TranscriptView::new(&app), transcript_area(&app, area));
                frame.render_widget(ComposerView::new(&app), composer_area(&app, area));
            })
            .unwrap();
        let output = terminal.backend().buffer().content();
        assert!(output.iter().any(|cell| cell.symbol() == "未"));
        assert!(output.iter().any(|cell| cell.symbol() == "E"));
    }
}
