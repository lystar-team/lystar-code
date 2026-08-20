use super::*;

pub(in super::super) fn is_readonly_overlay(app: &AppState) -> bool {
    matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "会话只读")
}

pub(in super::super) fn readonly_view_mut(app: &mut AppState) -> Option<&mut ReadonlySessionView> {
    is_readonly_overlay(app)
        .then_some(app.readonly_view.as_mut())
        .flatten()
}

pub(in super::super) fn refresh_readonly_overlay(app: &mut AppState) {
    if let Some(view) = app.readonly_view.clone()
        && is_readonly_overlay(app)
    {
        app.replace_overlay(readonly_overlay(&view));
    }
}

pub(in super::super) fn handle_readonly_key(
    app: &mut AppState,
    code: KeyCode,
    modifiers: KeyModifiers,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
) -> Result<bool, TuiError> {
    let mut search_request = None;
    let mut close_view = false;
    if let Some(view) = readonly_view_mut(app) {
        if view.search.open {
            match code {
                KeyCode::Esc => view.search.open = false,
                KeyCode::Enter => {
                    if view.search.query.trim().is_empty() {
                        view.search.status = "请输入搜索内容".to_owned();
                    } else if let Some(entry_id) = view
                        .search
                        .hits
                        .get(view.search.selected)
                        .map(|hit| hit.entry_id.clone())
                    {
                        if view.transcript.jump_to(&entry_id) {
                            view.search.status = "已跳转".to_owned();
                        } else {
                            view.search.pending_jump = Some(entry_id);
                            view.search.status = "正在加载目标记录".to_owned();
                        }
                    } else {
                        search_request = Some((view.path.clone(), view.search.query.clone()));
                    }
                }
                KeyCode::Up => view.search.selected = view.search.selected.saturating_sub(1),
                KeyCode::Down => {
                    view.search.selected =
                        (view.search.selected + 1).min(view.search.hits.len().saturating_sub(1));
                }
                KeyCode::Backspace => {
                    view.search.query.pop();
                    view.search.hits.clear();
                    view.search.selected = 0;
                }
                KeyCode::Char(character) if !modifiers.contains(KeyModifiers::CONTROL) => {
                    view.search.query.push(character);
                    view.search.hits.clear();
                    view.search.selected = 0;
                }
                _ => {}
            }
        } else {
            match code {
                KeyCode::Esc => close_view = true,
                KeyCode::Char('f') if modifiers.contains(KeyModifiers::CONTROL) => {
                    view.search.open = true;
                    view.search.status.clear();
                }
                KeyCode::Char('o') if modifiers.contains(KeyModifiers::CONTROL) => {
                    view.transcript.toggle_current_tool();
                }
                KeyCode::Up => view.transcript.scroll_by(-1),
                KeyCode::Down => view.transcript.scroll_by(1),
                KeyCode::PageUp => view.transcript.scroll_by(-20),
                KeyCode::PageDown => view.transcript.scroll_by(20),
                KeyCode::Home => {
                    view.transcript.current = 0;
                    view.transcript.scroll = 0;
                }
                KeyCode::End => {
                    let last = view.transcript.cached_rounds().saturating_sub(1);
                    view.transcript.current = last;
                    view.transcript.scroll = last;
                }
                _ => {}
            }
        }
    }
    if close_view {
        app.readonly_view = None;
        app.invalidate_transcript_requests(TranscriptViewKind::Readonly);
        app.close_overlay();
        return Ok(false);
    }
    if let Some((path, query)) = search_request {
        request_search(
            app,
            pipe,
            &path,
            &query,
            TranscriptViewKind::Readonly,
            sequence,
        )?;
    }
    refresh_readonly_overlay(app);
    Ok(false)
}
