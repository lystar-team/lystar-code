use std::{
    cell::RefCell,
    env,
    fs::{self, File, OpenOptions},
    hint::black_box,
    io::{self, Write},
    path::PathBuf,
    rc::Rc,
    time::Instant,
};

use lystar_protocol::{ToolCall, TranscriptItem, TranscriptViewItem};
use lystar_tui::{
    app::{
        AppState, ComposerView, DetailOverlay, ListOverlay, OverlayItem, OverlayOrigin,
        OverlayState, ReadonlySessionView, SessionTreeNode, TranscriptView, WorkbenchOverlayView,
        composer_area, transcript_area,
    },
    editor::EditorState,
};
use ratatui::{
    Terminal,
    backend::{CrosstermBackend, TestBackend},
    layout::Rect,
};
use serde_json::json;

const TOOL_ROUNDS: usize = 10_000;
const BENCHMARK_ROUNDS: usize = 5;
const SIZES: [(u16, u16); 3] = [(80, 24), (120, 36), (200, 60)];
const SCENARIOS: [&str; 5] = [
    "readonly_open",
    "older_scroll",
    "search",
    "tree_open",
    "tree_filter",
];

struct WriterStats {
    bytes: usize,
    hash: u64,
}

#[derive(Clone)]
struct CountingWriter {
    stats: Rc<RefCell<WriterStats>>,
}

