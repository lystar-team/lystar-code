use super::*;

pub(super) fn trace(event: &str) {
    if std::env::var_os("PI_RUST_TUI_TRACE").is_some() {
        eprintln!("lystar-rust-tui trace={event} at_ms={}", monotonic_millis());
    }
}

pub(super) fn trace_id(event: &str, id: &str) {
    if std::env::var_os("PI_RUST_TUI_TRACE").is_some() {
        eprintln!(
            "lystar-rust-tui trace={event} at_ms={} id={id}",
            monotonic_millis()
        );
    }
}

pub(super) fn trace_component_frame_applied(component_id: &str, revision: u64, bytes: usize) {
    if std::env::var_os("PI_RUST_TUI_TRACE").is_some() {
        eprintln!(
            "lystar-rust-tui trace=extension_component_frame_applied componentId={component_id} revision={revision} bytes={bytes} at_ms={}",
            monotonic_millis()
        );
    }
}

pub(super) fn monotonic_millis() -> f64 {
    #[cfg(target_os = "linux")]
    {
        #[repr(C)]
        struct Timespec {
            tv_sec: i64,
            tv_nsec: i64,
        }
        unsafe extern "C" {
            fn clock_gettime(clock_id: i32, time: *mut Timespec) -> i32;
        }
        let mut time = Timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: clock_gettime writes exactly one Timespec to the valid local pointer.
        if unsafe { clock_gettime(1, &mut time) } == 0 {
            return time.tv_sec as f64 * 1_000.0 + time.tv_nsec as f64 / 1_000_000.0;
        }
    }
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1_000.0
}

pub(super) fn trace_cache(app: &AppState) {
    if std::env::var_os("PI_RUST_TUI_TRACE").is_some() {
        let diagnostics = app.transcript.diagnostics();
        eprintln!(
            "lystar-rust-tui cache rounds={} items={} bytes={} preview_bytes={} total_bytes={}",
            diagnostics.cached_rounds,
            diagnostics.cached_items,
            diagnostics.cached_utf8_bytes,
            diagnostics.streaming_preview_utf8_bytes,
            diagnostics.total_utf8_bytes,
        );
    }
}

pub(super) fn sanitize_terminal_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .collect()
}

pub(super) fn sanitize_osc8_href(value: &str) -> Option<&str> {
    if value.is_empty()
        || value.chars().any(char::is_control)
        || value.chars().any(char::is_whitespace)
    {
        return None;
    }
    (value.starts_with("https://")
        || value.starts_with("http://")
        || value.starts_with("mailto:")
        || value.starts_with("file://"))
    .then_some(value)
}

pub(super) fn osc8_link(href: &str, text: &str) -> String {
    let Some(href) = sanitize_osc8_href(href) else {
        return String::new();
    };
    let text = sanitize_terminal_text(text);
    format!("\x1b]8;;{href}\x1b\\{text}\x1b]8;;\x1b\\")
}

pub(super) fn write_visible_osc8_link(
    writer: &mut impl Write,
    region: &VisibleLink,
) -> Result<(), io::Error> {
    queue!(
        writer,
        MoveTo(region.column, region.row),
        Print(osc8_link(&region.href, &region.label))
    )?;
    writer.flush()
}

pub(super) fn render_active_osc8_link(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &AppState,
) -> Result<(), io::Error> {
    let area = terminal.size()?;
    let full = ratatui::layout::Rect::new(0, 0, area.width, area.height);
    let overlay_links = WorkbenchOverlayView::new(app).visible_links(full);
    if !overlay_links.is_empty() {
        for region in overlay_links {
            write_visible_osc8_link(terminal.backend_mut().writer_mut(), &region)?;
        }
        return Ok(());
    }
    let Some(region) = TranscriptView::new(app).visible_link(transcript_area(app, full)) else {
        return Ok(());
    };
    write_visible_osc8_link(terminal.backend_mut().writer_mut(), &region)
}

pub(super) struct ExitTranscriptTemp {
    directory: PathBuf,
    pages: usize,
}

