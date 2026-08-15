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

use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
    widgets::{Block, Borders, Widget},
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
            stats.hash = stats.hash.wrapping_mul(16777619) ^ u64::from(*byte);
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
}

impl Widget for BenchApp<'_> {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        let block = Block::default()
            .borders(Borders::ALL)
            .title("LYStar Rust B0");
        let inner = block.inner(area);
        block.render(area, buffer);
        let footer = 3_u16.min(inner.height);
        let viewport = inner.height.saturating_sub(footer);
        for (row, line) in self
            .page
            .iter()
            .skip(self.scroll)
            .take(usize::from(viewport))
            .enumerate()
        {
            buffer.set_string(
                inner.x,
                inner.y + row as u16,
                truncate(line, usize::from(inner.width)),
                Style::default().fg(Color::White),
            );
        }
        if footer > 0 {
            let editor_row = inner.y + viewport;
            buffer.set_string(
                inner.x,
                editor_row,
                truncate(&format!("> {}", self.editor), usize::from(inner.width)),
                Style::default().fg(Color::Cyan),
            );
            if footer > 1 {
                buffer.set_string(
                    inner.x,
                    editor_row + 1,
                    truncate("Enter: send  Ctrl+C: cancel", usize::from(inner.width)),
                    Style::default().fg(Color::DarkGray),
                );
            }
        }
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

fn main() {
    let args: Vec<String> = env::args().collect();
    let out = args
        .iter()
        .position(|value| value == "--out")
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".artifacts/rust-tui-spike/benchmark-rust.jsonl"));
    fs::create_dir_all(out.parent().unwrap()).unwrap();
    File::create(&out).unwrap();
    let config = scenario_config();
    let smoke = args.iter().any(|value| value == "--smoke");
    let rounds = if smoke {
        1
    } else {
        config["rounds"].as_u64().unwrap()
    };
    let sizes = config["sizes"].as_array().unwrap();
    let scenarios = config["scenarios"].as_array().unwrap();
    let source: Vec<String> = (0..10_000)
        .map(|id| format!("assistant {id:05} benchmark transcript line with Chinese 内容"))
        .collect();

    for round in 1..=rounds {
        for size in sizes.iter().take(if smoke { 1 } else { sizes.len() }) {
            let columns = size[0].as_u64().unwrap() as u16;
            let rows = size[1].as_u64().unwrap() as u16;
            for scenario in scenarios {
                let name = scenario["name"].as_str().unwrap();
                let kind = scenario["kind"].as_str().unwrap();
                let events = scenario["events"].as_u64().unwrap() as usize;
                let stats = Rc::new(RefCell::new(WriterStats { bytes: 0, hash: 0 }));
                let backend = CrosstermBackend::new(CountingWriter {
                    stats: Rc::clone(&stats),
                });
                let mut terminal = Terminal::new(backend).unwrap();
                terminal.resize(Rect::new(0, 0, columns, rows)).unwrap();
                let mut page: Vec<String> = source[9_600..].to_vec();
                let mut editor = String::new();
                terminal
                    .draw(|frame| {
                        frame.render_widget(
                            BenchApp {
                                page: &page,
                                editor: &editor,
                                scroll: 0,
                            },
                            frame.area(),
                        )
                    })
                    .unwrap();
                stats.borrow_mut().bytes = 0;
                if kind == "idle" {
                    let line = json!({"implementation":"rust","scenario":name,"columns":columns,"rows":rows,"round":round,"frames":0,"bytes":0,"p50Ms":0.0,"p95Ms":0.0,"p99Ms":0.0,"maxMs":0.0,"rssBytes":rss_bytes()});
                    append(&out, &line);
                    continue;
                }
                let batch = events.div_ceil(20).max(10);
                let mut samples = Vec::new();
                let mut scroll = 0_usize;
                for start in (0..events).step_by(batch) {
                    let count = (events - start).min(batch);
                    let began = Instant::now();
                    for index in 0..count {
                        match kind {
                            "input" => editor.push(char::from(b'a' + (index % 26) as u8)),
                            "paste" => editor.push_str(&"x".repeat(5_000)),
                            "stream" => editor.push_str(&format!(" stream-{}", start + index)),
                            "scroll" => {
                                scroll = (scroll + 1).min(page.len().saturating_sub(1));
                                if (start + index) % 75 == 0 {
                                    page =
                                        source[9_600usize.saturating_sub(start + index)..].to_vec();
                                }
                            }
                            "resize" => {
                                let width = if index % 2 == 0 {
                                    columns
                                } else {
                                    columns.saturating_sub(4).max(20)
                                };
                                let height = if index % 2 == 0 {
                                    rows
                                } else {
                                    rows.saturating_sub(2).max(8)
                                };
                                terminal.resize(Rect::new(0, 0, width, height)).unwrap();
                            }
                            _ => unreachable!(),
                        }
                        terminal
                            .draw(|frame| {
                                frame.render_widget(
                                    BenchApp {
                                        page: &page,
                                        editor: &editor,
                                        scroll,
                                    },
                                    frame.area(),
                                )
                            })
                            .unwrap();
                    }
                    samples.push(began.elapsed().as_secs_f64() * 1000.0 / count as f64);
                }
                black_box(stats.borrow().hash);
                let mut sorted = samples.clone();
                let line = json!({"implementation":"rust","scenario":name,"columns":columns,"rows":rows,"round":round,"frames":events,"bytes":stats.borrow().bytes,"p50Ms":percentile(&mut sorted,0.5),"p95Ms":percentile(&mut samples.clone(),0.95),"p99Ms":percentile(&mut samples.clone(),0.99),"maxMs":samples.iter().copied().fold(0.0,f64::max),"rssBytes":rss_bytes()});
                append(&out, &line);
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
