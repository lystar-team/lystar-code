use super::*;

pub(super) fn auth_command(text: &str) -> Option<(&'static str, String)> {
    let command = text.trim();
    for (prefix, mode) in [("/login", "login"), ("/logout", "logout")] {
        if command == prefix {
            return Some((mode, String::new()));
        }
        if let Some(filter) = command
            .strip_prefix(prefix)
            .and_then(|value| value.strip_prefix(' '))
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some((mode, filter.to_owned()));
        }
    }
    None
}

pub(super) fn open_auth_selector(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    session_flow: &Option<SessionFlow>,
    mode: &str,
    filter: String,
) -> Result<(), TuiError> {
    if app.is_active_operation() {
        app.set_overlay_error("当前会话正在运行，不能修改认证");
        return Ok(());
    }
    if session_flow.is_some() {
        app.set_overlay_error("会话操作正在进行");
        return Ok(());
    }
    if app.write_pending {
        app.set_overlay_error("正在写入，请稍候");
        return Ok(());
    }
    app.open_overlay(OverlayState::Detail(DetailOverlay {
        title: if mode == "logout" {
            "退出登录"
        } else {
            "登录"
        }
        .to_owned(),
        lines: vec!["正在读取 Provider".to_owned()],
        scroll: 0,
        status: "请稍候".to_owned(),
        link: None,
        copy_text: None,
    }));
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::ListModelProviders,
        serde_json::Map::new(),
        PendingIntent::AuthList {
            mode: mode.to_owned(),
            filter,
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn handle_auth_action(
    app: &mut AppState,
    action: &str,
    pipe: &mut ProtocolPipe,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &Option<SessionFlow>,
) -> Result<bool, TuiError> {
    if let Some(index) = action
        .strip_prefix("login-provider:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(provider) = app.providers.get(index).cloned() else {
            app.set_overlay_error("Provider 列表已刷新，请重新选择");
            return Ok(true);
        };
        if provider.auth_methods.is_empty() {
            app.set_overlay_error("该 Provider 没有可用认证方式");
            return Ok(true);
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
                        "API Key"
                    } else {
                        "OAuth"
                    }
                    .to_owned(),
                    detail: String::new(),
                    action: format!("auth-login:{index}:{auth_index}"),
                })
                .collect(),
            selected: 0,
            filter: String::new(),
            status: "Enter 登录，Esc 返回".to_owned(),
        }));
        return Ok(true);
    }
    if let Some(pair) = action.strip_prefix("auth-login:") {
        let Some((provider_index, auth_index)) = pair.split_once(':') else {
            app.set_overlay_error("认证方式无效");
            return Ok(true);
        };
        let (Ok(provider_index), Ok(auth_index)) =
            (provider_index.parse::<usize>(), auth_index.parse::<usize>())
        else {
            app.set_overlay_error("认证方式无效");
            return Ok(true);
        };
        let Some(provider) = app.providers.get(provider_index).cloned() else {
            app.set_overlay_error("Provider 列表已刷新，请重新选择");
            return Ok(true);
        };
        let Some(auth_type) = provider.auth_methods.get(auth_index).cloned() else {
            app.set_overlay_error("认证方式无效");
            return Ok(true);
        };
        return request_auth_mutation(
            app,
            pipe,
            client_instance_id,
            sequence,
            session_flow,
            provider,
            Some(auth_type),
        );
    }
    if let Some(index) = action
        .strip_prefix("auth-logout:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(provider) = app.providers.get(index).cloned() else {
            app.set_overlay_error("Provider 列表已刷新，请重新选择");
            return Ok(true);
        };
        return request_auth_mutation(
            app,
            pipe,
            client_instance_id,
            sequence,
            session_flow,
            provider,
            None,
        );
    }
    Ok(false)
}

#[allow(clippy::too_many_arguments)]
fn request_auth_mutation(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &Option<SessionFlow>,
    provider: ProviderDescriptor,
    auth_type: Option<String>,
) -> Result<bool, TuiError> {
    if app.is_active_operation() {
        app.set_overlay_error("当前会话正在运行，不能修改认证");
        return Ok(true);
    }
    if session_flow.is_some() {
        app.set_overlay_error("会话操作正在进行");
        return Ok(true);
    }
    if app.write_pending {
        app.set_overlay_error("正在写入，请稍候");
        return Ok(true);
    }
    let mode = if auth_type.is_some() {
        "login"
    } else {
        "logout"
    };
    let (filter, _) = list_context(
        app,
        if mode == "login" {
            "登录"
        } else {
            "退出登录"
        },
    );
    let mut payload = serde_json::json!({
        "provider": provider.id,
        "clientInstanceId": client_instance_id,
        "clientRequestId": format!("auth:{mode}:{}:{}", provider.id, sequence.saturating_add(1)),
    })
    .as_object()
    .cloned()
    .unwrap_or_default();
    if let Some(auth_type) = &auth_type {
        payload.insert(
            "authType".to_owned(),
            serde_json::Value::String(auth_type.clone()),
        );
    }
    if auth_type.is_some() {
        app.close_overlay();
    }
    app.mark_write_pending();
    request_workspace(
        app,
        pipe,
        sequence,
        if auth_type.is_some() {
            WorkspaceCommand::LoginModelProvider
        } else {
            WorkspaceCommand::LogoutModelProvider
        },
        payload,
        PendingIntent::AuthMutation {
            provider: provider.id,
            auth_type,
            filter,
        },
    )?;
    Ok(true)
}