impl Write for CountingWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut stats = self.stats.borrow_mut();
        stats.bytes += bytes.len();
        for byte in bytes {
            stats.hash = stats.hash.wrapping_mul(16_777_619) ^ u64::from(*byte);
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct BenchmarkApp {
    app: AppState,
    visual: Terminal<TestBackend>,
    writer: Terminal<CrosstermBackend<CountingWriter>>,
    writer_stats: Rc<RefCell<WriterStats>>,
}

fn main() {
    let out = parse_output_path();
    fs::create_dir_all(out.parent().expect("benchmark output has a parent")).unwrap();
    File::create(&out).unwrap();

    for round in 1..=BENCHMARK_ROUNDS {
        for (columns, rows) in SIZES {
            for scenario in SCENARIOS {
                run_case(&out, round, columns, rows, scenario);
            }
        }
    }
}

fn parse_output_path() -> PathBuf {
    let args = env::args().collect::<Vec<_>>();
    args.windows(2)
        .find_map(|pair| (pair[0] == "--out").then(|| PathBuf::from(&pair[1])))
        .unwrap_or_else(|| PathBuf::from(".artifacts/rust-tui-b3-workbench/benchmark.jsonl"))
}

fn run_case(out: &PathBuf, round: usize, columns: u16, rows: u16, scenario: &str) {
    let mut benchmark = setup(columns, rows);
    let regroup_before = regroup_signature(&benchmark.app);
    let started = Instant::now();
    apply_scenario(&mut benchmark.app, scenario);
    let bytes = draw(&mut benchmark);
    let elapsed = started.elapsed().as_secs_f64() * 1_000.0;
    let rss = rss_bytes();
    let regroup_after = regroup_signature(&benchmark.app);

    assert_eq!(
        regroup_before, regroup_after,
        "workbench actions must not regroup active transcript"
    );
    let active = benchmark.app.transcript.diagnostics();
    let readonly = benchmark
        .app
        .readonly_view
        .as_ref()
        .expect("readonly window exists")
        .transcript
        .diagnostics();
    assert!(
        active.cached_rounds <= 400
            && active.cached_items <= 800
            && active.cached_utf8_bytes <= 4 * 1024 * 1024
    );
    assert!(
        readonly.cached_rounds <= 400
            && readonly.cached_items <= 800
            && readonly.cached_utf8_bytes <= 4 * 1024 * 1024
    );
    assert!(bytes > 0 && rss > 0);

    append(
        out,
        json!({
            "implementation": "rust-b3-workbench",
            "scenario": scenario,
            "columns": columns,
            "rows": rows,
            "round": round,
            "metric": "event_to_frame_ms",
            "eventToFrameP50Ms": elapsed,
            "eventToFrameP95Ms": elapsed,
            "eventToFrameP99Ms": elapsed,
            "eventToFrameMaxMs": elapsed,
            "frameP50Ms": elapsed,
            "frameP95Ms": elapsed,
            "frameP99Ms": elapsed,
            "frameMaxMs": elapsed,
            "bytesP50": bytes,
            "bytesP95": bytes,
            "bytesP99": bytes,
            "bytesMax": bytes,
            "bytesTotal": bytes,
            "rssP50Bytes": rss,
            "rssP95Bytes": rss,
            "rssP99Bytes": rss,
            "rssMaxBytes": rss,
            "activeToolRounds": TOOL_ROUNDS,
            "readonlyToolRounds": TOOL_ROUNDS,
            "activeCachedRounds": active.cached_rounds,
            "activeCachedItems": active.cached_items,
            "activeCachedUtf8Bytes": active.cached_utf8_bytes,
            "readonlyCachedRounds": readonly.cached_rounds,
            "readonlyCachedItems": readonly.cached_items,
            "readonlyCachedUtf8Bytes": readonly.cached_utf8_bytes,
            "transcriptRegroupBefore": regroup_before,
            "transcriptRegroupAfter": regroup_after,
        }),
    );
}

fn setup(columns: u16, rows: u16) -> BenchmarkApp {
    let mut app = AppState::default();
    app.editor = EditorState::default();
    app.transcript.replace_page(
        tool_items("active"),
        "b3-active-generation".to_owned(),
        1,
        Some("older-active".to_owned()),
    );
    let mut readonly = ReadonlySessionView {
        path: "/tmp/b3-readonly.jsonl".to_owned(),
        generation: 1,
        status: "已加载".to_owned(),
        ..ReadonlySessionView::default()
    };
    readonly.transcript.replace_page(
        tool_items("readonly"),
        "b3-readonly-generation".to_owned(),
        1,
        Some("older-readonly".to_owned()),
    );
    app.readonly_view = Some(readonly);
    app.tree = tree_nodes();

    let visual = Terminal::new(TestBackend::new(columns, rows)).unwrap();
    let writer_stats = Rc::new(RefCell::new(WriterStats { bytes: 0, hash: 0 }));
    let writer = Terminal::new(CrosstermBackend::new(CountingWriter {
        stats: Rc::clone(&writer_stats),
    }))
    .unwrap();
    let mut benchmark = BenchmarkApp {
        app,
        visual,
        writer,
        writer_stats,
    };
    benchmark
        .visual
        .resize(Rect::new(0, 0, columns, rows))
        .unwrap();
    benchmark
        .writer
        .resize(Rect::new(0, 0, columns, rows))
        .unwrap();
    for _ in 0..4 {
        black_box(draw(&mut benchmark));
    }
    benchmark.writer_stats.borrow_mut().bytes = 0;
    benchmark
}

fn apply_scenario(app: &mut AppState, scenario: &str) {
    match scenario {
        "readonly_open" => open_readonly(app),
        "older_scroll" => {
            app.readonly_view
                .as_mut()
                .unwrap()
                .transcript
                .scroll_by(-20);
            open_readonly(app);
        }
        "search" => {
            let view = app.readonly_view.as_mut().unwrap();
            view.search.open = true;
            view.search.query = "readonly 09999".to_owned();
            view.search.status = "已找到 1 条".to_owned();
            open_readonly(app);
        }
        "tree_open" => open_tree(app, String::new()),
        "tree_filter" => open_tree(app, "labeled user".to_owned()),
        _ => unreachable!("unknown scenario"),
    }
}

fn open_readonly(app: &mut AppState) {
    let view = app.readonly_view.as_ref().unwrap();
    let mut lines = vec![format!("只读  {}", view.path)];
    if view.search.open {
        lines.push(format!("搜索: {}", view.search.query));
        lines.push(view.search.status.clone());
    }
    lines.extend(view.transcript.rounds().iter().flat_map(|round| {
        let mut lines = vec![round.summary()];
        if round.expanded {
            lines.extend(round.detail_lines());
        }
        lines
    }));
    app.open_overlay(OverlayState::Detail(DetailOverlay {
        title: "会话只读".to_owned(),
        lines,
        scroll: 0,
        status: "只读".to_owned(),
        link: None,
        copy_text: None,
    }));
}

fn open_tree(app: &mut AppState, filter: String) {
    let items = app
        .tree
        .iter()
        .enumerate()
        .map(|(index, node)| OverlayItem {
            label: format!(
                "{}{} {}",
                "  ".repeat(node.depth),
                if node.is_leaf { "*" } else { "-" },
                node.label.as_deref().unwrap_or(&node.kind)
            ),
            detail: format!("{}  {}", node.timestamp, node.preview),
            action: format!("tree:{index}"),
        })
        .collect();
    app.open_overlay(OverlayState::List(ListOverlay {
        title: "分支树".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected: 0,
        filter,
        status: "Enter 跳转  s 摘要跳转  l 标签  v 只读  f 分叉  n/p 标签".to_owned(),
    }));
}

fn draw(benchmark: &mut BenchmarkApp) -> usize {
    let area = benchmark.visual.size().unwrap();
    let full = Rect::new(0, 0, area.width, area.height);
    let composer = composer_area(&benchmark.app, full);
    benchmark.app.prepare_composer(composer);
    benchmark
        .visual
        .draw(|frame| {
            let area = frame.area();
            frame.render_widget(
                TranscriptView::new(&benchmark.app),
                transcript_area(&benchmark.app, area),
            );
            frame.render_widget(
                ComposerView::new(&benchmark.app),
                composer_area(&benchmark.app, area),
            );
            frame.render_widget(WorkbenchOverlayView::new(&benchmark.app), area);
        })
        .unwrap();
    black_box(benchmark.visual.backend().buffer().content().len());

    let before = benchmark.writer_stats.borrow().bytes;
    benchmark
        .writer
        .draw(|frame| {
            let area = frame.area();
            frame.render_widget(
                TranscriptView::new(&benchmark.app),
                transcript_area(&benchmark.app, area),
            );
            frame.render_widget(
                ComposerView::new(&benchmark.app),
                composer_area(&benchmark.app, area),
            );
            frame.render_widget(WorkbenchOverlayView::new(&benchmark.app), area);
        })
        .unwrap();
    let stats = benchmark.writer_stats.borrow();
    black_box(stats.hash);
    stats.bytes - before
}

fn tool_items(prefix: &str) -> Vec<TranscriptItem> {
    let mut items = Vec::with_capacity(TOOL_ROUNDS * 2);
    for index in 0..TOOL_ROUNDS {
        let id = format!("{prefix}-call-{index:05}");
        let name = ["read", "grep", "apply_patch", "bash", "image_gen"][index % 5].to_owned();
        items.push(TranscriptItem {
            entry_id: format!("{prefix}-tool-call-{index:05}"),
            timestamp: "2026-08-16T00:00:00Z".to_owned(),
            view: TranscriptViewItem::ToolCall {
                calls: vec![ToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    summary: format!("src/{prefix}-fixture-{index:05}.ts"),
                    href: None,
                }],
            },
        });
        items.push(TranscriptItem {
            entry_id: format!("{prefix}-tool-result-{index:05}"),
            timestamp: "2026-08-16T00:00:01Z".to_owned(),
            view: TranscriptViewItem::ToolResult {
                call_id: id,
                name,
                status: if index.is_multiple_of(19) {
                    "error".to_owned()
                } else {
                    "success".to_owned()
                },
                summary: format!("{prefix} result {index:05} 中文摘要"),
                detail: index
                    .is_multiple_of(37)
                    .then(|| "diff --git a/src/fixture.ts".to_owned()),
                content_ref: index
                    .is_multiple_of(43)
                    .then(|| format!("content_ref://tool/{prefix}/{index:05}")),
            },
        });
    }
    items
}

