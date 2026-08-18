use super::*;

pub(in super::super) fn apply_session_flow(
    app: &mut AppState,
    raw: &serde_json::Value,
    pipe: &mut ProtocolPipe,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<Option<bool>, TuiError> {
    let Some(id) = raw.get("id").and_then(serde_json::Value::as_str) else {
        return Ok(None);
    };
    let Some(flow) = session_flow.take() else {
        return Ok(None);
    };
    let expected = match &flow {
        SessionFlow::InitialAcquiring { id, .. }
        | SessionFlow::List { id, .. }
        | SessionFlow::Rename { id, .. }
        | SessionFlow::Fork { id, .. }
        | SessionFlow::Import { id, .. }
        | SessionFlow::Readonly { id, .. }
        | SessionFlow::SwitchReleasing { id, .. }
        | SessionFlow::SwitchAcquiring { id, .. }
        | SessionFlow::SwitchRollback { id, .. }
        | SessionFlow::CreateStarting { id, .. }
        | SessionFlow::CreateReleasingOld { id, .. }
        | SessionFlow::CreateCleanup { id, .. }
        | SessionFlow::DeleteReleasing { id, .. }
        | SessionFlow::DeleteRemoving { id, .. }
        | SessionFlow::DeleteAcquiring { id, .. }
        | SessionFlow::DeleteRollback { id, .. }
        | SessionFlow::QuitReleasing { id, .. } => id,
    };
    if id != expected {
        *session_flow = Some(flow);
        return Ok(None);
    }
    let success = raw.get("ok").and_then(serde_json::Value::as_bool) == Some(true);
    let error = raw
        .get("error")
        .and_then(|value| value.get("message"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("会话操作失败")
        .to_owned();
    let result = raw
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    match flow {
        SessionFlow::InitialAcquiring {
            path, generation, ..
        } => {
            if !success {
                app.clear_active_lease();
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            if app.active_session_path() != Some(path.as_str())
                || app.session_generation != generation
            {
                return Ok(Some(false));
            }
            let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
            if *quit_requested {
                *sequence += 1;
                let id = format!("quit-release-{sequence}");
                *session_flow = Some(SessionFlow::QuitReleasing { id: id.clone() });
                pipe.request(&encode_release_session_request(
                    &id,
                    &snapshot.path,
                    &lease_id,
                )?)?;
                return Ok(Some(false));
            }
            app.apply_active_lease(lease_id, snapshot);
            app.transcript.status = "已获取会话租约".to_owned();
            Ok(Some(false))
        }
        SessionFlow::List { selected_path, .. } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            app.sessions = parse_sessions(&result)?;
            app.replace_overlay(session_overlay(
                &app.sessions,
                selected_path.as_deref(),
                OverlayOrigin::User,
            ));
            Ok(Some(false))
        }
        SessionFlow::Rename { index, name, .. } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            if let Some(session) = app.sessions.get_mut(index) {
                session.name = (!name.trim().is_empty()).then_some(name);
            }
            app.replace_overlay(session_overlay(
                &app.sessions,
                app.active_session_path(),
                OverlayOrigin::User,
            ));
            app.set_toast("已重命名会话");
            Ok(Some(false))
        }
        SessionFlow::Fork { toast, .. } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
            app.commit_session_switch(snapshot.path.clone(), lease_id, snapshot);
            app.set_toast(toast);
            Ok(Some(true))
        }
        SessionFlow::Import { input_path, .. } => {
            if !success {
                let error_code = raw
                    .get("error")
                    .and_then(|value| value.get("code"))
                    .and_then(serde_json::Value::as_str);
                if error_code == Some("missing_session_cwd") {
                    let details = raw
                        .get("error")
                        .and_then(|value| value.get("details"))
                        .and_then(serde_json::Value::as_object)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse("导入缺少工作目录详情".to_owned())
                        })?;
                    let session_cwd = required_string(details, "sessionCwd")?;
                    let fallback_cwd = required_string(details, "fallbackCwd")?;
                    app.pending_session_import = Some(PendingSessionImport {
                        input_path,
                        cwd_override: Some(fallback_cwd.clone()),
                    });
                    app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                        title: "找不到会话工作目录".to_owned(),
                        message: format!(
                            "会话文件中的工作目录不存在\n{session_cwd}\n\n是否在当前目录继续\n{fallback_cwd}"
                        ),
                        confirm_action: "session-import-cwd-confirm".to_owned(),
                        status: String::new(),
                    }));
                } else {
                    app.pending_session_import = None;
                    app.set_overlay_error(format!("导入会话失败：{error}"));
                }
                return Ok(Some(false));
            }
            if result.get("cancelled").and_then(serde_json::Value::as_bool) == Some(true) {
                app.pending_session_import = None;
                app.set_toast("导入已取消");
                return Ok(Some(false));
            }
            let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
            app.pending_session_import = None;
            app.commit_session_switch(snapshot.path.clone(), lease_id, snapshot);
            app.set_toast(format!("已从 {input_path} 导入会话"));
            Ok(Some(true))
        }
        SessionFlow::Readonly {
            path,
            replace,
            generation,
            ..
        } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            let Some(pending) = app.take_transcript_request(id) else {
                return Ok(Some(false));
            };
            if pending.view != TranscriptViewKind::Readonly
                || pending.generation != generation
                || pending.session_path != path
            {
                return Ok(Some(false));
            }
            let page: lystar_protocol::TranscriptPage = serde_json::from_value(result)
                .map_err(|error| TuiError::InvalidResponse(format!("只读记录响应无效: {error}")))?;
            let view_snapshot = {
                let view = app
                    .readonly_view
                    .get_or_insert_with(|| ReadonlySessionView {
                        path: path.clone(),
                        ..ReadonlySessionView::default()
                    });
                if view.path != path || view.generation != generation {
                    return Ok(Some(false));
                }
                if replace {
                    view.transcript.replace_page(
                        page.items,
                        page.transcript_generation,
                        page.transcript_revision,
                        page.previous_cursor,
                    );
                } else {
                    view.transcript
                        .prepend_page(page.items, page.previous_cursor);
                }
                view.status = format!("{} 轮", view.transcript.cached_rounds());
                view.clone()
            };
            app.replace_overlay(readonly_overlay(&view_snapshot));
            Ok(Some(false))
        }
        SessionFlow::SwitchReleasing {
            target, restore, ..
        } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            app.clear_active_lease();
            *sequence += 1;
            let id = format!("session-acquire-{sequence}");
            *session_flow = Some(SessionFlow::SwitchAcquiring {
                id: id.clone(),
                target: target.clone(),
                restore,
            });
            pipe.request(&encode_acquire_session_request(
                &id,
                &target.path,
                client_instance_id,
            )?)?;
            Ok(Some(false))
        }
        SessionFlow::SwitchAcquiring {
            target, restore, ..
        } => {
            if success {
                let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
                if *quit_requested {
                    *sequence += 1;
                    let id = format!("quit-release-{sequence}");
                    *session_flow = Some(SessionFlow::QuitReleasing { id: id.clone() });
                    pipe.request(&encode_release_session_request(
                        &id,
                        &snapshot.path,
                        &lease_id,
                    )?)?;
                    return Ok(Some(false));
                }
                app.commit_session_switch(target.path, lease_id, snapshot);
                app.set_toast("已切换会话");
                return Ok(Some(true));
            }
            let mut restore_for_reacquire = restore.clone();
            let old_path = restore_for_reacquire
                .context
                .as_ref()
                .map(|context| context.path.clone())
                .ok_or_else(|| TuiError::InvalidResponse("切换缺少原会话".to_owned()))?;
            if let Some(context) = &mut restore_for_reacquire.context {
                context.lease_id = None;
            }
            restore_for_reacquire.lease_id = None;
            app.restore_session(restore_for_reacquire);
            *sequence += 1;
            let id = format!("session-rollback-{sequence}");
            *session_flow = Some(SessionFlow::SwitchRollback {
                id: id.clone(),
                restore,
                reason: error,
            });
            pipe.request(&encode_acquire_session_request(
                &id,
                &old_path,
                client_instance_id,
            )?)?;
            Ok(Some(false))
        }
        SessionFlow::SwitchRollback {
            restore, reason, ..
        } => {
            if success {
                let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
                app.restore_session(restore);
                app.apply_active_lease(lease_id, snapshot);
                app.set_overlay_error(format!("切换失败，已恢复原会话: {reason}"));
            } else {
                app.clear_active_session("切换失败且原会话恢复失败");
                app.replace_overlay(session_overlay(
                    &app.sessions,
                    None,
                    OverlayOrigin::RecoverySession,
                ));
                app.set_overlay_error(format!("切换失败且原会话恢复失败: {error}"));
            }
            Ok(Some(false))
        }
        SessionFlow::CreateStarting { restore, .. } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
            let old = restore
                .context
                .as_ref()
                .and_then(|context| context.lease_id.clone());
            let old_path = restore.context.as_ref().map(|context| context.path.clone());
            if let (Some(old_lease), Some(old_path)) = (old, old_path) {
                *sequence += 1;
                let id = format!("session-create-release-{sequence}");
                *session_flow = Some(SessionFlow::CreateReleasingOld {
                    id: id.clone(),
                    path: snapshot.path.clone(),
                    lease_id,
                    snapshot,
                    restore,
                });
                pipe.request(&encode_release_session_request(&id, &old_path, &old_lease)?)?;
                Ok(Some(false))
            } else {
                app.commit_session_switch(snapshot.path.clone(), lease_id, snapshot);
                app.set_toast("已新建会话");
                Ok(Some(true))
            }
        }
        SessionFlow::CreateReleasingOld {
            path,
            lease_id,
            snapshot,
            restore,
            ..
        } => {
            if success {
                app.clear_active_lease();
                app.commit_session_switch(path, lease_id, snapshot);
                app.set_toast("已新建会话");
                return Ok(Some(true));
            }
            *sequence += 1;
            let id = format!("session-create-cleanup-{sequence}");
            *session_flow = Some(SessionFlow::CreateCleanup {
                id: id.clone(),
                restore,
                reason: error,
            });
            pipe.request(&encode_release_session_request(
                &id,
                &snapshot.path,
                &lease_id,
            )?)?;
            Ok(Some(false))
        }
        SessionFlow::CreateCleanup {
            restore, reason, ..
        } => {
            app.restore_session(restore);
            app.set_overlay_error(format!("新建会话后无法释放原会话: {reason}"));
            Ok(Some(false))
        }
        SessionFlow::DeleteReleasing {
            restore, target, ..
        } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            app.clear_active_lease();
            let path = restore
                .context
                .as_ref()
                .map(|context| context.path.clone())
                .ok_or_else(|| TuiError::InvalidResponse("删除缺少会话路径".to_owned()))?;
            let cwd = restore
                .context
                .as_ref()
                .map(|context| context.cwd.clone())
                .unwrap_or_default();
            *sequence += 1;
            let id = format!("session-delete-{sequence}");
            *session_flow = Some(SessionFlow::DeleteRemoving {
                id: id.clone(),
                restore,
                target,
            });
            pipe.request(&encode_session_write_request(
                &id,
                "delete_session",
                serde_json::json!({
                    "cwd": cwd, "sessionPath": path,
                    "clientInstanceId": client_instance_id,
                    "clientRequestId": format!("delete:{sequence}"),
                })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            )?)?;
            Ok(Some(false))
        }
        SessionFlow::DeleteRemoving {
            restore, target, ..
        } => {
            if !success {
                let path = restore
                    .context
                    .as_ref()
                    .map(|context| context.path.clone())
                    .unwrap_or_default();
                *sequence += 1;
                let id = format!("session-delete-rollback-{sequence}");
                *session_flow = Some(SessionFlow::DeleteRollback {
                    id: id.clone(),
                    restore,
                    reason: error,
                });
                pipe.request(&encode_acquire_session_request(
                    &id,
                    &path,
                    client_instance_id,
                )?)?;
                return Ok(Some(false));
            }
            let Some(target) = target else {
                app.clear_active_session("当前会话已删除");
                app.clear_overlay_transient();
                return Ok(Some(false));
            };
            *sequence += 1;
            let id = format!("session-delete-acquire-{sequence}");
            *session_flow = Some(SessionFlow::DeleteAcquiring {
                id: id.clone(),
                target: target.clone(),
            });
            pipe.request(&encode_acquire_session_request(
                &id,
                &target.path,
                client_instance_id,
            )?)?;
            Ok(Some(false))
        }
        SessionFlow::DeleteAcquiring { target, .. } => {
            if !success {
                app.clear_active_session("当前会话已删除，无法切换目标会话");
                app.replace_overlay(session_overlay(
                    &app.sessions,
                    None,
                    OverlayOrigin::RecoverySession,
                ));
                app.set_overlay_error(format!("当前会话已删除，无法切换目标会话: {error}"));
                return Ok(Some(false));
            }
            let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
            app.commit_session_switch(target.path, lease_id, snapshot);
            app.set_toast("已删除会话并切换");
            Ok(Some(true))
        }
        SessionFlow::DeleteRollback {
            restore, reason, ..
        } => {
            if success {
                let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
                app.restore_session(restore);
                app.apply_active_lease(lease_id, snapshot);
                app.set_overlay_error(format!("删除失败，已恢复原会话: {reason}"));
            } else {
                app.clear_active_session("删除失败且原会话恢复失败");
                app.replace_overlay(session_overlay(
                    &app.sessions,
                    None,
                    OverlayOrigin::RecoverySession,
                ));
                app.set_overlay_error(format!("删除失败且原会话恢复失败: {error}"));
            }
            Ok(Some(false))
        }
        SessionFlow::QuitReleasing { .. } => {
            if !success {
                app.set_overlay_error(format!("退出时释放会话失败: {error}"));
            }
            app.clear_active_lease();
            *quit_requested = true;
            Ok(Some(false))
        }
    }
}

pub(in super::super) fn parse_lease_snapshot(
    result: &serde_json::Value,
) -> Result<(String, lystar_protocol::SessionSnapshot), TuiError> {
    let lease_id = result
        .get("lease")
        .and_then(|lease| lease.get("leaseId"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| TuiError::InvalidResponse("会话响应缺少 leaseId".to_owned()))?;
    let snapshot = serde_json::from_value(
        result
            .get("snapshot")
            .cloned()
            .ok_or_else(|| TuiError::InvalidResponse("会话响应缺少 snapshot".to_owned()))?,
    )
    .map_err(|error| TuiError::InvalidResponse(format!("会话状态响应无效: {error}")))?;
    Ok((lease_id, snapshot))
}
