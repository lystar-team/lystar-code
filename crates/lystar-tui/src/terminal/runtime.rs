use super::*;

#[cfg(unix)]
pub fn run(session_path: &str) -> Result<(), TuiError> {
    run_with_options(session_path, RunOptions::default())
}

#[cfg(unix)]
pub fn run_with_options(session_path: &str, options: RunOptions) -> Result<(), TuiError> {
    let mode = resolve_terminal_mode(options.mode, terminal_mode_context());
    let client_instance_id = std::env::var("PI_RUST_TUI_CLIENT_INSTANCE_ID")
        .unwrap_or_else(|_| format!("lystar-rust-m8-{}", std::process::id()));
    let mut pipe = ProtocolPipe::connect(&client_instance_id)?;
    let result = run_session(session_path, mode, &client_instance_id, &mut pipe);
    if mode == TerminalMode::Fullscreen
        && let Err(error) = emit_exit_output(&mut pipe, session_path, options.exit_output)
    {
        write_resume_hint(
            &mut io::stdout(),
            session_path,
            Some(&format!("读取完整记录失败：{error}")),
        )?;
    }
    result
}

pub(super) fn clear_terminal_extension_output(
    app: &mut AppState,
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    image_sidecar: &mut ImageSidecar,
) -> Result<(), io::Error> {
    image_sidecar.clear(
        terminal.backend_mut().writer_mut(),
        std::env::var_os("TMUX").is_some(),
    )?;
    write_extension_title(None);
    app.extension_ui = ExtensionUiState::default();
    Ok(())
}

