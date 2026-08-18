use super::*;

pub(in super::super) fn apply_response(
    app: &mut AppState,
    response: &ReadOnlyResponse,
) -> Result<bool, TuiError> {
    match response {
        ReadOnlyResponse::Error { id, message } => {
            let Some(pending) = app.take_transcript_request(id) else {
                return Ok(false);
            };
            match pending.view {
                TranscriptViewKind::Active
                    if pending.generation == app.session_generation
                        && app.active_session_path() == Some(pending.session_path.as_str()) =>
                {
                    app.clear_page_load_pending();
                    app.transcript.status = message.clone();
                    app.transcript.loading_previous = false;
                }
                TranscriptViewKind::Readonly => {
                    if let Some(view) = app.readonly_view.as_mut()
                        && view.path == pending.session_path
                        && view.generation == pending.generation
                    {
                        view.status = message.clone();
                        view.transcript.status = message.clone();
                        view.transcript.loading_previous = false;
                        refresh_readonly_overlay(app);
                    }
                }
                _ => {}
            }
        }
        ReadOnlyResponse::TranscriptPage { id, page } => {
            let Some(pending) = app.take_transcript_request(id) else {
                return Ok(false);
            };
            if !matches!(
                pending.kind,
                TranscriptRequestKind::Initial | TranscriptRequestKind::Older
            ) {
                return Ok(false);
            }
            match pending.view {
                TranscriptViewKind::Active
                    if pending.generation == app.session_generation
                        && app.active_session_path() == Some(pending.session_path.as_str()) =>
                {
                    trace_id("page_apply_start", id);
                    if !page.complete {
                        app.clear_for_reload("记录页未完整返回，正在重新读取");
                        trace("reload_requested");
                        trace_id("page_apply_end", id);
                        return Ok(true);
                    }
                    if pending.kind == TranscriptRequestKind::Initial {
                        app.clear_page_load_pending();
                        app.transcript.replace_page(
                            page.items.clone(),
                            page.transcript_generation.clone(),
                            page.transcript_revision,
                            page.previous_cursor.clone(),
                        );
                    } else if app.transcript.accepts_previous_page(
                        &page.transcript_generation,
                        page.transcript_revision,
                        pending
                            .context
                            .as_ref()
                            .and_then(|value| value.generation.as_deref()),
                        pending.context.as_ref().and_then(|value| value.revision),
                    ) {
                        app.clear_page_load_pending();
                        app.transcript
                            .prepend_page(page.items.clone(), page.previous_cursor.clone());
                        app.resolve_pending_jump();
                    } else {
                        app.clear_for_reload("更早记录已过期，正在重新读取");
                        trace("reload_requested");
                        trace_id("page_apply_end", id);
                        return Ok(true);
                    }
                    trace_id("page_apply_end", id);
                    trace("page_applied");
                }
                TranscriptViewKind::Readonly => {
                    trace_id("page_apply_start", id);
                    let Some(view) = app.readonly_view.as_mut() else {
                        return Ok(false);
                    };
                    if view.path != pending.session_path || view.generation != pending.generation {
                        return Ok(false);
                    }
                    if !page.complete {
                        view.transcript.clear_for_reload("记录页未完整返回");
                    } else if pending.kind == TranscriptRequestKind::Initial {
                        view.transcript.replace_page(
                            page.items.clone(),
                            page.transcript_generation.clone(),
                            page.transcript_revision,
                            page.previous_cursor.clone(),
                        );
                    } else if view.transcript.accepts_previous_page(
                        &page.transcript_generation,
                        page.transcript_revision,
                        pending
                            .context
                            .as_ref()
                            .and_then(|value| value.generation.as_deref()),
                        pending.context.as_ref().and_then(|value| value.revision),
                    ) {
                        view.transcript
                            .prepend_page(page.items.clone(), page.previous_cursor.clone());
                        if let Some(entry_id) = view.search.pending_jump.clone()
                            && view.transcript.jump_to(&entry_id)
                        {
                            view.search.pending_jump = None;
                            view.search.status = "已跳转".to_owned();
                        }
                    } else {
                        view.transcript.clear_for_reload("更早记录已过期");
                    }
                    view.status = format!("{} 轮", view.transcript.cached_rounds());
                    refresh_readonly_overlay(app);
                    trace_id("page_apply_end", id);
                    trace("page_applied");
                }
                _ => {}
            }
        }
        ReadOnlyResponse::SearchResult { id, result } => {
            let Some(pending) = app.take_transcript_request(id) else {
                return Ok(false);
            };
            if pending.kind != TranscriptRequestKind::Search {
                return Ok(false);
            }
            let hits = result
                .hits
                .iter()
                .map(|hit| SearchHit {
                    entry_id: hit.entry_id.clone(),
                    kind: hit.kind.clone(),
                    timestamp: hit.timestamp.clone(),
                    snippet: hit.snippet.clone(),
                })
                .collect();
            match pending.view {
                TranscriptViewKind::Active
                    if pending.generation == app.session_generation
                        && app.active_session_path() == Some(pending.session_path.as_str()) =>
                {
                    app.set_search_results(hits);
                    trace("search_applied");
                }
                TranscriptViewKind::Readonly => {
                    if let Some(view) = app.readonly_view.as_mut()
                        && view.path == pending.session_path
                        && view.generation == pending.generation
                    {
                        view.search.selected = 0;
                        view.search.hits = hits;
                        view.search.status = format!("{} 个结果", view.search.hits.len());
                        refresh_readonly_overlay(app);
                        trace("search_applied");
                    }
                }
                _ => {}
            }
        }
        ReadOnlyResponse::Operation {
            operation,
            duplicate,
            ..
        } => {
            app.apply_operation(operation.clone());
            if *duplicate {
                app.transcript.status = "已确认已有请求".to_owned();
            }
        }
        ReadOnlyResponse::SessionLease { .. } | ReadOnlyResponse::Other { .. } => {}
    }
    Ok(false)
}

