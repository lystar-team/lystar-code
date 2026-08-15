use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    env,
    fs::{self, File, OpenOptions},
    hint::black_box,
    io::{self, Write},
    path::PathBuf,
    rc::Rc,
    thread,
    time::{Duration, Instant},
};

use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
    widgets::Widget,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use unicode_width::UnicodeWidthStr;

struct WriterStats {
    bytes: usize,
    hash: u64,
}

#[derive(Clone)]
struct CountingWriter {
    stats: Rc<RefCell<WriterStats>>,
}

impl Write for CountingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut stats = self.stats.borrow_mut();
        stats.bytes += buf.len();
        for byte in buf {
            stats.hash = stats.hash.wrapping_mul(16_777_619) ^ u64::from(*byte);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
struct ToolCall {
    args: Value,
    id: String,
    name: String,
    tool_id: String,
}

#[derive(Clone)]
struct ToolResult {
    content_ref: Option<String>,
    diff: Option<String>,
    error: Option<String>,
    id: String,
    image_summary: Option<String>,
    output: String,
    status: String,
    tool_id: String,
}

#[derive(Clone)]
struct ToolRound {
    call: ToolCall,
    result: ToolResult,
}

struct ToolPage {
    index: usize,
    rounds: Vec<ToolRound>,
}

struct ToolPageCache {
    page_size: usize,
    max_pages: usize,
    pages: VecDeque<ToolPage>,
    peak_cached_rounds: usize,
}

impl ToolPageCache {
    fn new(page_size: usize, max_pages: usize) -> Self {
        Self {
            page_size,
            max_pages,
            pages: VecDeque::new(),
            peak_cached_rounds: 0,
        }
    }

    fn window(
        &mut self,
        start: usize,
        count: usize,
        tool_rounds: usize,
        streaming_updates: &BTreeMap<usize, String>,
    ) -> Vec<ToolRound> {
        let end = tool_rounds.min(start.saturating_add(count));
        (start..end)
            .map(|index| {
                let mut round = self.round(index);
                if let Some(update) = streaming_updates.get(&index) {
                    apply_streaming_update(&mut round, update);
                }
                round
            })
            .collect()
    }

    fn round(&mut self, index: usize) -> ToolRound {
        let page_index = index / self.page_size;
        if let Some(page) = self.pages.iter().find(|page| page.index == page_index) {
            return page.rounds[index % self.page_size].clone();
        }
        let start = page_index * self.page_size;
        let rounds = (start..start + self.page_size)
            .map(create_tool_round)
            .collect::<Vec<_>>();
        self.pages.push_back(ToolPage {
            index: page_index,
            rounds,
        });
        while self.pages.len() > self.max_pages {
            self.pages.pop_front();
        }
        self.peak_cached_rounds = self
            .peak_cached_rounds
            .max(self.pages.iter().map(|page| page.rounds.len()).sum());
        self.pages
            .back()
            .expect("new tool page is available")
            .rounds[index % self.page_size]
            .clone()
    }
}

struct BenchApp<'a> {
    visible_rounds: &'a [ToolRound],
    editor: &'a str,
}

impl Widget for BenchApp<'_> {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        let viewport_lines = area.height.saturating_sub(1);
        black_box(
            self.visible_rounds
                .iter()
                .map(|round| round.call.name.len() + round.result.output.len())
                .sum::<usize>(),
        );
        for (index, round) in self.visible_rounds.iter().enumerate() {
            let call_row = index.saturating_mul(2);
            if call_row >= usize::from(viewport_lines) {
                break;
            }
            buffer.set_string(
                area.x,
                area.y + call_row as u16,
                truncate(
                    &format!("toolCall {} {}", round.call.name, round.call.args),
                    usize::from(area.width),
                ),
                Style::default().fg(Color::White),
            );
            let result_row = call_row + 1;
            if result_row < usize::from(viewport_lines) {
                let result = &round.result;
                let detail = result
                    .error
                    .as_ref()
                    .or(result.diff.as_ref())
                    .or(result.image_summary.as_ref())
                    .or(result.content_ref.as_ref())
                    .unwrap_or(&result.output);
                buffer.set_string(
                    area.x,
                    area.y + result_row as u16,
                    truncate(
                        &format!("toolResult {} {detail}", result.status),
                        usize::from(area.width),
                    ),
                    Style::default().fg(Color::White),
                );
            }
        }
        buffer.set_string(
            area.x,
            area.y + viewport_lines,
            truncate(self.editor, usize::from(area.width)),
            Style::default().fg(Color::Cyan),
        );
    }
}

