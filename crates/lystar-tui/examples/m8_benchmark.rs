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
        AppState, ComposerView, ITEM_CACHE_LIMIT, ListOverlay, OverlayItem, OverlayOrigin,
        OverlayState, ROUND_CACHE_LIMIT, TranscriptView, UTF8_CACHE_LIMIT, WorkbenchOverlayView,
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
            run_case(&out, round, columns, rows, "input300", 300, "x");
            run_case(
                &out,
                round,
                columns,
                rows,
                "paste5000",
                1,
                &"p".repeat(5_000),
            );
            run_palette_case(&out, round, columns, rows);
        }
    }
}

fn parse_output_path() -> PathBuf {
    let args = env::args().collect::<Vec<_>>();
    args.windows(2)
        .find_map(|pair| (pair[0] == "--out").then(|| PathBuf::from(&pair[1])))
        .unwrap_or_else(|| PathBuf::from(".artifacts/rust-tui-m8/benchmark.jsonl"))
}

fn run_case(
    out: &PathBuf,
    round: usize,
    columns: u16,
    rows: u16,
    scenario: &str,
    events: usize,
    input: &str,
) {
    let mut benchmark = setup(columns, rows);
    let regroup_before = regroup_signature(&benchmark.app);
    let mut event_to_frame_ms = Vec::with_capacity(events);
    let mut write_bytes = Vec::with_capacity(events);
    let mut rss = Vec::with_capacity(events);

    for event in 0..events {
        let inserted = if scenario == "input300" { "x" } else { input };
        let started = Instant::now();
        benchmark.app.editor.insert(inserted);
        write_bytes.push(draw(&mut benchmark));
        event_to_frame_ms.push(started.elapsed().as_secs_f64() * 1_000.0);
        rss.push(rss_bytes());
        if scenario == "input300" {
            assert_eq!(event + 1, benchmark.app.editor.cursor_line_column().1);
        }
    }

    let regroup_after = regroup_signature(&benchmark.app);
    assert_eq!(
        regroup_before, regroup_after,
        "editor input must not regroup the transcript"
    );
    let diagnostics = benchmark.app.transcript.diagnostics();
    assert!(diagnostics.cached_rounds <= ROUND_CACHE_LIMIT);
    assert!(diagnostics.cached_items <= ITEM_CACHE_LIMIT);
    assert!(diagnostics.cached_utf8_bytes <= UTF8_CACHE_LIMIT);
    assert_eq!(events, event_to_frame_ms.len());
    assert_eq!(events, write_bytes.len());
    assert_eq!(events, rss.len());
    assert!(write_bytes.iter().all(|value| *value > 0));
    assert!(rss.iter().all(|value| *value > 0));

    let characters = if scenario == "input300" {
        events
    } else {
        input.chars().count()
    };
    if scenario == "paste5000" {
        assert_eq!(events, 1);
        assert_eq!(characters, 5_000);
    }
    append(
        out,
        json!({
            "implementation": "rust-m8",
            "scenario": scenario,
            "columns": columns,
            "rows": rows,
            "round": round,
            "metric": "event_to_frame_ms",
            "events": events,
            "characters": characters,
            "frames": event_to_frame_ms.len(),
            "eventToFrameP50Ms": percentile(&event_to_frame_ms, 0.50),
            "eventToFrameP95Ms": percentile(&event_to_frame_ms, 0.95),
            "eventToFrameP99Ms": percentile(&event_to_frame_ms, 0.99),
            "eventToFrameMaxMs": maximum(&event_to_frame_ms),
            "frameP50Ms": percentile(&event_to_frame_ms, 0.50),
            "frameP95Ms": percentile(&event_to_frame_ms, 0.95),
            "frameP99Ms": percentile(&event_to_frame_ms, 0.99),
            "frameMaxMs": maximum(&event_to_frame_ms),
            "bytesP50": percentile_usize(&write_bytes, 0.50),
            "bytesP95": percentile_usize(&write_bytes, 0.95),
            "bytesP99": percentile_usize(&write_bytes, 0.99),
            "bytesMax": *write_bytes.iter().max().unwrap(),
            "bytesTotal": write_bytes.iter().sum::<usize>(),
            "rssP50Bytes": percentile_usize(&rss, 0.50),
            "rssP95Bytes": percentile_usize(&rss, 0.95),
            "rssP99Bytes": percentile_usize(&rss, 0.99),
            "rssMaxBytes": *rss.iter().max().unwrap(),
            "toolRounds": TOOL_ROUNDS,
            "cachedRounds": diagnostics.cached_rounds,
            "cachedItems": diagnostics.cached_items,
            "cachedUtf8Bytes": diagnostics.cached_utf8_bytes,
            "transcriptRegroupBefore": regroup_before,
            "transcriptRegroupAfter": regroup_after,
        }),
    );
}

