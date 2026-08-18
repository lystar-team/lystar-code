use super::*;

pub(super) fn handle_settings_actions(
    app: &mut AppState,
    action: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    _session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    if let Some(id) = action.strip_prefix("setting-toggle:") {
        let Some(setting) = app.setting(id).cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        let Some(value) = setting.value.as_bool() else {
            app.set_overlay_error("设置类型不匹配");
            return Ok(());
        };
        let (filter, _) = list_context(app, "设置");
        return request_setting_write(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            id,
            serde_json::Value::Bool(!value),
            filter,
        );
    }
    if let Some(id) = action.strip_prefix("setting-enum:") {
        let Some(setting) = app.setting(id).cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        if setting.read_only {
            app.set_overlay_error("此设置为只读");
            return Ok(());
        }
        app.open_overlay(OverlayState::List(ListOverlay {
            title: format!("{} 选项", setting.label),
            origin: OverlayOrigin::User,
            items: setting
                .options
                .iter()
                .enumerate()
                .map(|(index, value)| OverlayItem {
                    label: value.clone(),
                    detail: if setting.value.as_str() == Some(value) {
                        "当前".to_owned()
                    } else {
                        String::new()
                    },
                    action: format!("setting-option:{id}:{index}"),
                })
                .collect(),
            selected: setting
                .options
                .iter()
                .position(|value| setting.value.as_str() == Some(value))
                .unwrap_or(0),
            filter: String::new(),
            status: "Enter 保存，Esc 返回".to_owned(),
        }));
        return Ok(());
    }
    if let Some(pair) = action.strip_prefix("setting-option:") {
        let Some((id, index)) = pair.rsplit_once(':') else {
            app.set_overlay_error("设置选项无效");
            return Ok(());
        };
        let Ok(index) = index.parse::<usize>() else {
            app.set_overlay_error("设置选项无效");
            return Ok(());
        };
        let Some(setting) = app.setting(id).cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        let Some(value) = setting.options.get(index).cloned() else {
            app.set_overlay_error("设置选项无效");
            return Ok(());
        };
        app.close_overlay();
        let (filter, _) = list_context(app, "设置");
        return request_setting_write(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            id,
            serde_json::Value::String(value),
            filter,
        );
    }
    if let Some(id) = action.strip_prefix("setting-text:") {
        let Some(setting) = app.setting(id).cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        if !matches!(app.overlay(), Some(OverlayState::TextEditor(_))) {
            let value = match &setting.value {
                serde_json::Value::String(value) => value.clone(),
                serde_json::Value::Number(value) => value.to_string(),
                _ => String::new(),
            };
            app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
                title: setting.label,
                cursor: value.len(),
                value,
                save_action: action.to_owned(),
                status: match (setting.minimum, setting.maximum) {
                    (Some(minimum), Some(maximum)) => {
                        format!("输入范围 {minimum}..{maximum}，Enter 保存，Esc 返回")
                    }
                    _ => "Enter 保存，Esc 返回".to_owned(),
                },
                secret: false,
            }));
            return Ok(());
        }
        let value = match app.overlay() {
            Some(OverlayState::TextEditor(editor)) => editor.value.clone(),
            _ => String::new(),
        };
        let value = if setting.kind == "integer" {
            let Ok(value) = value.parse::<i64>() else {
                app.set_overlay_error("请输入整数");
                return Ok(());
            };
            if setting.minimum.is_some_and(|minimum| value < minimum)
                || setting.maximum.is_some_and(|maximum| value > maximum)
            {
                app.set_overlay_error("输入超出设置范围");
                return Ok(());
            }
            serde_json::Value::from(value)
        } else {
            serde_json::Value::String(value)
        };
        app.close_overlay();
        let (filter, _) = list_context(app, "设置");
        return request_setting_write(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            id,
            value,
            filter,
        );
    }
    if let Some(index) = action
        .strip_prefix("login-provider:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(provider) = app.providers.get(index).cloned() else {
            app.set_overlay_error("Provider 列表已刷新，请重新选择");
            return Ok(());
        };
        if provider.auth_methods.is_empty() {
            app.set_overlay_error("该 Provider 没有可用认证方式");
            return Ok(());
        }
        app.open_overlay(OverlayState::List(ListOverlay {
            title: format!("{} 登录方式", provider.name),
            origin: OverlayOrigin::User,
            items: provider
                .auth_methods
                .iter()
                .enumerate()
                .map(|(auth_index, method)| OverlayItem {
                    label: if method == "api_key" {
                        "API Key".to_owned()
                    } else {
                        "OAuth".to_owned()
                    },
                    detail: String::new(),
                    action: format!("auth-login:{index}:{auth_index}"),
                })
                .collect(),
            selected: 0,
            filter: String::new(),
            status: "Enter 登录，Esc 返回".to_owned(),
        }));
        return Ok(());
    }
    if let Some(pair) = action.strip_prefix("auth-login:") {
        let Some((provider_index, auth_index)) = pair.split_once(':') else {
            app.set_overlay_error("认证方式无效");
            return Ok(());
        };
        let (Ok(provider_index), Ok(auth_index)) =
            (provider_index.parse::<usize>(), auth_index.parse::<usize>())
        else {
            app.set_overlay_error("认证方式无效");
            return Ok(());
        };
        let Some(provider) = app.providers.get(provider_index).cloned() else {
            app.set_overlay_error("Provider 列表已刷新，请重新选择");
            return Ok(());
        };
        let Some(auth_type) = provider.auth_methods.get(auth_index).cloned() else {
            app.set_overlay_error("认证方式无效");
            return Ok(());
        };
        app.close_overlay();
        let (filter, _) = list_context(app, "登录");
        let client_request_id = format!(
            "login:{}:{}:{}",
            provider.id,
            auth_type,
            sequence.saturating_add(1)
        );
        app.mark_write_pending();
        return request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::LoginModelProvider,
            serde_json::json!({
                "provider": provider.id,
                "authType": auth_type,
                "clientInstanceId": client_instance_id,
                "clientRequestId": client_request_id,
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::AuthMutation {
                selected_key: Some(provider.id),
                filter,
                toast: "认证已更新".to_owned(),
            },
        );
    }
    if let Some(index) = action
        .strip_prefix("auth-logout:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(provider) = app.providers.get(index).cloned() else {
            app.set_overlay_error("Provider 列表已刷新，请重新选择");
            return Ok(());
        };
        let (filter, _) = list_context(app, "登录");
        let client_request_id = format!("logout:{}:{}", provider.id, sequence.saturating_add(1));
        app.mark_write_pending();
        return request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::LogoutModelProvider,
            serde_json::json!({
                "provider": provider.id,
                "clientInstanceId": client_instance_id,
                "clientRequestId": client_request_id,
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::AuthMutation {
                selected_key: Some(provider.id),
                filter,
                toast: "已退出登录".to_owned(),
            },
        );
    }
    let Some(request) = app.take_ui_response() else {
        return Ok(());
    };
    let (value, confirmed) = match (request.kind, action) {
        (UiRequestKind::Confirm, "ui:confirm") => (None, Some(true)),
        (UiRequestKind::Input | UiRequestKind::Secret | UiRequestKind::Editor, "ui:input") => {
            let value = match app.overlay() {
                Some(OverlayState::TextEditor(editor)) => {
                    serde_json::Value::String(editor.value.clone())
                }
                _ => serde_json::Value::String(String::new()),
            };
            (Some(value), None)
        }
        (UiRequestKind::Select, action) if action.starts_with("ui:select:") => (
            Some(serde_json::Value::String(
                action.trim_start_matches("ui:select:").to_owned(),
            )),
            None,
        ),
        _ => {
            app.set_overlay_error("输入类型与当前操作不匹配");
            return Ok(());
        }
    };
    pipe.request(&encode_ui_response(&request.id, value, confirmed, None)?)?;
    app.close_overlay();
    app.set_toast("已提交输入");
    Ok(())
}