fn truncate(value: &str, width: usize) -> String {
    let mut output = String::new();
    let mut used = 0;
    for grapheme in unicode_segmentation::UnicodeSegmentation::graphemes(value, true) {
        let next = UnicodeWidthStr::width(grapheme);
        if used + next > width {
            break;
        }
        output.push_str(grapheme);
        used += next;
    }
    output
}

fn percentile(samples: &mut [f64], q: f64) -> f64 {
    samples.sort_by(f64::total_cmp);
    let index = (samples.len() as f64 * q).ceil() as usize;
    samples[index.saturating_sub(1).min(samples.len().saturating_sub(1))]
}

fn rss_bytes() -> u64 {
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status.lines().find_map(|line| {
                line.strip_prefix("VmRSS:")?
                    .split_whitespace()
                    .next()?
                    .parse::<u64>()
                    .ok()
            })
        })
        .map_or(0, |kilobytes| kilobytes * 1024)
}

fn scenario_config() -> Value {
    serde_json::from_str(&fs::read_to_string("benchmarks/tui-spike-scenarios.json").unwrap())
        .unwrap()
}

fn string_field<'a>(value: &'a Value, name: &str) -> &'a str {
    value[name].as_str().unwrap()
}

fn number_field(value: &Value, name: &str) -> usize {
    value[name].as_u64().unwrap() as usize
}

fn visible_tool_rounds(rows: u16, prefetch_viewports: usize, tool_rounds: usize) -> usize {
    let viewport_lines = usize::from(rows.saturating_sub(1)).max(1);
    tool_rounds.min(viewport_lines.div_ceil(2) * (1 + prefetch_viewports))
}

fn mutation(kind: &str, index: usize, character_count: usize) -> String {
    let prefix = format!("{kind}-{index}:");
    let mut output = prefix.chars().take(character_count).collect::<String>();
    while output.chars().count() < character_count {
        output.push('x');
    }
    output
}

fn suffix(index: usize) -> String {
    format!("{index:05}")
}

fn create_tool_round(index: usize) -> ToolRound {
    let suffix = suffix(index);
    let tool_id = format!("tool-{suffix}");
    let name = ["read", "grep", "apply_patch", "image_gen", "bash"][index % 5].to_owned();
    let output = if index.is_multiple_of(127) {
        format!("long output {suffix} {}", "x".repeat(4096))
    } else {
        format!("tool result {suffix} Chinese 内容")
    };
    ToolRound {
        call: ToolCall {
            args: json!({
                "path": format!("src/fixture-{suffix}.ts"),
                "query": format!("needle-{}", index % 97),
                "round": index,
            }),
            id: format!("tool-call-{suffix}"),
            name,
            tool_id: tool_id.clone(),
        },
        result: ToolResult {
            content_ref: index
                .is_multiple_of(43)
                .then(|| format!("content_ref://tool-{suffix}/output")),
            diff: index.is_multiple_of(37).then(|| {
                format!("diff --git a/src/fixture-{suffix}.ts b/src/fixture-{suffix}.ts\n+updated {suffix}")
            }),
            error: index
                .is_multiple_of(19)
                .then(|| format!("exit 1: simulated tool failure {suffix}")),
            id: format!("tool-result-{suffix}"),
            image_summary: index
                .is_multiple_of(41)
                .then(|| format!("image 1024x1024 generated for {suffix}")),
            output,
            status: if index.is_multiple_of(19) {
                "error".to_owned()
            } else {
                "success".to_owned()
            },
            tool_id,
        },
    }
}

fn apply_streaming_update(round: &mut ToolRound, update: &str) {
    round.result.status = "streaming".to_owned();
    round.result.output = format!("{}\n{update}", round.result.output);
}

