use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_extension_event(
    app: &mut AppState,
    raw: &serde_json::Value,
    session_path: &str,
    pipe: &mut ProtocolPipe,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<Option<bool>, TuiError> {
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("event") {
        let event = raw.get("event").and_then(serde_json::Value::as_object);
        let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
        if let Some(event) = event
            && event.get("sessionPath").and_then(serde_json::Value::as_str)
                == Some(active_path.as_str())
        {
            match event.get("type").and_then(serde_json::Value::as_str) {
                Some("extension_ui_snapshot") => {
                    let state =
                        extension_state(event.get("state").unwrap_or(&serde_json::Value::Null))?;
                    write_extension_title(state.title.as_deref());
                    app.apply_extension_ui_snapshot(state);
                    return Ok(Some(false));
                }
                Some("extension_ui_delta") => {
                    let title_updated = event
                        .get("delta")
                        .and_then(serde_json::Value::as_object)
                        .is_some_and(|delta| delta.contains_key("title"));
                    apply_extension_delta(
                        app,
                        event.get("delta").unwrap_or(&serde_json::Value::Null),
                    )?;
                    if title_updated {
                        write_extension_title(app.extension_ui.title.as_deref());
                    }
                    return Ok(Some(false));
                }
                Some("extension_component_mount") => {
                    let component_id = event
                        .get("componentId")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component mount 缺少 id".to_owned(),
                            )
                        })?;
                    let generation = event
                        .get("generation")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component mount 缺少 generation".to_owned(),
                            )
                        })?;
                    let placement = event
                        .get("placement")
                        .and_then(serde_json::Value::as_str)
                        .filter(|placement| {
                            matches!(
                                *placement,
                                "widget_above"
                                    | "widget_below"
                                    | "header"
                                    | "footer"
                                    | "custom_overlay"
                                    | "editor"
                            )
                        })
                        .ok_or_else(|| {
                            TuiError::InvalidResponse("Extension component 位置无效".to_owned())
                        })?;
                    let visible = event
                        .get("visible")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);
                    let component = extension_component_state(
                        component_id,
                        generation,
                        placement,
                        visible,
                        component_overlay_options(event.get("overlayOptions")),
                        event.get("frame").unwrap_or(&serde_json::Value::Null),
                    )?;
                    if app.apply_extension_component_mount(component) {
                        trace_id("component_mount_applied", component_id);
                    }
                    return Ok(Some(false));
                }
                Some("extension_component_frame") => {
                    let component_id = event
                        .get("componentId")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component frame 缺少 id".to_owned(),
                            )
                        })?;
                    let generation = event
                        .get("generation")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component frame 缺少 generation".to_owned(),
                            )
                        })?;
                    let (revision, lines, cursor, hit_regions, desired_size) =
                        parse_component_frame(
                            component_id,
                            event.get("frame").unwrap_or(&serde_json::Value::Null),
                        )?;
                    let frame_bytes = lines.iter().map(|line| line.len()).sum::<usize>();
                    if app.apply_extension_component_frame(
                        component_id,
                        generation,
                        revision,
                        lines,
                        cursor,
                        hit_regions,
                    ) {
                        if let Some(component) = app.extension_ui.components.get_mut(component_id) {
                            component.desired_size = desired_size;
                        }
                        trace_component_frame_applied(component_id, revision, frame_bytes);
                    }
                    return Ok(Some(false));
                }
                Some("extension_component_invalidate") => {
                    let component_id = event
                        .get("componentId")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component invalidate 缺少 id".to_owned(),
                            )
                        })?;
                    let generation = event
                        .get("generation")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component invalidate 缺少 generation".to_owned(),
                            )
                        })?;
                    let visible = event
                        .get("visible")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);
                    if app.apply_extension_component_visibility(component_id, generation, visible) {
                        trace_id("component_visibility_applied", component_id);
                    }
                    return Ok(Some(false));
                }
                Some("extension_component_unmount") => {
                    let component_id = event
                        .get("componentId")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component unmount 缺少 id".to_owned(),
                            )
                        })?;
                    let generation = event
                        .get("generation")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component unmount 缺少 generation".to_owned(),
                            )
                        })?;
                    if app.remove_extension_component(component_id, generation) {
                        trace_id("component_unmount_applied", component_id);
                    }
                    return Ok(Some(false));
                }
                Some("extension_editor_submit") => {
                    let submit = event
                        .get("submit")
                        .and_then(serde_json::Value::as_object)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse("自定义编辑器提交无效".to_owned())
                        })?;
                    let text = submit
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse("自定义编辑器提交缺少文本".to_owned())
                        })?;
                    let revision = submit
                        .get("revision")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse("自定义编辑器提交缺少修订".to_owned())
                        })?;
                    if app.apply_extension_editor_action_from_component_input("set", text, revision)
                    {
                        submit_custom_editor(
                            app,
                            pipe,
                            &active_path,
                            client_instance_id,
                            sequence,
                            false,
                            session_flow,
                        )?;
                    }
                    return Ok(Some(false));
                }
                Some("extension_editor_app_action") => {
                    let action = event
                        .get("action")
                        .and_then(serde_json::Value::as_object)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse("自定义编辑器动作无效".to_owned())
                        })?;
                    let name = action
                        .get("action")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    apply_extension_editor_app_action(
                        app,
                        name,
                        pipe,
                        session_path,
                        client_instance_id,
                        sequence,
                        session_flow,
                        quit_requested,
                    )?;
                    return Ok(Some(false));
                }
                Some("extension_editor_action") => {
                    let action = event
                        .get("action")
                        .and_then(serde_json::Value::as_object)
                        .ok_or_else(|| TuiError::InvalidResponse("编辑器动作无效".to_owned()))?;
                    let kind = action
                        .get("action")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let text = action
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let revision = action
                        .get("revision")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0);
                    app.apply_extension_editor_action(kind, text, revision);
                    return Ok(Some(false));
                }
                _ => {}
            }
        }
    }
    Ok(None)
}