fn tree_nodes() -> Vec<SessionTreeNode> {
    vec![
        SessionTreeNode {
            id: "root-user".to_owned(),
            parent_id: None,
            kind: "user".to_owned(),
            label: Some("labeled user".to_owned()),
            timestamp: "2026-08-16T00:00:00Z".to_owned(),
            preview: "user prompt".to_owned(),
            is_leaf: false,
            depth: 0,
        },
        SessionTreeNode {
            id: "assistant".to_owned(),
            parent_id: Some("root-user".to_owned()),
            kind: "assistant".to_owned(),
            label: None,
            timestamp: "2026-08-16T00:00:01Z".to_owned(),
            preview: "assistant response".to_owned(),
            is_leaf: false,
            depth: 1,
        },
        SessionTreeNode {
            id: "tool".to_owned(),
            parent_id: Some("assistant".to_owned()),
            kind: "tool".to_owned(),
            label: None,
            timestamp: "2026-08-16T00:00:02Z".to_owned(),
            preview: "Tool read".to_owned(),
            is_leaf: true,
            depth: 2,
        },
    ]
}

fn regroup_signature(app: &AppState) -> String {
    let first = app
        .transcript
        .rounds()
        .front()
        .and_then(|round| round.entry_ids.first())
        .map_or("", String::as_str);
    let last = app
        .transcript
        .rounds()
        .back()
        .and_then(|round| round.entry_ids.last())
        .map_or("", String::as_str);
    format!("{}:{first}:{last}", app.transcript.cached_rounds())
}

fn rss_bytes() -> usize {
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status.lines().find_map(|line| {
                line.strip_prefix("VmRSS:")?
                    .split_whitespace()
                    .next()?
                    .parse::<usize>()
                    .ok()
            })
        })
        .map_or(0, |kilobytes| kilobytes * 1024)
}

fn append(path: &PathBuf, value: serde_json::Value) {
    writeln!(
        OpenOptions::new().append(true).open(path).unwrap(),
        "{value}"
    )
    .unwrap();
}