impl ExitTranscriptTemp {
    fn new() -> Result<Self, TuiError> {
        for attempt in 0..1_024_u16 {
            let directory = std::env::temp_dir().join(format!(
                "lystar-rust-tui-exit-{}-{}-{attempt}",
                std::process::id(),
                monotonic_millis()
            ));
            match fs::create_dir(&directory) {
                Ok(()) => {
                    return Ok(Self {
                        directory,
                        pages: 0,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(TuiError::InvalidResponse(
            "无法创建退出记录临时目录".to_owned(),
        ))
    }

    fn write_page(&mut self, items: &[lystar_protocol::TranscriptItem]) -> Result<(), TuiError> {
        let path = self.directory.join(format!("{:08}.txt", self.pages));
        self.pages = self.pages.saturating_add(1);
        let mut page = File::create(path)?;
        for item in items {
            page.write_all(transcript_plain_text(item).as_bytes())?;
        }
        page.flush()?;
        Ok(())
    }

    fn stream_reverse(&self, output: &mut impl Write) -> Result<(), TuiError> {
        for page in (0..self.pages).rev() {
            let mut input = OpenOptions::new()
                .read(true)
                .open(self.directory.join(format!("{:08}.txt", page)))?;
            io::copy(&mut input, output)?;
        }
        output.flush()?;
        Ok(())
    }
}

impl Drop for ExitTranscriptTemp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

pub(super) fn transcript_images_plain(
    images: Option<&[lystar_protocol::TranscriptImage]>,
) -> String {
    images
        .unwrap_or_default()
        .iter()
        .map(|image| {
            format!(
                "[图片 {} {}B contentRef:{}{}]",
                image.mime_type,
                image.byte_length,
                image.content_ref,
                image
                    .alt
                    .as_deref()
                    .map_or(String::new(), |alt| format!(" alt:{alt}"))
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn transcript_plain_text(item: &lystar_protocol::TranscriptItem) -> String {
    let header = format!("\n[{} {}]\n", item.timestamp, item.entry_id);
    let body = match &item.view {
        TranscriptViewItem::User { text, images } => {
            format!(
                "用户:\n{text}\n{}",
                transcript_images_plain(images.as_deref())
            )
        }
        TranscriptViewItem::Assistant { text, images } => {
            format!(
                "助手:\n{text}\n{}",
                transcript_images_plain(images.as_deref())
            )
        }
        TranscriptViewItem::Thinking { text } => format!("思考:\n{text}"),
        TranscriptViewItem::Bash { text } => format!("Bash:\n{text}"),
        TranscriptViewItem::Custom { text } => format!("自定义:\n{text}"),
        TranscriptViewItem::Summary { title, text } => format!("摘要 {title}:\n{text}"),
        TranscriptViewItem::System { text } => format!("系统:\n{text}"),
        TranscriptViewItem::ToolCall { calls } => calls
            .iter()
            .map(|call| {
                format!(
                    "Tool 调用 {} {}{}",
                    call.name,
                    call.summary,
                    call.href
                        .as_deref()
                        .map_or(String::new(), |href| format!("\n链接: {href}"))
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        TranscriptViewItem::ToolResult {
            call_id,
            name,
            status,
            summary,
            detail,
            content_ref,
            diff: _,
            images,
        } => format!(
            "Tool 结果 {name} ({status}) callId:{call_id}\n摘要: {summary}{}{}{}",
            detail
                .as_deref()
                .map_or(String::new(), |value| format!("\n{value}")),
            content_ref
                .as_deref()
                .map_or(String::new(), |value| format!("\ncontentRef: {value}")),
            if images.as_deref().is_some_and(|value| !value.is_empty()) {
                format!("\n{}", transcript_images_plain(images.as_deref()))
            } else {
                String::new()
            }
        ),
    };
    format!("{header}{body}\n")
}

pub(super) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub(super) fn write_resume_hint(
    output: &mut impl Write,
    session_path: &str,
    failure: Option<&str>,
) -> Result<(), TuiError> {
    if let Some(failure) = failure {
        writeln!(output, "{failure}")?;
    }
    writeln!(output, "会话已保存，可使用以下命令恢复：")?;
    writeln!(output, "lc -r {}", shell_quote(session_path))?;
    output.flush()?;
    Ok(())
}

pub(super) fn request_exit_transcript_page(
    pipe: &mut ProtocolPipe,
    session_path: &str,
    request_id: &str,
    cursor: Option<&str>,
    context: Option<&TranscriptRequestContext>,
) -> Result<lystar_protocol::TranscriptPage, TuiError> {
    trace_id("exit_transcript_request", request_id);
    pipe.request(&encode_read_transcript_request(
        request_id,
        session_path,
        EXIT_TRANSCRIPT_PAGE_LIMIT,
        cursor,
        context,
    )?)?;
    loop {
        match pipe.inbound.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(message)) => match message.read_only()? {
                ReadOnlyMessage::Response(ReadOnlyResponse::TranscriptPage { id, page })
                    if id == request_id =>
                {
                    trace_id("exit_transcript_response", &id);
                    if !page.complete {
                        return Err(TuiError::InvalidResponse("退出记录页未完整返回".to_owned()));
                    }
                    return Ok(page);
                }
                ReadOnlyMessage::Response(ReadOnlyResponse::Error { id, message })
                    if id == request_id =>
                {
                    return Err(TuiError::InvalidResponse(message));
                }
                _ => {}
            },
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(TuiError::InvalidResponse("读取退出记录超时".to_owned()));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(TuiError::ChildEof),
        }
    }
}

pub(super) fn emit_exit_output(
    pipe: &mut ProtocolPipe,
    session_path: &str,
    output: ExitOutput,
) -> Result<(), TuiError> {
    if output == ExitOutput::ResumeHint {
        return write_resume_hint(&mut io::stdout(), session_path, None);
    }
    let mut temporary = ExitTranscriptTemp::new()?;
    let mut cursor: Option<String> = None;
    let mut generation = None;
    let mut revision = None;
    let mut page_number = 0_u64;
    loop {
        page_number = page_number.saturating_add(1);
        let request_id = format!("exit-transcript-{page_number}");
        let context = cursor.as_ref().map(|cursor| TranscriptRequestContext {
            generation: generation.clone(),
            revision,
            cursor: Some(cursor.clone()),
        });
        let page = request_exit_transcript_page(
            pipe,
            session_path,
            &request_id,
            cursor.as_deref(),
            context.as_ref(),
        )?;
        if page.items.len() > EXIT_TRANSCRIPT_PAGE_LIMIT as usize {
            return Err(TuiError::InvalidResponse(format!(
                "退出记录页超过 {EXIT_TRANSCRIPT_PAGE_LIMIT} 条"
            )));
        }
        temporary.write_page(&page.items)?;
        generation = Some(page.transcript_generation);
        revision = Some(page.transcript_revision);
        cursor = page.previous_cursor;
        if cursor.is_none() {
            break;
        }
    }
    temporary.stream_reverse(&mut io::stdout())
}
