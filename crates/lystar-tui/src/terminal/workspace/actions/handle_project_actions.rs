use super::*;

pub(super) fn handle_project_actions(
    app: &mut AppState,
    action: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) -> Result<bool, TuiError> {
    if app.write_pending && !action.starts_with("ui:") {
        app.set_overlay_error("正在写入，请稍候");
        return Ok(true);
    }
    if action == "tree-replace-editor" {
        if let Some(text) = app.pending_editor_replace.take() {
            app.editor.replace(&text);
            app.clear_overlay_transient();
            app.set_toast("已替换输入草稿");
        }
        return Ok(true);
    }
    if action.starts_with("disabled:") {
        app.set_overlay_error(action.trim_start_matches("disabled:"));
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("change:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(file) = app
            .git_status
            .as_ref()
            .and_then(|status| status.files.get(index))
            .cloned()
        else {
            app.set_overlay_error("变更列表已刷新，请重新选择");
            return Ok(true);
        };
        let cwd = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
        app.open_workspace_overlay(
            "changes:detail",
            OverlayState::Detail(DetailOverlay {
                title: "变更详情".to_owned(),
                lines: vec!["正在读取 Diff".to_owned()],
                scroll: 0,
                status: "请稍候".to_owned(),
                link: None,
                copy_text: None,
            }),
        );
        request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::GetGitDiff,
            serde_json::json!({ "cwd": cwd, "path": file.path, "staged": file.staged })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            PendingIntent::ChangeDetail,
        )?;
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("skill:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(skill) = app.skills.get(index) else {
            app.set_overlay_error("技能列表已刷新，请重新选择");
            return Ok(true);
        };
        if !skill.eligible {
            app.set_overlay_error("此 Skill 不支持修改启用状态");
            return Ok(true);
        }
        app.open_overlay(OverlayState::List(ListOverlay {
            title: format!("{} 作用域", skill.name),
            origin: OverlayOrigin::User,
            items: ["user", "project"]
                .into_iter()
                .map(|scope| OverlayItem {
                    label: if scope == "user" { "用户" } else { "项目" }.to_owned(),
                    detail: if skill.scope == scope {
                        "当前来源"
                    } else {
                        "写入 override"
                    }
                    .to_owned(),
                    action: format!("skill-toggle:{index}:{scope}"),
                })
                .collect(),
            selected: if skill.scope == "project" { 1 } else { 0 },
            filter: String::new(),
            status: "Enter 切换启用状态，Esc 返回".to_owned(),
        }));
        return Ok(true);
    }
    if let Some(value) = action.strip_prefix("skill-toggle:") {
        let Some((index, scope)) = value.rsplit_once(':') else {
            app.set_overlay_error("技能作用域无效");
            return Ok(true);
        };
        let Ok(index) = index.parse::<usize>() else {
            app.set_overlay_error("技能作用域无效");
            return Ok(true);
        };
        let Some(skill) = app.skills.get(index).cloned() else {
            app.set_overlay_error("技能列表已刷新，请重新选择");
            return Ok(true);
        };
        let scope = scope.to_owned();
        if !matches!(scope.as_str(), "user" | "project") {
            app.set_overlay_error("技能作用域无效");
            return Ok(true);
        }
        app.close_overlay();
        let filter = list_context(app, "技能").0;
        let cwd = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
        app.mark_write_pending();
        request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::SetSkillEnabled,
            serde_json::json!({
                "cwd": cwd,
                "path": skill.path,
                "scope": scope,
                "enabled": !skill.enabled,
                "clientInstanceId": client_instance_id,
                "clientRequestId": format!("skill:{}:{}:{}", index, scope, sequence.saturating_add(1)),
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::SkillMutation {
                selected_key: format!("skill:{index}"),
                filter,
            },
        )?;
        return Ok(true);
    }
    if action == "trust:toggle" {
        let target = !app
            .trust
            .as_ref()
            .and_then(|trust| trust.trusted)
            .unwrap_or(false);
        let mut message = if target {
            "确认信任此项目？项目级资源将可加载。".to_owned()
        } else {
            "确认取消信任此项目？项目级资源将停止加载。".to_owned()
        };
        if !target
            && (app.is_active_operation()
                || app.trust.as_ref().is_some_and(|trust| trust.resource_risk))
        {
            message.push_str(" 当前有运行任务或项目资源，取消信任会影响后续资源加载。");
        }
        app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
            title: "项目信任".to_owned(),
            message,
            confirm_action: format!("trust-set:{target}"),
            status: String::new(),
        }));
        return Ok(true);
    }
    if let Some(target) = action.strip_prefix("trust-set:") {
        let trusted = match target {
            "true" => true,
            "false" => false,
            _ => {
                app.set_overlay_error("信任状态无效");
                return Ok(true);
            }
        };
        if app.is_active_operation() {
            app.set_overlay_error("当前会话正在运行，不能修改项目信任");
            return Ok(true);
        }
        if session_flow.is_some() {
            app.set_overlay_error("会话操作正在进行");
            return Ok(true);
        }
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(true);
        };
        let cwd = app
            .trust
            .as_ref()
            .map(|trust| trust.cwd.clone())
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目信任状态".to_owned()))?;
        app.mark_write_pending();
        request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::SetProjectTrust,
            serde_json::json!({
                "sessionPath": session_path,
                "leaseId": lease_id,
                "cwd": cwd,
                "trusted": trusted,
                "clientInstanceId": client_instance_id,
                "clientRequestId": format!("trust:{trusted}:{}", sequence.saturating_add(1)),
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::TrustMutation { cwd, trusted },
        )?;
        return Ok(true);
    }
    if let Some(scope) = action.strip_prefix("instruction-conflict-reload:") {
        let target = match scope {
            "project" => WorkbenchTarget::InstructionsProject,
            "host" => WorkbenchTarget::InstructionsHost,
            _ => {
                app.set_overlay_error("指令冲突作用域无效");
                return Ok(true);
            }
        };
        app.close_overlay();
        request_workspace_load(app, pipe, sequence, target, None, String::new())?;
        return Ok(true);
    }
    if action == "instruction-conflict-discard" {
        app.close_overlay();
        app.set_toast("已放弃保存，未覆盖外部修改");
        return Ok(true);
    }
    if let Some(value) = action.strip_prefix("instruction:") {
        let mut values = value.split(':');
        let (Some(scope), Some(index)) = (values.next(), values.next()) else {
            app.set_overlay_error("指令选择无效");
            return Ok(true);
        };
        let Ok(index) = index.parse::<usize>() else {
            app.set_overlay_error("指令选择无效");
            return Ok(true);
        };
        let instructions = if scope == "project" {
            &app.project_instructions
        } else {
            &app.host_instructions
        };
        let Some(instruction) = instructions.get(index) else {
            app.set_overlay_error("指令列表已刷新，请重新选择");
            return Ok(true);
        };
        app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
            title: format!("编辑 {}", instruction.file_name),
            value: instruction.content.clone().unwrap_or_default(),
            cursor: instruction.content.as_ref().map_or(0, String::len),
            save_action: format!("instruction-save:{scope}:{index}"),
            status: "Enter 保存，Shift+Enter 换行，Esc 取消".to_owned(),
            secret: false,
        }));
        return Ok(true);
    }
    if let Some(value) = action.strip_prefix("instruction-save:") {
        let mut values = value.split(':');
        let (Some(scope), Some(index)) = (values.next(), values.next()) else {
            app.set_overlay_error("指令保存无效");
            return Ok(true);
        };
        let Ok(index) = index.parse::<usize>() else {
            app.set_overlay_error("指令保存无效");
            return Ok(true);
        };
        let content = match app.overlay() {
            Some(OverlayState::TextEditor(editor)) => editor.value.clone(),
            _ => String::new(),
        };
        let instructions = if scope == "project" {
            &app.project_instructions
        } else {
            &app.host_instructions
        };
        let Some(instruction) = instructions.get(index).cloned() else {
            app.set_overlay_error("指令列表已刷新，请重新选择");
            return Ok(true);
        };
        app.close_overlay();
        let target = if scope == "project" {
            WorkbenchTarget::InstructionsProject
        } else {
            WorkbenchTarget::InstructionsHost
        };
        let filter = list_context(
            app,
            if scope == "project" {
                "指令 [项目]"
            } else {
                "指令 [本机]"
            },
        )
        .0;
        let cwd = app.active_session_cwd().unwrap_or_default();
        let command = if scope == "project" {
            WorkspaceCommand::SaveProjectInstruction
        } else {
            WorkspaceCommand::SaveHostInstruction
        };
        let mut payload = serde_json::json!({
            "fileName": instruction.file_name,
            "content": content,
            "clientInstanceId": client_instance_id,
            "clientRequestId": format!("instruction:{scope}:{}", sequence.saturating_add(1)),
        })
        .as_object()
        .cloned()
        .unwrap_or_default();
        if scope == "project" {
            payload.insert("cwd".to_owned(), serde_json::Value::String(cwd.to_owned()));
        }
        if let Some(hash) = instruction.content_hash {
            payload.insert("expectedHash".to_owned(), serde_json::Value::String(hash));
        }
        app.mark_write_pending();
        request_workspace(
            app,
            pipe,
            sequence,
            command,
            payload,
            PendingIntent::InstructionMutation {
                target,
                selected_key: format!("instruction:{scope}:{index}"),
                filter,
            },
        )?;
        return Ok(true);
    }
    if action == "package-install-source" {
        let source = match app.overlay() {
            Some(OverlayState::TextEditor(editor)) => editor.value.trim().to_owned(),
            _ => String::new(),
        };
        if source.is_empty() {
            app.set_overlay_error("请输入包来源");
            return Ok(true);
        }
        app.pending_package_source = Some(source);
        app.close_overlay();
        app.open_overlay(OverlayState::List(ListOverlay {
            title: "安装包作用域".to_owned(),
            origin: OverlayOrigin::User,
            items: vec![
                OverlayItem {
                    label: "用户".to_owned(),
                    detail: "写入用户配置".to_owned(),
                    action: "package-install:user".to_owned(),
                },
                OverlayItem {
                    label: "项目".to_owned(),
                    detail: "写入项目配置".to_owned(),
                    action: "package-install:project".to_owned(),
                },
            ],
            selected: 0,
            filter: String::new(),
            status: "Enter 安装，Esc 返回".to_owned(),
        }));
        return Ok(true);
    }
    if let Some(scope) = action.strip_prefix("package-install:") {
        let Some(source) = app.pending_package_source.take() else {
            app.set_overlay_error("包来源已丢失，请重新输入");
            return Ok(true);
        };
        if !matches!(scope, "user" | "project") {
            app.set_overlay_error("包作用域无效");
            return Ok(true);
        }
        app.close_overlay();
        let filter = list_context(app, "包").0;
        let cwd = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
        app.mark_write_pending();
        request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::InstallPackage,
            serde_json::json!({
                "cwd": cwd, "source": source, "scope": scope,
                "clientInstanceId": client_instance_id,
                "clientRequestId": format!("package-install:{}:{}", scope, sequence.saturating_add(1)),
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::PackageMutation { selected_key: None, filter, toast: "包已安装".to_owned() },
        )?;
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("package-remove:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(package) = app.packages.get(index).cloned() else {
            app.set_overlay_error("包列表已刷新，请重新选择");
            return Ok(true);
        };
        app.close_overlay();
        let filter = list_context(app, "包").0;
        let cwd = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
        app.mark_write_pending();
        request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::RemovePackage,
            serde_json::json!({
                "cwd": cwd, "source": package.source, "scope": package.scope,
                "clientInstanceId": client_instance_id,
                "clientRequestId": format!("package-remove:{}", sequence.saturating_add(1)),
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::PackageMutation {
                selected_key: None,
                filter,
                toast: "包已移除".to_owned(),
            },
        )?;
        return Ok(true);
    }
    if action == "package-update-all" || action.starts_with("package-update:package:") {
        let source = action
            .strip_prefix("package-update:package:")
            .and_then(|value| value.parse::<usize>().ok())
            .and_then(|index| app.packages.get(index))
            .map(|package| package.source.clone());
        let filter = list_context(app, "包").0;
        let cwd = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
        let mut payload = serde_json::json!({
            "cwd": cwd,
            "clientInstanceId": client_instance_id,
            "clientRequestId": format!("package-update:{}", sequence.saturating_add(1)),
        })
        .as_object()
        .cloned()
        .unwrap_or_default();
        if let Some(source) = source {
            payload.insert("source".to_owned(), serde_json::Value::String(source));
        }
        app.mark_write_pending();
        request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::UpdatePackages,
            payload,
            PendingIntent::PackageMutation {
                selected_key: None,
                filter,
                toast: "包已更新".to_owned(),
            },
        )?;
        return Ok(true);
    }
    Ok(false)
}
