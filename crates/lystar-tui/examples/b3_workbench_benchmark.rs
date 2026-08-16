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
        composer_area, transcript_area, AppState, ComposerAttachment, ComposerView, DetailOverlay,
        ListOverlay, OverlayItem, OverlayOrigin, OverlayState, ReadonlySessionView,
        SessionTreeNode, TranscriptView, WorkbenchOverlayView,
    },
    editor::EditorState,
};
use ratatui::{
    backend::{CrosstermBackend, TestBackend},
    layout::Rect,
    Terminal,
};
use serde_json::{json, Value};

struct BenchmarkConfig {
    implementation: String,
    sizes: Vec<(u16, u16)>,
    rounds: usize,
    tool_rounds: usize,
    cache_limits: CacheLimits,
    scenarios: Vec<String>,
}

struct CacheLimits {
    rounds: usize,
    items: usize,
    bytes: usize,
}

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
    let config = benchmark_config();
    let out = parse_output_path();
    fs::create_dir_all(out.parent().expect("benchmark output has a parent")).unwrap();
    File::create(&out).unwrap();

    for round in 1..=config.rounds {
        for &(columns, rows) in &config.sizes {
            for scenario in &config.scenarios {
                run_case(&out, round, columns, rows, scenario, &config);
            }
        }
    }
}

fn benchmark_config() -> BenchmarkConfig {
    let value: Value = serde_json::from_str(
        &fs::read_to_string("benchmarks/rust-b3-workbench-scenarios.json").unwrap(),
    )
    .unwrap();
    let cache_limits = &value["cacheLimits"];
    BenchmarkConfig {
        implementation: string_field(&value, "implementation").to_owned(),
        sizes: value["sizes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|size| {
                (
                    size[0].as_u64().unwrap() as u16,
                    size[1].as_u64().unwrap() as u16,
                )
            })
            .collect(),
        rounds: number_field(&value, "rounds"),
        tool_rounds: number_field(&value, "toolRounds"),
        cache_limits: CacheLimits {
            rounds: number_field(cache_limits, "rounds"),
            items: number_field(cache_limits, "items"),
            bytes: number_field(cache_limits, "bytes"),
        },
        scenarios: value["scenarios"]
            .as_array()
            .unwrap()
            .iter()
            .map(|scenario| string_field(scenario, "name").to_owned())
            .collect(),
    }
}

fn string_field<'a>(value: &'a Value, name: &str) -> &'a str {
    value[name].as_str().unwrap()
}

fn number_field(value: &Value, name: &str) -> usize {
    value[name].as_u64().unwrap() as usize
}

fn parse_output_path() -> PathBuf {
    let args = env::args().collect::<Vec<_>>();
    args.windows(2)
        .find_map(|pair| (pair[0] == "--out").then(|| PathBuf::from(&pair[1])))
        .unwrap_or_else(|| PathBuf::from(".artifacts/rust-tui-b3-workbench/benchmark.jsonl"))
}

