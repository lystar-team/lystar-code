use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_extension_input_response(
    app: &mut AppState,
    raw: &serde_json::Value,
    session_path: &str,
    pipe: &mut ProtocolPipe,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<Option<bool>, TuiError> {
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && let Some(pending) = app.take_component_input(id)
    {
        let invalid_lease = raw
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(serde_json::Value::as_str)
            == Some("invalid_session_lease");
        if raw.get("ok").and_then(serde_json::Value::as_bool) != Some(true)
            || raw
                .get("result")
                .and_then(|result| result.get("accepted"))
                .and_then(serde_json::Value::as_bool)
                != Some(true)
        {
            if invalid_lease {
                app.clear_active_lease();
                app.clear_extension_components();
                app.set_toast("组件输入租约已失效，已清除待处理输入");
            } else {
                app.set_toast("组件输入被 Host 拒绝，可按 Esc 取消");
            }
        } else {
            if let Some(editor_action) = raw
                .get("result")
                .and_then(|result| result.get("editorAction"))
                .and_then(serde_json::Value::as_object)
            {
                let action = editor_action
                    .get("action")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("组件输入编辑器动作无效".to_owned())
                    })?;
                let text = editor_action
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("组件输入编辑器动作缺少文本".to_owned())
                    })?;
                let revision = editor_action
                    .get("revision")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("组件输入编辑器动作缺少修订".to_owned())
                    })?;
                if !app.apply_extension_editor_action_from_component_input(action, text, revision) {
                    return Err(TuiError::InvalidResponse(
                        "组件输入编辑器动作无效".to_owned(),
                    ));
                }
            }
            trace_id("component_input_accepted", &pending.component_id);
            if let Some(action) = raw
                .get("result")
                .and_then(|result| result.get("appAction"))
                .and_then(serde_json::Value::as_str)
            {
                apply_extension_editor_app_action(
                    app,
                    action,
                    pipe,
                    session_path,
                    client_instance_id,
                    sequence,
                    session_flow,
                    quit_requested,
                )?;
            }
        }
        return Ok(Some(false));
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && id.starts_with("component-cancel-")
        && raw.get("ok").and_then(serde_json::Value::as_bool) != Some(true)
    {
        app.set_toast("组件取消失败，可重试或退出");
        return Ok(Some(false));
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && let Some(pending) = app.pending_terminal_inputs.remove(id)
    {
        let invalid_lease = raw
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(serde_json::Value::as_str)
            == Some("invalid_session_lease");
        if raw.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
            if invalid_lease {
                app.clear_active_lease();
                app.clear_extension_components();
                app.set_toast("终端输入租约已失效，未执行回退输入");
            } else {
                app.set_toast("终端输入被 Host 拒绝");
            }
            return Ok(Some(false));
        }
        trace_id("extension_input_applied", id);
        let consume = raw
            .get("result")
            .and_then(|result| result.get("consume"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if !consume {
            let data = raw
                .get("result")
                .and_then(|result| result.get("data"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&pending.data);
            if apply_extension_raw_input(
                app,
                data,
                pipe,
                session_path,
                client_instance_id,
                sequence,
                session_flow,
                quit_requested,
            )? {
                *quit_requested = true;
            }
        }
        return Ok(Some(false));
    }
    Ok(None)
}
