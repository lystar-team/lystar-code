use super::*;

pub(super) fn apply_interaction_response(
    app: &mut AppState,
    raw: &serde_json::Value,
    pipe: &mut ProtocolPipe,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<Option<bool>, TuiError> {
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && app
            .pending_bash_submit
            .as_ref()
            .is_some_and(|submit| submit.response_id == id && submit.operation_id.is_none())
    {
        if raw.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
            && let Some(operation_id) = queue_operation_id(raw)
        {
            app.accept_bash_submit(id, operation_id.to_owned());
        } else {
            let message = raw
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Shell 请求响应无效")
                .to_owned();
            app.reject_bash_submit(id);
            app.set_overlay_error(message);
            return Ok(Some(false));
        }
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && app.pending_custom_editor_submits.contains_key(id)
    {
        if raw.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
            if let Some(operation_id) = queue_operation_id(raw) {
                app.acknowledge_custom_editor_submit(id, operation_id.to_owned());
            } else {
                app.reject_custom_editor_submit(id);
            }
        } else {
            app.reject_custom_editor_submit(id);
            return Ok(Some(false));
        }
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && app.pending_attachment_submits.contains_key(id)
    {
        if raw.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
            app.acknowledge_attachment_submit(id);
        } else {
            app.reject_attachment_submit(id);
        }
        return Ok(Some(false));
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("event")
        && raw
            .get("event")
            .and_then(|value| value.get("type"))
            .and_then(serde_json::Value::as_str)
            == Some("ui_request")
    {
        let event = raw
            .get("event")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| TuiError::InvalidResponse("ui_request 缺少事件内容".to_owned()))?;
        let id = event
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| TuiError::InvalidResponse("ui_request 缺少 id".to_owned()))?;
        let payload = event
            .get("payload")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let title = event
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("需要输入");
        let kind = match event.get("kind").and_then(serde_json::Value::as_str) {
            Some("select") => UiRequestKind::Select,
            Some("confirm") => UiRequestKind::Confirm,
            Some("input") => UiRequestKind::Input,
            Some("secret") => UiRequestKind::Secret,
            Some("editor") => UiRequestKind::Editor,
            Some("notify") => {
                if app.mark_ui_responded(id) {
                    let detail = OverlayState::Detail(ui_notify_detail(title, &payload));
                    let auth_notification = event
                        .get("operationId")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|operation_id| {
                            operation_id.starts_with("models-auth:")
                                || app.operation.as_ref().is_some_and(|operation| {
                                    operation.operation_id == operation_id
                                        && operation.operation_type == "login_model_provider"
                                })
                        });
                    if auth_notification && app.active_ui_request.is_some() {
                        trace("ui_notify_deferred");
                    } else if auth_notification
                        && app
                            .overlay()
                            .is_some_and(|overlay| !matches!(overlay.title(), "登录" | "退出登录"))
                    {
                        app.replace_overlay(detail);
                    } else {
                        app.open_overlay(detail);
                    }
                    trace("ui_notify");
                }
                return Ok(Some(false));
            }
            Some(kind) => {
                let message = format!("不支持的输入类型: {kind}");
                app.set_overlay_error(message.clone());
                app.transcript.status = message;
                if app.cancel_unknown_ui_request(id) {
                    pipe.request(&encode_ui_response(id, None, None, Some(true))?)?;
                }
                return Ok(Some(false));
            }
            None => {
                app.set_overlay_error("输入请求缺少类型");
                app.transcript.status = "输入请求缺少类型".to_owned();
                if app.cancel_unknown_ui_request(id) {
                    pipe.request(&encode_ui_response(id, None, None, Some(true))?)?;
                }
                return Ok(Some(false));
            }
        };
        if !app.register_ui_request(UiRequest {
            id: id.to_owned(),
            kind,
        }) {
            return Ok(Some(false));
        }
        match kind {
            UiRequestKind::Select => app.open_overlay(OverlayState::List(ListOverlay {
                title: title.to_owned(),
                origin: OverlayOrigin::User,
                items: ui_select_items(&payload),
                selected: 0,
                filter: String::new(),
                status: "方向键选择，Enter 提交，Esc 取消".to_owned(),
            })),
            UiRequestKind::Confirm => app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                title: title.to_owned(),
                message: payload
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("确认继续此操作？")
                    .to_owned(),
                confirm_action: "ui:confirm".to_owned(),
                status: String::new(),
            })),
            UiRequestKind::Input | UiRequestKind::Secret | UiRequestKind::Editor => {
                let value = payload
                    .get("value")
                    .or_else(|| payload.get("prefill"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
                    title: title.to_owned(),
                    cursor: value.len(),
                    value,
                    save_action: "ui:input".to_owned(),
                    status: "Enter 提交，Esc 取消".to_owned(),
                    secret: kind == UiRequestKind::Secret,
                }));
            }
        }
        return Ok(Some(false));
    }
    if let Some(outcome) = apply_session_flow(
        app,
        raw,
        pipe,
        client_instance_id,
        sequence,
        session_flow,
        quit_requested,
    )? {
        return Ok(Some(outcome));
    }
    Ok(None)
}
