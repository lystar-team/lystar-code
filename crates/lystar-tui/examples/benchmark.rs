use std::{
    cell::RefCell,
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

struct BenchApp<'a> {
    page: &'a [String],
    editor: &'a str,
    scroll: usize,
    prefetch_viewports: usize,
}

impl Widget for BenchApp<'_> {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        let viewport = area.height.saturating_sub(1);
        let rendered = self
            .page
            .iter()
            .skip(self.scroll)
            .take(usize::from(viewport) * (1 + self.prefetch_viewports));
        black_box(rendered.fold(0_usize, |total, line| total.saturating_add(line.len())));
        for (row, line) in self
            .page
            .iter()
            .skip(self.scroll)
            .take(usize::from(viewport))
            .enumerate()
        {
            buffer.set_string(
                area.x,
                area.y + row as u16,
                truncate(line, usize::from(area.width)),
                Style::default().fg(Color::White),
            );
        }
        buffer.set_string(
            area.x,
            area.y + viewport,
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
    samples[((samples.len() - 1) as f64 * q).ceil() as usize % samples.len()]
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

fn visible_items(rows: u16, prefetch_viewports: usize, item_count: usize) -> usize {
    let viewport = usize::from(rows.saturating_sub(1)).max(1);
    item_count.min(viewport * (1 + prefetch_viewports))
}

fn benchmark_page(item_count: usize) -> Vec<String> {
    (0..item_count)
        .map(|id| format!("assistant {id:05} benchmark transcript line with Chinese 内容"))
        .collect()
}

fn draw(
    terminal: &mut Terminal<CrosstermBackend<CountingWriter>>,
    page: &[String],
    editor: &str,
    scroll: usize,
    prefetch_viewports: usize,
) {
    terminal
        .draw(|frame| {
            frame.render_widget(
                BenchApp {
                    page,
                    editor,
                    scroll,
                    prefetch_viewports,
                },
                frame.area(),
            )
        })
        .unwrap();
}

fn hold_rss(config: &Value, hold_ms: u64) {
    let item_count = number_field(config, "transcriptItems");
    let prefetch_viewports = number_field(config, "prefetchViewports");
    let stats = Rc::new(RefCell::new(WriterStats { bytes: 0, hash: 0 }));
    let backend = CrosstermBackend::new(CountingWriter {
        stats: Rc::clone(&stats),
    });
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.resize(Rect::new(0, 0, 120, 36)).unwrap();
    let page = benchmark_page(item_count);
    let scroll = page.len().saturating_sub(35);
    for _ in 0..8 {
        draw(&mut terminal, &page, "> steady", scroll, prefetch_viewports);
    }
    black_box(stats.borrow().hash);
    println!("READY");
    thread::sleep(Duration::from_millis(hold_ms));
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let config = scenario_config();
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
    let item_count = number_field(&config, "transcriptItems");
    let prefetch_viewports = number_field(&config, "prefetchViewports");

    for round in 1..=rounds {
        for size in sizes.iter().take(if smoke { 1 } else { sizes.len() }) {
            let columns = size[0].as_u64().unwrap() as u16;
            let rows = size[1].as_u64().unwrap() as u16;
            for scenario in scenarios {
                let name = string_field(scenario, "name");
                let kind = string_field(scenario, "kind");
                let events = number_field(scenario, "events");
                let characters_per_event = number_field(scenario, "charactersPerEvent");
                let items_per_event = number_field(scenario, "itemsPerEvent");
                let scroll_lines = number_field(scenario, "scrollLines");
                let stats = Rc::new(RefCell::new(WriterStats { bytes: 0, hash: 0 }));
                let backend = CrosstermBackend::new(CountingWriter {
                    stats: Rc::clone(&stats),
                });
                let mut terminal = Terminal::new(backend).unwrap();
                terminal.resize(Rect::new(0, 0, columns, rows)).unwrap();
                let mut current_rows = rows;
                let mut page = benchmark_page(item_count);
                let mut editor = String::from("> ");
                let mut scroll = page
                    .len()
                    .saturating_sub(usize::from(current_rows.saturating_sub(1)));
                let mut following = true;
                for _ in 0..8 {
                    draw(&mut terminal, &page, &editor, scroll, prefetch_viewports);
                }
                stats.borrow_mut().bytes = 0;
                if kind == "idle" {
                    append(
                        &out,
                        &json!({
                            "implementation":"rust", "scenario":name, "columns":columns, "rows":rows, "round":round,
                            "events":0, "frames":0, "workUnits":0, "renderedItems":0,
                            "bytesP50":0, "bytesP95":0, "bytesP99":0, "bytesMax":0, "bytesTotal":0,
                            "frameP50Ms":0.0, "frameP95Ms":0.0, "frameP99Ms":0.0, "frameMaxMs":0.0, "frameTotalMs":0.0,
                            "rssBytes":rss_bytes()
                        }),
                    );
                    continue;
                }
                let mut frame_samples = Vec::with_capacity(events);
                let mut byte_samples = Vec::with_capacity(events);
                let mut work_units = 0_usize;
                let mut rendered_items = 0_usize;
                for index in 0..events {
                    let mutation = format!("{kind}-{index}:")
                        .chars()
                        .chain(std::iter::repeat('x'))
                        .take(characters_per_event)
                        .collect::<String>();
                    match kind {
                        "input" | "paste" => editor.push_str(&mutation),
                        "stream" => {
                            page.push(mutation);
                            if following {
                                scroll = page
                                    .len()
                                    .saturating_sub(usize::from(current_rows.saturating_sub(1)));
                            }
                        }
                        "scroll" => {
                            scroll = scroll.saturating_sub(scroll_lines);
                            following = false;
                        }
                        "resize" => {
                            let width = if index % 2 == 0 {
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
                                .resize(Rect::new(0, 0, width, current_rows))
                                .unwrap();
                            if following {
                                scroll = page
                                    .len()
                                    .saturating_sub(usize::from(current_rows.saturating_sub(1)));
                            }
                        }
                        _ => unreachable!(),
                    }
                    let before_bytes = stats.borrow().bytes;
                    let began = Instant::now();
                    draw(&mut terminal, &page, &editor, scroll, prefetch_viewports);
                    frame_samples.push(began.elapsed().as_secs_f64() * 1000.0);
                    byte_samples.push((stats.borrow().bytes - before_bytes) as f64);
                    work_units += characters_per_event
                        + items_per_event
                        + scroll_lines
                        + usize::from(kind == "resize");
                    rendered_items += visible_items(current_rows, prefetch_viewports, page.len());
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
                        "bytesP50":percentile(&mut bytes_for_p50, 0.5), "bytesP95":percentile(&mut bytes_for_p95, 0.95),
                        "bytesP99":percentile(&mut bytes_for_p99, 0.99), "bytesMax":byte_samples.iter().copied().fold(0.0, f64::max),
                        "bytesTotal":byte_samples.iter().sum::<f64>(),
                        "frameP50Ms":percentile(&mut frames_for_p50, 0.5), "frameP95Ms":percentile(&mut frames_for_p95, 0.95),
                        "frameP99Ms":percentile(&mut frames_for_p99, 0.99), "frameMaxMs":frame_samples.iter().copied().fold(0.0, f64::max),
                        "frameTotalMs":frame_samples.iter().sum::<f64>(),
                        "rssBytes":rss_bytes()
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