fn workload_hash(
    editor: &str,
    tool_rounds: usize,
    streaming_updates: &BTreeMap<usize, String>,
    scroll_lines: usize,
    rows: u16,
    columns: u16,
) -> String {
    let height = usize::from(rows.saturating_sub(1)).max(1).div_ceil(2);
    let start = scroll_lines / 2;
    let transcript = (0..tool_rounds)
        .map(|index| {
            let mut round = create_tool_round(index);
            if let Some(update) = streaming_updates.get(&index) {
                apply_streaming_update(&mut round, update);
            }
            json!({
                "call": {
                    "args": round.call.args,
                    "id": round.call.id,
                    "name": round.call.name,
                    "toolId": round.call.tool_id,
                },
                "result": {
                    "contentRef": round.result.content_ref,
                    "diff": round.result.diff,
                    "error": round.result.error,
                    "id": round.result.id,
                    "imageSummary": round.result.image_summary,
                    "output": round.result.output,
                    "status": round.result.status,
                    "toolId": round.result.tool_id,
                },
            })
        })
        .collect::<Vec<_>>();
    let state = json!({
        "editor": editor,
        "size": { "columns": columns, "rows": rows },
        "toolRounds": transcript,
        "viewport": { "end": tool_rounds.min(start + height), "height": height, "start": start },
    });
    format!("{:x}", Sha256::digest(serde_json::to_vec(&state).unwrap()))
}

fn draw(
    terminal: &mut Terminal<CrosstermBackend<CountingWriter>>,
    page_cache: &mut ToolPageCache,
    tool_rounds: usize,
    streaming_updates: &BTreeMap<usize, String>,
    editor: &str,
    scroll_lines: usize,
    prefetch_viewports: usize,
) {
    let rows = terminal.size().unwrap().height;
    let start = scroll_lines / 2;
    let visible = page_cache.window(
        start,
        visible_tool_rounds(rows, prefetch_viewports, tool_rounds),
        tool_rounds,
        streaming_updates,
    );
    terminal
        .draw(|frame| {
            frame.render_widget(
                BenchApp {
                    visible_rounds: &visible,
                    editor,
                },
                frame.area(),
            )
        })
        .unwrap();
}