fn run_palette_case(out: &PathBuf, round: usize, columns: u16, rows: u16) {
    let mut benchmark = setup(columns, rows);
    let regroup_before = regroup_signature(&benchmark.app);
    benchmark.app.open_overlay(OverlayState::List(ListOverlay {
        title: "命令面板".to_owned(),
        origin: OverlayOrigin::User,
        items: vec![
            OverlayItem {
                label: "/help".to_owned(),
                detail: "帮助".to_owned(),
                action: "open:help".to_owned(),
            },
            OverlayItem {
                label: "/about".to_owned(),
                detail: "关于".to_owned(),
                action: "open:about".to_owned(),
            },
            OverlayItem {
                label: "/doctor".to_owned(),
                detail: "诊断".to_owned(),
                action: "open:doctor".to_owned(),
            },
        ],
        selected: 0,
        filter: String::new(),
        status: "输入筛选，Enter 打开".to_owned(),
    }));
    let started = Instant::now();
    let bytes = draw(&mut benchmark);
    let elapsed = started.elapsed().as_secs_f64() * 1_000.0;
    let rss = rss_bytes();
    benchmark.app.close_overlay();
    assert_eq!(regroup_before, regroup_signature(&benchmark.app));
    append(
        out,
        json!({
            "implementation":"rust-m8", "scenario":"palette_open", "columns":columns, "rows":rows,
            "round":round, "metric":"open_to_frame_ms", "events":1, "characters":0, "frames":1,
            "eventToFrameP50Ms":elapsed, "eventToFrameP95Ms":elapsed, "eventToFrameP99Ms":elapsed, "eventToFrameMaxMs":elapsed,
            "frameP50Ms":elapsed, "frameP95Ms":elapsed, "frameP99Ms":elapsed, "frameMaxMs":elapsed,
            "bytesP50":bytes, "bytesP95":bytes, "bytesP99":bytes, "bytesMax":bytes, "bytesTotal":bytes,
            "rssP50Bytes":rss, "rssP95Bytes":rss, "rssP99Bytes":rss, "rssMaxBytes":rss,
            "toolRounds":TOOL_ROUNDS, "cachedRounds":benchmark.app.transcript.diagnostics().cached_rounds,
            "cachedItems":benchmark.app.transcript.diagnostics().cached_items,
            "cachedUtf8Bytes":benchmark.app.transcript.diagnostics().cached_utf8_bytes,
            "transcriptRegroupBefore":regroup_before, "transcriptRegroupAfter":regroup_signature(&benchmark.app),
        }),
    );
}

fn setup(columns: u16, rows: u16) -> BenchmarkApp {
    let mut app = AppState::default();
    app.editor = EditorState::default();
    app.transcript.replace_page(
        tool_items(),
        "m8-benchmark-generation".to_owned(),
        1,
        Some("older".to_owned()),
    );
    let diagnostics = app.transcript.diagnostics();
    assert_eq!(diagnostics.cached_rounds, ROUND_CACHE_LIMIT);
    assert_eq!(diagnostics.cached_items, ITEM_CACHE_LIMIT);
    assert!(diagnostics.cached_utf8_bytes <= UTF8_CACHE_LIMIT);

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
        let bytes = draw(&mut benchmark);
        black_box(bytes);
    }
    benchmark.writer_stats.borrow_mut().bytes = 0;
    benchmark
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

fn tool_items() -> Vec<TranscriptItem> {
    let mut items = Vec::with_capacity(TOOL_ROUNDS * 2);
    for index in 0..TOOL_ROUNDS {
        let id = format!("call-{index:05}");
        let name = ["read", "grep", "apply_patch", "bash", "image_gen"][index % 5].to_owned();
        items.push(TranscriptItem {
            entry_id: format!("tool-call-{index:05}"),
            timestamp: "2026-08-16T00:00:00Z".to_owned(),
            view: TranscriptViewItem::ToolCall {
                calls: vec![ToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    summary: format!("src/fixture-{index:05}.ts"),
                    href: None,
                }],
            },
        });
        items.push(TranscriptItem {
            entry_id: format!("tool-result-{index:05}"),
            timestamp: "2026-08-16T00:00:01Z".to_owned(),
            view: TranscriptViewItem::ToolResult {
                call_id: id,
                name,
                status: if index.is_multiple_of(19) {
                    "error".to_owned()
                } else {
                    "success".to_owned()
                },
                summary: format!("result {index:05} 中文摘要"),
                detail: index
                    .is_multiple_of(37)
                    .then(|| "diff --git a/src/fixture.ts".to_owned()),
                content_ref: index
                    .is_multiple_of(43)
                    .then(|| format!("content_ref://tool/{index:05}")),
                images: None,
            },
        });
    }
    items
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

fn percentile(values: &[f64], quantile: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[(sorted.len() as f64 * quantile).ceil() as usize - 1]
}

fn percentile_usize(values: &[usize], quantile: f64) -> usize {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    sorted[(sorted.len() as f64 * quantile).ceil() as usize - 1]
}

fn maximum(values: &[f64]) -> f64 {
    values.iter().copied().fold(0.0, f64::max)
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