pub(super) fn apply_auth_models_result(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    result: serde_json::Value,
    provider: String,
    auth_type: Option<String>,
    filter: String,
) -> Result<(), TuiError> {
    let models = parse_models(&result)?;
    app.mark_write_pending();
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::ListModelProviders,
        serde_json::Map::new(),
        PendingIntent::AuthVerify {
            provider,
            auth_type,
            filter,
            models,
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_auth_list_result(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &Option<SessionFlow>,
    result: serde_json::Value,
    mode: &str,
    filter: String,
) -> Result<(), TuiError> {
    app.providers = parse_providers(&result)?;
    app.replace_overlay(auth_overlay(&app.providers, mode, None, filter.clone()));
    if mode != "login" || filter.is_empty() {
        return Ok(());
    }
    let matches = app
        .providers
        .iter()
        .enumerate()
        .filter(|(_, provider)| {
            provider.id.eq_ignore_ascii_case(&filter) || provider.name.eq_ignore_ascii_case(&filter)
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let [index] = matches.as_slice() else {
        return Ok(());
    };
    let provider = app.providers[*index].clone();
    match provider.auth_methods.len() {
        1 => {
            let auth_type = provider.auth_methods[0].clone();
            request_auth_mutation(
                app,
                pipe,
                client_instance_id,
                sequence,
                session_flow,
                provider,
                Some(auth_type),
            )?;
        }
        count if count > 1 => {
            handle_auth_action(
                app,
                &format!("login-provider:{index}"),
                pipe,
                client_instance_id,
                sequence,
                session_flow,
            )?;
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn apply_auth_verify_result(
    app: &mut AppState,
    result: serde_json::Value,
    provider_id: &str,
    auth_type: Option<&str>,
    filter: String,
    models: Vec<ModelDescriptor>,
) -> Result<(), TuiError> {
    let providers = parse_providers(&result)?;
    let provider = providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| TuiError::InvalidResponse("认证结果缺少所选 Provider".to_owned()))?;
    let provider_models = models
        .iter()
        .filter(|model| model.provider == provider_id)
        .collect::<Vec<_>>();
    let models_match = provider_models.len() == provider.model_count as usize
        && provider_models
            .iter()
            .all(|model| model.configured == provider.configured);
    let valid = models_match
        && match auth_type {
            Some(method) => {
                provider.configured
                    && provider.auth_source.as_deref() == Some("stored")
                    && provider.auth_methods.iter().any(|value| value == method)
            }
            None => provider.auth_source.as_deref() != Some("stored"),
        };
    if !valid {
        return Err(TuiError::InvalidResponse(
            "认证结果与所选 Provider 或认证方式不一致".to_owned(),
        ));
    }
    let toast = match auth_type {
        Some(_) => format!("已更新 {} 认证", provider.name),
        None => format!("已删除 {} 保存的凭据", provider.name),
    };
    app.models = models;
    app.providers = providers;
    restore_auth_overlay(
        app,
        if auth_type.is_some() {
            "login"
        } else {
            "logout"
        },
        Some(provider_id),
        filter,
    );
    app.set_toast(toast);
    Ok(())
}

pub(super) fn restore_auth_overlay(
    app: &mut AppState,
    mode: &str,
    selected_key: Option<&str>,
    filter: String,
) {
    let title = if mode == "login" {
        "登录"
    } else {
        "退出登录"
    };
    while app
        .overlay()
        .is_some_and(|overlay| overlay.title() != title)
    {
        app.close_overlay();
    }
    let overlay = auth_overlay(&app.providers, mode, selected_key, filter);
    if app.overlay().is_some() {
        app.replace_overlay(overlay);
    } else {
        app.open_overlay(overlay);
    }
}

pub(super) fn restore_auth_intent(app: &mut AppState, intent: &PendingIntent) {
    match intent {
        PendingIntent::AuthList { mode, filter } => {
            restore_auth_overlay(app, mode, None, filter.clone());
        }
        PendingIntent::AuthMutation {
            provider,
            auth_type,
            filter,
        }
        | PendingIntent::AuthVerify {
            provider,
            auth_type,
            filter,
            ..
        } => restore_auth_overlay(
            app,
            if auth_type.is_some() {
                "login"
            } else {
                "logout"
            },
            Some(provider),
            filter.clone(),
        ),
        _ => {}
    }
}