fn hold_rss(config: &Value, hold_ms: u64) {
    let tool_rounds = number_field(config, "toolRounds");
    let page_size = number_field(config, "toolPageSize");
    let page_cache_pages = number_field(config, "toolPageCachePages");
    let prefetch_viewports = number_field(config, "prefetchViewports");
    let stats = Rc::new(RefCell::new(WriterStats { bytes: 0, hash: 0 }));
    let backend = CrosstermBackend::new(CountingWriter {
        stats: Rc::clone(&stats),
    });
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.resize(Rect::new(0, 0, 120, 36)).unwrap();
    let mut page_cache = ToolPageCache::new(page_size, page_cache_pages);
    let scroll_lines = tool_rounds * 2 - 35;
    let streaming_updates = BTreeMap::new();
    for _ in 0..8 {
        draw(
            &mut terminal,
            &mut page_cache,
            tool_rounds,
            &streaming_updates,
            "> ",
            scroll_lines,
            prefetch_viewports,
        );
    }
    black_box(stats.borrow().hash);
    println!("READY");
    thread::sleep(Duration::from_millis(hold_ms));
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let config = scenario_config();
    assert_eq!(number_field(&config, "toolRounds"), 10_000);
    if let Some(index) = args.iter().position(|value| value == "--rss-hold-ms") {
        hold_rss(&config, args[index + 1].parse().unwrap());
        return;
    }
    let out = args
        .iter()
        .position(|value| value == "--out")
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".artifacts/rust-tui-spike/benchmark-rust.jsonl"));
    fs::create_dir_all(out.parent().unwrap()).unwrap();
    File::create(&out).unwrap();
    let smoke = args.iter().any(|value| value == "--smoke");
    let rounds = if smoke {
        1
    } else {
        config["rounds"].as_u64().unwrap()
    };
    let sizes = config["sizes"].as_array().unwrap();
    let scenarios = config["scenarios"].as_array().unwrap();
    let tool_rounds = number_field(&config, "toolRounds");
    let page_size = number_field(&config, "toolPageSize");
    let page_cache_pages = number_field(&config, "toolPageCachePages");
    let prefetch_viewports = number_field(&config, "prefetchViewports");
    let scenario_timeout_ms = env::var("RUST_TUI_SPIKE_SCENARIO_TIMEOUT_MS")
        .ok()
        .map(|value| value.parse::<u64>().unwrap())
        .unwrap_or(120_000);

    for round in 1..=rounds {
        for size in sizes.iter().take(if smoke { 1 } else { sizes.len() }) {
            let columns = size[0].as_u64().unwrap() as u16;
            let rows = size[1].as_u64().unwrap() as u16;
            for scenario in scenarios {
                let started = Instant::now();
                let name = string_field(scenario, "name");
                let kind = string_field(scenario, "kind");
                let events = number_field(scenario, "events");
                let characters_per_event = number_field(scenario, "charactersPerEvent");
                let items_per_event = number_field(scenario, "itemsPerEvent");
                let scroll_lines_per_event = number_field(scenario, "scrollLines");
                let stats = Rc::new(RefCell::new(WriterStats { bytes: 0, hash: 0 }));
                let backend = CrosstermBackend::new(CountingWriter {
                    stats: Rc::clone(&stats),
                });
                let mut terminal = Terminal::new(backend).unwrap();
                terminal.resize(Rect::new(0, 0, columns, rows)).unwrap();
                let mut current_rows = rows;
                let mut current_columns = columns;
                let mut scroll_lines =
                    tool_rounds * 2 - usize::from(current_rows.saturating_sub(1));
                let mut following = true;
                let mut page_cache = ToolPageCache::new(page_size, page_cache_pages);
                let mut editor = String::from("> ");
                let mut streaming_updates = BTreeMap::new();
                for _ in 0..8 {
                    draw(
                        &mut terminal,
                        &mut page_cache,
                        tool_rounds,
                        &streaming_updates,
                        &editor,
                        scroll_lines,
                        prefetch_viewports,
                    );
                }
                stats.borrow_mut().bytes = 0;
                if kind == "idle" {
                    append(
                        &out,
                        &json!({
                            "implementation":"rust", "scenario":name, "columns":columns, "rows":rows, "round":round,
                            "events":0, "frames":0, "workUnits":0, "renderedItems":0,
                            "toolRounds":tool_rounds, "toolCallEvents":tool_rounds, "toolResultEvents":tool_rounds,
                            "streamingUpdates":0, "cachedToolRounds":page_cache.peak_cached_rounds,
                            "bytesP50":0, "bytesP95":0, "bytesP99":0, "bytesMax":0, "bytesTotal":0,
                            "frameP50Ms":0.0, "frameP95Ms":0.0, "frameP99Ms":0.0, "frameMaxMs":0.0, "frameTotalMs":0.0,
                            "rssBytes":rss_bytes(),
                            "workloadHash": workload_hash(&editor, tool_rounds, &streaming_updates, scroll_lines, current_rows, current_columns),
                        }),
                    );
                    continue;
                }
                let mut frame_samples = Vec::with_capacity(events);
                let mut byte_samples = Vec::with_capacity(events);
                let mut work_units = 0_usize;
                let mut rendered_items = 0_usize;
                for index in 0..events {
                    let event_mutation = mutation(kind, index, characters_per_event);
                    match kind {
                        "input" | "paste" => editor.push_str(&event_mutation),
                        "stream" => {
                            streaming_updates
                                .insert(tool_rounds - 1 - (index % 120), event_mutation);
                        }
                        "scroll" => {
                            scroll_lines = scroll_lines.saturating_sub(scroll_lines_per_event);
                            following = false;
                        }
                        "resize" => {
                            current_columns = if index % 2 == 0 {
                                columns
                            } else {
                                columns.saturating_sub(4).max(20)
                            };
                            current_rows = if index % 2 == 0 {
                                rows
                            } else {
                                rows.saturating_sub(2).max(8)
                            };
                            terminal
                                .resize(Rect::new(0, 0, current_columns, current_rows))
                                .unwrap();
                            if following {
                                scroll_lines =
                                    tool_rounds * 2 - usize::from(current_rows.saturating_sub(1));
                            }
                        }
                        _ => unreachable!(),
                    }
                    let before_bytes = stats.borrow().bytes;
                    let began = Instant::now();
                    draw(
                        &mut terminal,
                        &mut page_cache,
                        tool_rounds,
                        &streaming_updates,
                        &editor,
                        scroll_lines,
                        prefetch_viewports,
                    );
                    frame_samples.push(began.elapsed().as_secs_f64() * 1000.0);
                    byte_samples.push((stats.borrow().bytes - before_bytes) as f64);
                    work_units += characters_per_event
                        + items_per_event
                        + scroll_lines_per_event
                        + usize::from(kind == "resize");
                    rendered_items +=
                        visible_tool_rounds(current_rows, prefetch_viewports, tool_rounds) * 2;
                    assert!(
                        started.elapsed() <= Duration::from_millis(scenario_timeout_ms),
                        "{name}/{columns}x{rows} exceeded {scenario_timeout_ms}ms"
                    );
                }
                black_box(stats.borrow().hash);
                let mut frames_for_p50 = frame_samples.clone();
                let mut frames_for_p95 = frame_samples.clone();
                let mut frames_for_p99 = frame_samples.clone();
                let mut bytes_for_p50 = byte_samples.clone();
                let mut bytes_for_p95 = byte_samples.clone();
                let mut bytes_for_p99 = byte_samples.clone();
                append(
                    &out,
                    &json!({
                        "implementation":"rust", "scenario":name, "columns":columns, "rows":rows, "round":round,
                        "events":events, "frames":frame_samples.len(), "workUnits":work_units, "renderedItems":rendered_items,
                        "toolRounds":tool_rounds, "toolCallEvents":tool_rounds, "toolResultEvents":tool_rounds,
                        "streamingUpdates":streaming_updates.len(), "cachedToolRounds":page_cache.peak_cached_rounds,
                        "bytesP50":percentile(&mut bytes_for_p50, 0.5), "bytesP95":percentile(&mut bytes_for_p95, 0.95),
                        "bytesP99":percentile(&mut bytes_for_p99, 0.99), "bytesMax":byte_samples.iter().copied().fold(0.0, f64::max),
                        "bytesTotal":byte_samples.iter().sum::<f64>(),
                        "frameP50Ms":percentile(&mut frames_for_p50, 0.5), "frameP95Ms":percentile(&mut frames_for_p95, 0.95),
                        "frameP99Ms":percentile(&mut frames_for_p99, 0.99), "frameMaxMs":frame_samples.iter().copied().fold(0.0, f64::max),
                        "frameTotalMs":frame_samples.iter().sum::<f64>(),
                        "rssBytes":rss_bytes(),
                        "workloadHash": workload_hash(&editor, tool_rounds, &streaming_updates, scroll_lines, current_rows, current_columns),
                    }),
                );
            }
        }
    }
}

fn append(path: &PathBuf, line: &Value) {
    writeln!(
        OpenOptions::new().append(true).open(path).unwrap(),
        "{line}"
    )
    .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_cache_keeps_only_configured_tool_pages() {
        let mut cache = ToolPageCache::new(100, 4);
        let updates = BTreeMap::new();
        for index in (0..10_000).step_by(100) {
            cache.window(index, 1, 10_000, &updates);
        }
        assert!(cache.peak_cached_rounds <= 400);
    }

    #[test]
    fn page_cache_projects_streaming_tool_results_without_expanding_the_window() {
        let mut cache = ToolPageCache::new(100, 4);
        let mut updates = BTreeMap::new();
        updates.insert(9_999, "stream-0:xxxxxxxx".to_owned());
        let window = cache.window(9_999, 1, 10_000, &updates);
        assert_eq!(window.len(), 1);
        assert_eq!(window[0].result.status, "streaming");
        assert!(window[0].result.output.contains("stream-0:xxxxxxxx"));
        assert!(cache.peak_cached_rounds <= 400);
    }
}
