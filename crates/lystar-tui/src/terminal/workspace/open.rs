use super::*;

pub(in super::super) fn open_workbench(
    app: &mut AppState,
    target: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    if target == "new" {
        return start_new_session(app, pipe, client_instance_id, sequence, session_flow);
    }
    if target == "clone" {
        return clone_current_session(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            session_flow,
        );
    }
    if target == "fork" {
        return open_fork_selector(app, pipe, session_path, sequence, session_flow);
    }
    if target == "reload" {
        return reload_resources(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            session_flow,
        );
    }
    if target == "compact" {
        return request_compaction(app, pipe, session_path, client_instance_id, sequence, None);
    }
    if target == "export" {
        return request_export_session(app, pipe, session_path, client_instance_id, sequence, None);
    }
    if target == "share" {
        return request_share_session(app, pipe, session_path, client_instance_id, sequence);
    }
    if target == "copy" {
        return request_copy_last_assistant_message(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
        );
    }
    if target == "name" {
        app.close_overlay();
        app.editor.clear();
        app.editor.insert("/name ");
        return Ok(());
    }
    if target == "import" {
        app.close_overlay();
        app.editor.clear();
        app.editor.insert("/import ");
        return Ok(());
    }
    if matches!(target, "resume" | "sessions") {
        let Some(cwd) = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
        else {
            app.set_overlay_error("尚未获取项目目录");
            return Ok(());
        };
        *sequence += 1;
        let id = format!("sessions-list-{sequence}");
        *session_flow = Some(SessionFlow::List {
            id: id.clone(),
            selected_path: app.active_session_path().map(str::to_owned),
        });
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "会话".to_owned(),
            lines: vec!["正在读取会话".to_owned()],
            scroll: 0,
            status: "请稍候".to_owned(),
            link: None,
            copy_text: None,
        }));
        return pipe.request(&encode_list_sessions_request(&id, &cwd, None)?);
    }
    if matches!(target, "agents" | "subagents") {
        return request_subagents(
            app,
            pipe,
            sequence,
            session_path.to_owned(),
            None,
            String::new(),
        );
    }
    if target == "session" {
        return request_session_info(app, pipe, session_path, sequence);
    }
    if target == "model" {
        return open_model_selector(app, pipe, sequence, session_flow, String::new());
    }
    if target == "changelog" {
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "更新内容".to_owned(),
            lines: vec!["正在读取更新内容".to_owned()],
            scroll: 0,
            status: "请稍候".to_owned(),
            link: None,
            copy_text: None,
        }));
        return request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::GetChangelog,
            serde_json::json!({
                "sessionPath": session_path,
                "width": app.composer_width().saturating_sub(8).clamp(1, 72),
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::Changelog,
        );
    }
    if target == "hotkeys" {
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "快捷键".to_owned(),
            lines: [
                "导航",
                "  ↑ / ↓  移动光标；输入首尾浏览历史",
                "  ← / →  移动光标",
                "  Home / End  跳到行首 / 行尾；空输入时跳到会话首尾",
                "  PageUp / PageDown  按页滚动会话",
                "",
                "编辑",
                "  Enter  提交消息",
                "  Shift+Enter / Ctrl+J  换行",
                "  Backspace / Delete  删除字符",
                "  Ctrl+U  清空输入",
                "  Ctrl+Z / Ctrl+R  撤销 / 重做",
                "",
                "工作台",
                "  Ctrl+P  打开命令面板",
                "  Ctrl+F  搜索会话",
                "  Ctrl+O  展开 Tool；打开当前 Subagent",
                "  Ctrl+C / Esc  停止当前操作",
                "  Alt+Enter  添加后续消息",
                "  Ctrl+V  粘贴剪贴板文本",
                "  Ctrl+Shift+V  粘贴剪贴板文本和图片",
                "  Ctrl+Y  复制当前上下文",
                "  q  输入框为空时退出",
                "",
                "输入前缀",
                "  /  斜杠命令",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            scroll: 0,
            status: "Esc 返回".to_owned(),
            link: None,
            copy_text: None,
        }));
        return Ok(());
    }
    if target == "clipboard" {
        app.open_workspace_overlay(
            "clipboard",
            OverlayState::Detail(DetailOverlay {
                title: "剪贴板".to_owned(),
                lines: vec!["正在读取剪贴板".to_owned()],
                scroll: 0,
                status: "请稍候".to_owned(),
                link: None,
                copy_text: None,
            }),
        );
        return request_clipboard_both(app, pipe, sequence, ClipboardReadTarget::Overlay);
    }
    if target == "tree" {
        return request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::GetSessionTree,
            serde_json::json!({ "sessionPath": session_path })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            PendingIntent::WorkbenchLoad {
                target: WorkbenchTarget::Tree,
                selected_key: None,
                filter: String::new(),
            },
        );
    }
    if target == "help" {
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "帮助".to_owned(),
            lines: vec![
                "Ctrl+P 打开命令面板".to_owned(),
                "/new 新建会话，/clone 复制当前会话，/fork 从历史消息分叉会话，/reload 重新加载资源，/resume 继续会话，/export 导出会话，/import 导入会话，/share 分享会话，/copy 复制 Agent 消息，/name 设置会话名称，/session 当前会话信息，/agents 查看和控制 Subagent，/changelog 更新内容，/hotkeys 快捷键，/clipboard 剪贴板，/sessions 会话，/tree 分支树".to_owned(),
                "/settings 设置，/model 模型，/thinking 思考，/login 登录".to_owned(),
                "Ctrl+Shift+V 读取并插入剪贴板，Ctrl+Y 复制当前上下文".to_owned(),
                "/help 显示此帮助，/about 显示版本与运行目录，/doctor 显示诊断结果".to_owned(),
                "Esc 返回；方向键、PageUp/PageDown、Home/End 可浏览详情".to_owned(),
            ],
            scroll: 0,
            status: "Esc 返回".to_owned(),
            link: None,
            copy_text: None,
        }));
        return Ok(());
    }
    if matches!(
        target,
        "changes" | "skills" | "trust" | "instructions" | "packages" | "update"
    ) {
        let cwd = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
        let (command, payload, workbench_target, title, key) = match target {
            "changes" => (
                WorkspaceCommand::GetGitStatus,
                serde_json::json!({ "cwd": cwd })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                WorkbenchTarget::Changes,
                "变更",
                "changes",
            ),
            "skills" => (
                WorkspaceCommand::ListSkills,
                serde_json::json!({ "cwd": cwd })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                WorkbenchTarget::Skills,
                "技能",
                "skills",
            ),
            "trust" => (
                WorkspaceCommand::GetProjectTrust,
                serde_json::json!({ "cwd": cwd })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                WorkbenchTarget::Trust,
                "项目信任",
                "trust",
            ),
            "instructions" => (
                WorkspaceCommand::ListProjectInstructions,
                serde_json::json!({ "cwd": cwd })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                WorkbenchTarget::InstructionsProject,
                "指令 [项目]",
                "instructions:project",
            ),
            "packages" => (
                WorkspaceCommand::ListPackages,
                serde_json::json!({ "cwd": cwd })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                WorkbenchTarget::Packages,
                "包",
                "packages",
            ),
            "update" => (
                WorkspaceCommand::CheckForUpdates,
                serde_json::Map::new(),
                WorkbenchTarget::Update,
                "更新检查",
                "update",
            ),
            _ => unreachable!(),
        };
        app.open_workspace_overlay(
            key,
            OverlayState::Detail(DetailOverlay {
                title: title.to_owned(),
                lines: vec!["正在读取".to_owned()],
                scroll: 0,
                status: "请稍候".to_owned(),
                link: None,
                copy_text: None,
            }),
        );
        return request_workspace(
            app,
            pipe,
            sequence,
            command,
            payload,
            PendingIntent::WorkbenchLoad {
                target: workbench_target,
                selected_key: None,
                filter: String::new(),
            },
        );
    }
    let (command, payload, intent, title) = match target {
        "settings" => (
            WorkspaceCommand::ListSettings,
            serde_json::json!({ "sessionPath": session_path })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            PendingIntent::WorkbenchLoad {
                target: WorkbenchTarget::Settings,
                selected_key: None,
                filter: String::new(),
            },
            "设置",
        ),
        "thinking" => (
            WorkspaceCommand::ListModels,
            serde_json::Map::new(),
            PendingIntent::WorkbenchLoad {
                target: WorkbenchTarget::Thinking,
                selected_key: None,
                filter: String::new(),
            },
            "思考",
        ),
        "login" => (
            WorkspaceCommand::ListModelProviders,
            serde_json::Map::new(),
            PendingIntent::WorkbenchLoad {
                target: WorkbenchTarget::Login,
                selected_key: None,
                filter: String::new(),
            },
            "登录",
        ),
        "about" => (WorkspaceCommand::GetAbout, serde_json::Map::new(), PendingIntent::Overlay { target: "关于".to_owned() }, "关于"),
        "doctor" => (
            WorkspaceCommand::GetDiagnostics,
            serde_json::json!({ "cwd": app.snapshot.as_ref().map(|snapshot| snapshot.cwd.clone()) })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            PendingIntent::Overlay { target: "诊断".to_owned() },
            "诊断",
        ),
        _ => return Ok(()),
    };
    app.open_overlay(OverlayState::Detail(DetailOverlay {
        title: title.to_owned(),
        lines: vec!["正在读取".to_owned()],
        scroll: 0,
        status: "请稍候".to_owned(),
        link: None,
        copy_text: None,
    }));
    request_workspace(app, pipe, sequence, command, payload, intent)
}