pub(in super::super) fn apply_event(
    app: &mut AppState,
    event: &ReadOnlyEvent,
    session_path: &str,
) -> Result<bool, TuiError> {
    match event {
        ReadOnlyEvent::TranscriptChanged {
            session_path: event_path,
        } if event_path == session_path => {
            trace("transcript_changed");
            app.clear_for_reload("记录已重写，正在重新读取");
            trace("reload_requested");
            Ok(true)
        }
        ReadOnlyEvent::TranscriptCommitted {
            session_path: event_path,
            transcript_generation,
            from_revision,
            to_revision,
            items,
        } if event_path == session_path => {
            trace("transcript_committed");
            if !app.transcript.append_committed(
                transcript_generation,
                *from_revision,
                *to_revision,
                items.clone(),
            ) {
                app.clear_for_reload("记录版本不连续，正在重新读取");
                trace("reload_requested");
                return Ok(true);
            }
            app.invalidate_rich_text();
            app.invalidate_images();
            app.clear_live_after_commit(items);
            app.transcript.streaming_preview = None;
            trace("append_applied");
            Ok(false)
        }
        ReadOnlyEvent::SessionProgress {
            session_path: event_path,
            progress,
        } if event_path == session_path => {
            app.apply_progress(progress.clone());
            Ok(false)
        }
        ReadOnlyEvent::SessionSnapshot { snapshot } if snapshot.path == session_path => {
            if !app.defers_session_snapshot(&snapshot.path) {
                app.apply_snapshot(snapshot.clone());
            }
            Ok(false)
        }
        ReadOnlyEvent::OperationUpdated { operation } if operation.session_path == session_path => {
            app.apply_operation(operation.clone());
            Ok(false)
        }
        ReadOnlyEvent::TranscriptChanged { .. }
        | ReadOnlyEvent::TranscriptCommitted { .. }
        | ReadOnlyEvent::SessionProgress { .. }
        | ReadOnlyEvent::SessionSnapshot { .. }
        | ReadOnlyEvent::OperationUpdated { .. }
        | ReadOnlyEvent::Other => Ok(false),
    }
}