#[cfg(unix)]
pub(super) fn run_session(
    session_path: &str,
    mode: TerminalMode,
    client_instance_id: &str,
    pipe: &mut ProtocolPipe,
) -> Result<(), TuiError> {
    let shutdown = Arc::new(AtomicBool::new(false));
    flag::register(SIGINT, Arc::clone(&shutdown))?;
    flag::register(SIGTERM, Arc::clone(&shutdown))?;
    let _terminal_guard = TerminalGuard::enter(mode).map_err(|error| TuiError::TerminalSetup {
        mode: mode.name(),
        message: error.to_string(),
    })?;
    let mut request_sequence = 0_u64;
    let mut app = AppState::default();
    let generation = app.begin_active_session(session_path.to_owned(), String::new());
    let acquire_id = request_acquire(
        pipe,
        session_path,
        client_instance_id,
        &mut request_sequence,
    )?;
    let mut session_flow = Some(SessionFlow::InitialAcquiring {
        id: acquire_id,
        path: session_path.to_owned(),
        generation,
    });
    let mut quit_requested = false;
    request_transcript(
        &mut app,
        pipe,
        session_path,
        None,
        true,
        None,
        TranscriptViewKind::Active,
        &mut request_sequence,
    )?;

    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = match mode {
        TerminalMode::Fullscreen => Terminal::new(backend)?,
        TerminalMode::Regular => Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(inline_viewport_height(crossterm::terminal::size()?.1)),
            },
        )?,
        TerminalMode::Auto => unreachable!("terminal mode must be resolved before rendering"),
    };
    let mut image_sidecar = ImageSidecar::new(if mode == TerminalMode::Fullscreen {
        current_terminal_image_protocol()
    } else {
        TerminalImageProtocol::Unknown
    });
    trace("terminal_ready");
    app.mark_page_load_pending();
    let mut dirty = true;
    let mut timeout_notified = false;
    let mut last_component_size: Option<(u16, u16)> = None;
    loop {
        if dirty {
            let area = terminal.size()?;
            let full = ratatui::layout::Rect::new(0, 0, area.width, area.height);
            let widget_budget = app.extension_widget_budget(full.height);
            let composer = composer_area_with_widget_budget(full, widget_budget);
            app.prepare_composer(composer);
            trace("draw_start");
            terminal.draw(|frame| {
                let area = frame.area();
                frame.render_widget(
                    TranscriptView::new(&app),
                    transcript_area_with_widget_budget(area, widget_budget),
                );
                frame.render_widget(
                    ComposerView::with_widget_budget(&app, usize::from(widget_budget)),
                    composer_area_with_widget_budget(area, widget_budget),
                );
                if let Some(component) = app.active_extension_overlay() {
                    let rect = extension_component_rect(&app, component, area);
                    frame.render_widget(
                        ExtensionComponentOverlayView::new(&app, component, area),
                        area,
                    );
                    if let Some((row, column)) = component.cursor
                        && row < rect.height
                        && column < rect.width
                    {
                        let inset = u16::from(
                            component.overlay_options.overlay
                                && rect.width >= 2
                                && rect.height >= 3,
                        );
                        frame.set_cursor_position((
                            rect.x.saturating_add(inset).saturating_add(column),
                            rect.y.saturating_add(inset).saturating_add(row),
                        ));
                    }
                } else if app.overlay().is_some() {
                    frame.render_widget(WorkbenchOverlayView::new(&app), area);
                } else if let Some(component) = app.active_extension_editor() {
                    let composer = composer_area_with_widget_budget(area, widget_budget);
                    if let Some((row, column)) = component.cursor
                        && row.saturating_add(1) < composer.height.saturating_sub(2)
                        && column < composer.width
                    {
                        frame.set_cursor_position((
                            composer.x.saturating_add(column),
                            composer.y.saturating_add(1).saturating_add(row),
                        ));
                    }
                } else {
                    frame.render_widget(WorkbenchOverlayView::new(&app), area);
                }
            })?;
            trace("draw_end");
            trace("frame_rendered");
            if app.transcript.cached_rounds() > 0 {
                trace("frame_rendered_nonempty");
            }
            render_active_osc8_link(&mut terminal, &app)?;
            if app
                .active_extension_overlay()
                .and_then(|component| component.cursor)
                .is_some()
                || (app.overlay().is_none()
                    && app
                        .active_extension_editor()
                        .and_then(|component| component.cursor)
                        .is_some())
            {
                execute!(terminal.backend_mut().writer_mut(), Show)?;
            } else {
                execute!(terminal.backend_mut().writer_mut(), Hide)?;
            }
            image_sidecar.draw_after_frame(
                terminal.backend_mut().writer_mut(),
                visible_cached_images(&app),
                std::env::var_os("TMUX").is_some(),
            )?;
            trace_cache(&app);
            dirty = false;
        }
        if shutdown.load(Ordering::Relaxed) {
            clear_terminal_extension_output(&mut app, &mut terminal, &mut image_sidecar)?;
            release_active_session(&app, pipe, &mut request_sequence)?;
            return Ok(());
        }

        let mut state_changed = false;
        let mut handled_message = false;
        loop {
            match pipe.inbound.try_recv() {
                Ok(message) => {
                    if let Err(error) = process_inbound_message(
                        &mut app,
                        message,
                        pipe,
                        session_path,
                        client_instance_id,
                        &mut request_sequence,
                        &mut session_flow,
                        &mut quit_requested,
                    ) {
                        clear_terminal_extension_output(
                            &mut app,
                            &mut terminal,
                            &mut image_sidecar,
                        )?;
                        return Err(error);
                    }
                    handled_message = true;
                    state_changed = true;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    app.clear_connection_state("Host 连接已断开");
                    clear_terminal_extension_output(&mut app, &mut terminal, &mut image_sidecar)?;
                    return Err(TuiError::ChildEof);
                }
            }
        }
        let size = terminal.size()?;
        if app.extension_ui.components.is_empty() {
            last_component_size = None;
        } else if last_component_size != Some((size.width, size.height)) {
            let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
            request_extension_component_resize(
                &app,
                pipe,
                &active_path,
                client_instance_id,
                &mut request_sequence,
                size.width,
                size.height,
            )?;
            last_component_size = Some((size.width, size.height));
            state_changed = true;
        }
        if event::poll(Duration::ZERO)? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => {
                    let overlay_component = app
                        .active_extension_overlay()
                        .map(|component| (component.component_id.clone(), component.generation));
                    let is_overlay_component = overlay_component.is_some();
                    let component = overlay_component.or_else(|| {
                        if app.overlay().is_none() {
                            app.active_extension_editor().map(|component| {
                                (component.component_id.clone(), component.generation)
                            })
                        } else {
                            None
                        }
                    });
                    if key.code == KeyCode::Char('r')
                        && key.modifiers.contains(KeyModifiers::CONTROL)
                        && app.recovery_draft.is_some()
                    {
                        open_custom_editor_recovery(&mut app);
                        state_changed = true;
                    } else if let Some((component_id, generation)) = component {
                        let active_path =
                            app.active_session_path().unwrap_or(session_path).to_owned();
                        if component_id == "editor"
                            && key.code == KeyCode::Enter
                            && key.modifiers.is_empty()
                            && app.editor.text().trim() == "/attachments"
                        {
                            app.editor.clear();
                            app.open_overlay(attach_overlay(&app));
                        } else if is_overlay_component && key.code == KeyCode::Esc {
                            request_extension_component_cancel(
                                &app,
                                pipe,
                                &active_path,
                                client_instance_id,
                                &mut request_sequence,
                                &component_id,
                                generation,
                            )?;
                        } else if let Some(data) = raw_key(key.code, key.modifiers) {
                            request_extension_component_input(
                                &mut app,
                                pipe,
                                &active_path,
                                client_instance_id,
                                &mut request_sequence,
                                &component_id,
                                generation,
                                data,
                            )?;
                        }
                        state_changed = true;
                    } else if app.extension_ui.terminal_input_listener_count > 0
                        && app.input_focus == InputFocus::Composer
                        && let Some(data) = raw_key(key.code, key.modifiers)
                    {
                        let active_path =
                            app.active_session_path().unwrap_or(session_path).to_owned();
                        request_extension_terminal_input(
                            &mut app,
                            pipe,
                            &active_path,
                            client_instance_id,
                            &mut request_sequence,
                            data,
                        )?;
                        state_changed = true;
                    } else if handle_key(
                        &mut app,
                        key.code,
                        key.modifiers,
                        pipe,
                        session_path,
                        client_instance_id,
                        &mut request_sequence,
                        &mut session_flow,
                        &mut quit_requested,
                    )? {
                        clear_terminal_extension_output(
                            &mut app,
                            &mut terminal,
                            &mut image_sidecar,
                        )?;
                        release_active_session(&app, pipe, &mut request_sequence)?;
                        return Ok(());
                    } else {
                        state_changed = true;
                    }
                }
                Event::Paste(text) => {
                    let component = app
                        .active_extension_overlay()
                        .or_else(|| app.active_extension_editor())
                        .map(|component| (component.component_id.clone(), component.generation));
                    if let Some((component_id, generation)) = component {
                        if text.len().saturating_add(12) <= MAX_EXTENSION_INPUT_BYTES {
                            let active_path =
                                app.active_session_path().unwrap_or(session_path).to_owned();
                            request_extension_component_input(
                                &mut app,
                                pipe,
                                &active_path,
                                client_instance_id,
                                &mut request_sequence,
                                &component_id,
                                generation,
                                format!("\x1b[200~{text}\x1b[201~"),
                            )?;
                        }
                    } else if app.extension_ui.terminal_input_listener_count > 0
                        && app.input_focus == InputFocus::Composer
                        && text.len().saturating_add(12) <= MAX_EXTENSION_INPUT_BYTES
                    {
                        let active_path =
                            app.active_session_path().unwrap_or(session_path).to_owned();
                        request_extension_terminal_input(
                            &mut app,
                            pipe,
                            &active_path,
                            client_instance_id,
                            &mut request_sequence,
                            format!("\x1b[200~{text}\x1b[201~"),
                        )?;
                    } else if app.input_focus == InputFocus::Overlay {
                        app.overlay_insert(&text);
                    } else {
                        app.editor.insert(&text);
                    }
                    state_changed = true;
                }
                Event::Mouse(mouse) => {
                    let component = app.active_extension_overlay().and_then(|component| {
                        let area = terminal.size().ok()?;
                        let full = ratatui::layout::Rect::new(0, 0, area.width, area.height);
                        let rect = extension_component_rect(&app, component, full);
                        let inset = u16::from(
                            component.overlay_options.overlay
                                && rect.width >= 2
                                && rect.height >= 3,
                        );
                        let local_row = mouse.row.checked_sub(rect.y.saturating_add(inset))?;
                        let local_column =
                            mouse.column.checked_sub(rect.x.saturating_add(inset))?;
                        app.component_hit(
                            &component.component_id,
                            component.generation,
                            local_row,
                            local_column,
                        )
                        .then(|| (component.component_id.clone(), component.generation))
                    });
                    if let Some((component_id, generation)) = component
                        && let Some(data) = raw_mouse(mouse.kind, mouse.column, mouse.row)
                    {
                        let active_path =
                            app.active_session_path().unwrap_or(session_path).to_owned();
                        request_extension_component_input(
                            &mut app,
                            pipe,
                            &active_path,
                            client_instance_id,
                            &mut request_sequence,
                            &component_id,
                            generation,
                            data,
                        )?;
                        state_changed = true;
                    } else if app.extension_ui.terminal_input_listener_count > 0
                        && app.input_focus == InputFocus::Composer
                        && let Some(data) = raw_mouse(mouse.kind, mouse.column, mouse.row)
                    {
                        let active_path =
                            app.active_session_path().unwrap_or(session_path).to_owned();
                        request_extension_terminal_input(
                            &mut app,
                            pipe,
                            &active_path,
                            client_instance_id,
                            &mut request_sequence,
                            data,
                        )?;
                        state_changed = true;
                    } else {
                        match mouse.kind {
                            MouseEventKind::ScrollUp => {
                                if let Some(view) = readonly_view_mut(&mut app) {
                                    view.transcript.scroll_by(-3);
                                } else {
                                    app.transcript.scroll_by(-3);
                                }
                                state_changed = true;
                            }
                            MouseEventKind::ScrollDown => {
                                if let Some(view) = readonly_view_mut(&mut app) {
                                    view.transcript.scroll_by(3);
                                } else {
                                    app.transcript.scroll_by(3);
                                }
                                state_changed = true;
                            }
                            _ => {}
                        }
                    }
                }
                Event::Resize(_columns, _rows) => {
                    terminal.autoresize()?;
                    app.invalidate_rich_text();
                    app.invalidate_images();
                    last_component_size = None;
                    state_changed = true;
                }
                _ => {}
            }
        } else if !handled_message {
            let pending_work = app.has_pending_work();
            if !pending_work {
                trace("idle_poll");
            }
            match pipe
                .inbound
                .recv_timeout(Duration::from_millis(if pending_work { 2 } else { 16 }))
            {
                Ok(message) => {
                    if let Err(error) = process_inbound_message(
                        &mut app,
                        message,
                        pipe,
                        session_path,
                        client_instance_id,
                        &mut request_sequence,
                        &mut session_flow,
                        &mut quit_requested,
                    ) {
                        clear_terminal_extension_output(
                            &mut app,
                            &mut terminal,
                            &mut image_sidecar,
                        )?;
                        return Err(error);
                    }
                    state_changed = true;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    app.clear_connection_state("Host 连接已断开");
                    clear_terminal_extension_output(&mut app, &mut terminal, &mut image_sidecar)?;
                    return Err(TuiError::ChildEof);
                }
            }
        }
        if !app.pending_terminal_inputs.is_empty() {
            let expired = app
                .pending_terminal_inputs
                .iter()
                .filter(|(_, pending)| pending.started_at.elapsed() >= EXTENSION_INPUT_TIMEOUT)
                .map(|(id, pending)| (id.clone(), pending.data.clone()))
                .collect::<Vec<_>>();
            for (id, data) in expired {
                app.pending_terminal_inputs.remove(&id);
                app.set_toast("终端输入 bridge 超时，已回退本地输入");
                let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
                if apply_extension_raw_input(
                    &mut app,
                    &data,
                    pipe,
                    &active_path,
                    client_instance_id,
                    &mut request_sequence,
                    &mut session_flow,
                    &mut quit_requested,
                )? {
                    quit_requested = true;
                }
                state_changed = true;
            }
        }
        for id in app.timed_out_component_inputs(EXTENSION_INPUT_TIMEOUT) {
            if let Some(pending) = app.take_component_input(&id) {
                if app.active_extension_editor().is_some_and(|component| {
                    component.component_id == pending.component_id
                        && component.generation == pending.generation
                }) {
                    app.set_toast("编辑器输入 bridge 超时，已回退本地输入");
                    let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
                    if apply_extension_raw_input(
                        &mut app,
                        &pending.data,
                        pipe,
                        &active_path,
                        client_instance_id,
                        &mut request_sequence,
                        &mut session_flow,
                        &mut quit_requested,
                    )? {
                        quit_requested = true;
                    }
                } else {
                    app.set_toast("组件输入 bridge 超时，可按 Esc 取消");
                }
                trace_id("component_input_timeout", &pending.component_id);
                state_changed = true;
            }
        }
        let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
        request_extension_editor_state(
            &mut app,
            pipe,
            &active_path,
            client_instance_id,
            &mut request_sequence,
        )?;
        if quit_requested && session_flow.is_none() {
            clear_terminal_extension_output(&mut app, &mut terminal, &mut image_sidecar)?;
            return Ok(());
        }
        if app.timed_out_workspace_request().is_some()
            || app.timed_out_custom_editor_submit().is_some()
            || app.timed_out_attachment_submit().is_some()
        {
            if !timeout_notified {
                app.set_timeout_notice();
                state_changed = true;
                timeout_notified = true;
            }
        } else {
            timeout_notified = false;
        }
        if app.transcript.needs_previous_page()
            || app.search.pending_jump.is_some() && !app.transcript.loading_previous
        {
            if let Some(cursor) = app.transcript.take_previous_cursor() {
                let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
                let context = TranscriptRequestContext {
                    generation: app.transcript.generation.clone(),
                    revision: Some(app.transcript.revision),
                    cursor: Some(cursor.clone()),
                };
                app.mark_page_load_pending();
                request_transcript(
                    &mut app,
                    pipe,
                    &active_path,
                    Some(cursor),
                    false,
                    Some(context),
                    TranscriptViewKind::Active,
                    &mut request_sequence,
                )?;
                state_changed = true;
            } else if app.search.pending_jump.is_some() {
                app.search.status = "目标不在当前可分页记录中".to_owned();
                app.search.pending_jump = None;
                state_changed = true;
            }
        }
        if let Some((path, cursor, context)) = app.readonly_view.as_mut().and_then(|view| {
            if view.transcript.needs_previous_page()
                || view.search.pending_jump.is_some() && !view.transcript.loading_previous
            {
                let cursor = view.transcript.take_previous_cursor()?;
                Some((
                    view.path.clone(),
                    cursor.clone(),
                    TranscriptRequestContext {
                        generation: view.transcript.generation.clone(),
                        revision: Some(view.transcript.revision),
                        cursor: Some(cursor),
                    },
                ))
            } else {
                None
            }
        }) {
            request_transcript(
                &mut app,
                pipe,
                &path,
                Some(cursor),
                false,
                Some(context),
                TranscriptViewKind::Readonly,
                &mut request_sequence,
            )?;
            state_changed = true;
        } else if let Some(view) = app.readonly_view.as_mut()
            && view.search.pending_jump.is_some()
            && !view.transcript.loading_previous
        {
            view.search.status = "目标不在当前可分页记录中".to_owned();
            view.search.pending_jump = None;
            state_changed = true;
        }
        if let Some(active_path) = app.active_session_path().map(str::to_owned) {
            let width = terminal.size()?.width.saturating_sub(3).clamp(1, 500);
            if request_visible_rich_text(
                &mut app,
                pipe,
                &active_path,
                width,
                &mut request_sequence,
            )? {
                state_changed = true;
            }
            if request_visible_images(&mut app, pipe, &active_path, &mut request_sequence)? {
                state_changed = true;
            }
        }
        dirty |= state_changed;
    }
}

#[cfg(not(unix))]
pub fn run_with_options(_session_path: &str, _options: RunOptions) -> Result<(), TuiError> {
    Err(TuiError::HelloRejected(
        "Windows named-pipe transport is not implemented".to_owned(),
    ))
}

#[cfg(not(unix))]
pub fn run(_session_path: &str) -> Result<(), TuiError> {
    run_with_options(_session_path, RunOptions::default())
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
pub(super) fn process_inbound_message(
    app: &mut AppState,
    message: Result<ServerMessage, TuiError>,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    request_sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<(), TuiError> {
    let message = message?;
    if apply_server_message(
        app,
        &message,
        session_path,
        pipe,
        client_instance_id,
        request_sequence,
        session_flow,
        quit_requested,
    )? {
        let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
        app.mark_page_load_pending();
        request_transcript(
            app,
            pipe,
            &active_path,
            None,
            true,
            None,
            TranscriptViewKind::Active,
            request_sequence,
        )?;
    }
    Ok(())
}