fn run_case(
    out: &PathBuf,
    round: usize,
    columns: u16,
    rows: u16,
    scenario: &str,
    config: &BenchmarkConfig,
) {
    let mut benchmark = setup(columns, rows, config.tool_rounds);
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
        active.cached_rounds <= config.cache_limits.rounds
            && active.cached_items <= config.cache_limits.items
            && active.cached_utf8_bytes <= config.cache_limits.bytes
    );
    assert!(
        readonly.cached_rounds <= config.cache_limits.rounds
            && readonly.cached_items <= config.cache_limits.items
            && readonly.cached_utf8_bytes <= config.cache_limits.bytes
    );
    assert!(bytes > 0 && rss > 0);

    append(
        out,
        json!({
            "implementation": config.implementation,
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
            "activeToolRounds": config.tool_rounds,
            "readonlyToolRounds": config.tool_rounds,
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

fn setup(columns: u16, rows: u16, tool_rounds: usize) -> BenchmarkApp {
    let mut app = AppState::default();
    app.editor = EditorState::default();
    app.transcript.replace_page(
        tool_items("active", tool_rounds),
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
        tool_items("readonly", tool_rounds),
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
        "changes_filter_detail" => open_changes_detail(app),
        "skills_open" => open_workbench_list(
            app,
            "技能",
            vec![OverlayItem {
                label: "fixture-skill".to_owned(),
                detail: "project  已启用  fixture skill description".to_owned(),
                action: "skill:0".to_owned(),
            }],
            "fixture",
            "Enter 选择作用域，r 刷新",
        ),
        "trust_open" => open_workbench_list(
            app,
            "项目信任",
            vec![OverlayItem {
                label: "已信任".to_owned(),
                detail: "/tmp/project  风险:有  项目资源已信任".to_owned(),
                action: "trust:toggle".to_owned(),
            }],
            String::new(),
            "t 切换信任状态",
        ),
        "instructions_open" => open_workbench_list(
            app,
            "指令 [项目]",
            vec![OverlayItem {
                label: "AGENTS.md".to_owned(),
                detail: "存在 生效 可编辑 /tmp/project/AGENTS.md".to_owned(),
                action: "instruction:project:0".to_owned(),
            }],
            "AGENTS",
            "Tab 切换项目/本机，Enter 完整编辑",
        ),
        "packages_open" => open_workbench_list(
            app,
            "包",
            vec![OverlayItem {
                label: "npm:fixture".to_owned(),
                detail: "project  /tmp/project/.pi/packages/fixture  已配置".to_owned(),
                action: "package:0".to_owned(),
            }],
            "fixture",
            "i 安装  d 删除  u 更新  U 更新全部",
        ),
        "update_open" => open_update(app),
        "subagents_open" => open_subagents(app),
        "subagent_detail" => open_subagent_detail(app),
        "subagent_nested" => {
            open_subagent_detail(app);
            open_subagents(app);
        }
        "clipboard_open" => open_clipboard(app, false),
        "clipboard_insert" => open_clipboard(app, true),
        "attachments_open" => open_attachments(app, false),
        "attachment_preview" => open_attachments(app, true),
        _ => unreachable!("unknown scenario"),
    }
}

fn open_subagents(app: &mut AppState) {
    open_workbench_list(
        app,
        "Subagent",
        vec![
            OverlayItem {
                label: "fixture-running".to_owned(),
                detail: "run:fixture-live  live  running  24ms  read src/lib.rs".to_owned(),
                action: "subagent:0".to_owned(),
            },
            OverlayItem {
                label: "fixture-completed".to_owned(),
                detail: "run:fixture-done  transcript  succeeded  12ms".to_owned(),
                action: "subagent:1".to_owned(),
            },
        ],
        "fixture",
        "Enter 详情  a 停止运行项  c 继续已结束项  r 刷新",
    );
}

fn open_subagent_detail(app: &mut AppState) {
    app.open_workspace_overlay(
        "benchmark:subagent:detail",
        OverlayState::Detail(DetailOverlay {
            title: "Subagent 详情".to_owned(),
            lines: vec![
                "runId: fixture-live".to_owned(),
                "状态: running".to_owned(),
                "任务: benchmark fixture task".to_owned(),
                "当前 Tool: read src/lib.rs".to_owned(),
                "session path: /tmp/fixture-subagent.jsonl".to_owned(),
            ],
            scroll: 0,
            status: "Enter 查看嵌套 Subagent  v 只读记录  Esc 返回".to_owned(),
            link: None,
            copy_text: None,
        }),
    );
}

fn open_attachments(app: &mut AppState, preview: bool) {
    let attachment = ComposerAttachment {
        id: 1,
        name: "fixture image.png".to_owned(),
        source: "images/fixture image.png".to_owned(),
        mime_type: "image/png".to_owned(),
        byte_length: 68,
        content_hash: "fixture-image-hash".to_owned(),
        base64: "fixture-image-base64".to_owned(),
    };
    app.add_attachment(attachment.clone()).unwrap();
    if preview {
        app.attachment_preview = Some(attachment.content_hash.clone());
        app.open_workspace_overlay(
            "benchmark:attachment:preview",
            OverlayState::Detail(DetailOverlay {
                title: "图片预览".to_owned(),
                lines: vec![
                    format!("名称: {}", attachment.name),
                    format!("MIME: {}", attachment.mime_type),
                    format!("大小: {} B", attachment.byte_length),
                    format!("哈希: {}", attachment.content_hash),
                ],
                scroll: 0,
                status: "Esc 返回".to_owned(),
                link: None,
                copy_text: None,
            }),
        );
        return;
    }
    open_workbench_list(
        app,
        "图片附件",
        vec![OverlayItem {
            label: attachment.name,
            detail: "project  image/png  68 B  #fixture-imag".to_owned(),
            action: "attachment:0".to_owned(),
        }],
        String::new(),
        "Enter 预览  d 删除  D 清空",
    );
}

fn open_clipboard(app: &mut AppState, inserted: bool) {
    if inserted {
        app.editor.insert("clipboard fixture text");
    }
    app.open_workspace_overlay(
        "benchmark:clipboard",
        OverlayState::Detail(DetailOverlay {
            title: "剪贴板".to_owned(),
            lines: vec![
                "文本剪贴板: 支持".to_owned(),
                "图片剪贴板: image/png 68 B #fixture-clip".to_owned(),
                "预览: clipboard fixture text".to_owned(),
            ],
            scroll: 0,
            status: "i 插入输入框  w 写入输入框  c 复制预览  Esc 返回".to_owned(),
            link: None,
            copy_text: Some("clipboard fixture text".to_owned()),
        }),
    );
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

fn open_workbench_list(
    app: &mut AppState,
    title: &str,
    items: Vec<OverlayItem>,
    filter: impl Into<String>,
    status: &str,
) {
    app.open_workspace_overlay(
        format!("benchmark:{title}"),
        OverlayState::List(ListOverlay {
            title: title.to_owned(),
            origin: OverlayOrigin::User,
            items,
            selected: 0,
            filter: filter.into(),
            status: status.to_owned(),
        }),
    );
}

fn open_changes_detail(app: &mut AppState) {
    app.open_workspace_overlay(
        "benchmark:changes:detail",
        OverlayState::Detail(DetailOverlay {
            title: "变更详情".to_owned(),
            lines: vec![
                "src/unstaged.ts  未暂存  +2 -1".to_owned(),
                "diff --git a/src/unstaged.ts b/src/unstaged.ts".to_owned(),
                "+added".to_owned(),
                "-removed".to_owned(),
            ],
            scroll: 0,
            status: "筛选: unstaged  Ctrl+O 摘要  Esc 返回".to_owned(),
            link: None,
            copy_text: None,
        }),
    );
}

fn open_update(app: &mut AppState) {
    app.open_workspace_overlay(
        "benchmark:update",
        OverlayState::Detail(DetailOverlay {
            title: "更新检查".to_owned(),
            lines: vec![
                "当前: 0.84.2".to_owned(),
                "最新: 0.84.3".to_owned(),
                "fixture update note".to_owned(),
            ],
            scroll: 0,
            status: "仅检查版本，TUI 内不执行更新。r 重新检查".to_owned(),
            link: None,
            copy_text: None,
        }),
    );
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

fn tool_items(prefix: &str, tool_rounds: usize) -> Vec<TranscriptItem> {
    let mut items = Vec::with_capacity(tool_rounds * 2);
    for index in 0..tool_rounds {
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
                images: None,
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
