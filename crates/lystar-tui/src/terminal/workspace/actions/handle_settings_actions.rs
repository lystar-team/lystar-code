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
    if action == "setting-theme" {
        let Some(setting) = app.setting("theme").cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        if setting.read_only || setting.options.is_empty() {
            app.set_overlay_error("当前没有可用主题");
            return Ok(());
        }
        let automatic = setting
            .value
            .as_str()
            .is_some_and(|value| value.split_once('/').is_some());
        app.open_overlay(OverlayState::List(ListOverlay {
            title: "主题模式".to_owned(),
            origin: OverlayOrigin::User,
            items: vec![
                OverlayItem {
                    label: "固定主题".to_owned(),
                    detail: if automatic {
                        String::new()
                    } else {
                        "当前".to_owned()
                    },
                    action: "setting-theme-fixed".to_owned(),
                },
                OverlayItem {
                    label: "自动跟随终端".to_owned(),
                    detail: if automatic {
                        "当前".to_owned()
                    } else {
                        String::new()
                    },
                    action: "setting-theme-auto".to_owned(),
                },
            ],
            selected: usize::from(automatic),
            filter: String::new(),
            status: "Enter 选择，Esc 返回".to_owned(),
        }));
        return Ok(());
    }
    if action == "setting-theme-fixed" {
        let Some(setting) = app.setting("theme").cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        let current = setting.value.as_str().filter(|value| !value.contains('/'));
        app.open_overlay(theme_options_overlay(
            &setting,
            "固定主题",
            "setting-theme-save",
            current,
        ));
        return Ok(());
    }
    if action == "setting-theme-auto" {
        let Some(setting) = app.setting("theme").cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        let current = setting
            .value
            .as_str()
            .and_then(|value| value.split_once('/'))
            .map(|(light, _)| light)
            .or_else(|| setting.value.as_str());
        app.open_overlay(theme_options_overlay(
            &setting,
            "浅色主题",
            "setting-theme-light",
            current,
        ));
        return Ok(());
    }
    if let Some(index) = action.strip_prefix("setting-theme-light:") {
        let Ok(index) = index.parse::<usize>() else {
            app.set_overlay_error("主题选项无效");
            return Ok(());
        };
        let Some(setting) = app.setting("theme").cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        let Some(light) = setting.options.get(index) else {
            app.set_overlay_error("主题选项无效");
            return Ok(());
        };
        let current = setting
            .value
            .as_str()
            .and_then(|value| value.split_once('/'))
            .map(|(_, dark)| dark)
            .or_else(|| setting.value.as_str());
        app.open_overlay(theme_options_overlay(
            &setting,
            "深色主题",
            &format!("setting-theme-pair:{light}"),
            current,
        ));
        return Ok(());
    }
    if let Some(pair) = action.strip_prefix("setting-theme-pair:") {
        let Some((light, index)) = pair.rsplit_once(':') else {
            app.set_overlay_error("主题选项无效");
            return Ok(());
        };
        let Ok(index) = index.parse::<usize>() else {
            app.set_overlay_error("主题选项无效");
            return Ok(());
        };
        let Some(setting) = app.setting("theme").cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        let Some(dark) = setting.options.get(index) else {
            app.set_overlay_error("主题选项无效");
            return Ok(());
        };
        app.close_overlay();
        app.close_overlay();
        app.close_overlay();
        let (filter, _) = list_context(app, "设置");
        return request_setting_write(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            "theme",
            serde_json::Value::String(format!("{light}/{dark}")),
            filter,
        );
    }
    if let Some(index) = action.strip_prefix("setting-theme-save:") {
        let Ok(index) = index.parse::<usize>() else {
            app.set_overlay_error("主题选项无效");
            return Ok(());
        };
        let Some(setting) = app.setting("theme").cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        let Some(value) = setting.options.get(index).cloned() else {
            app.set_overlay_error("主题选项无效");
            return Ok(());
        };
        app.close_overlay();
        app.close_overlay();
        let (filter, _) = list_context(app, "设置");
        return request_setting_write(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            "theme",
            serde_json::Value::String(value),
            filter,
        );
    }
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
                    label: setting
                        .option_labels
                        .get(index)
                        .cloned()
                        .unwrap_or_else(|| value.clone()),
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

fn theme_options_overlay(
    setting: &SettingDescriptor,
    title: &str,
    action_prefix: &str,
    current: Option<&str>,
) -> OverlayState {
    let selected = current
        .and_then(|current| setting.options.iter().position(|value| value == current))
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: title.to_owned(),
        origin: OverlayOrigin::User,
        items: setting
            .options
            .iter()
            .enumerate()
            .map(|(index, value)| OverlayItem {
                label: setting
                    .option_labels
                    .get(index)
                    .cloned()
                    .unwrap_or_else(|| value.clone()),
                detail: if Some(value.as_str()) == current {
                    "当前".to_owned()
                } else {
                    String::new()
                },
                action: format!("{action_prefix}:{index}"),
            })
            .collect(),
        selected,
        filter: String::new(),
        status: "Enter 选择，Esc 返回".to_owned(),
    })
}
