use super::*;

pub(in super::super) fn ui_notify_detail(
    title: &str,
    payload: &serde_json::Value,
) -> DetailOverlay {
    const FIELD_LIMIT: usize = 512;
    const LINE_LIMIT: usize = 12;
    let bounded = |value: &str| {
        if value.len() <= FIELD_LIMIT {
            return value.to_owned();
        }
        let mut output = String::new();
        for character in value.chars() {
            if output.len() + character.len_utf8() > FIELD_LIMIT.saturating_sub(3) {
                break;
            }
            output.push(character);
        }
        format!("{output}...")
    };
    let value = |key: &str| {
        payload
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(bounded)
    };
    let method = payload
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let mut lines = Vec::new();
    let mut link = None;
    let mut copy_text = None;
    match method {
        "auth_url" => {
            if let Some(instructions) = value("instructions") {
                lines.push(instructions);
            }
            if let Some(url) = value("url") {
                let line = format!("认证链接: {url}");
                link = Some(OverlayLink {
                    line: lines.len(),
                    label: url.clone(),
                    href: url,
                });
                lines.push(line);
            }
        }
        "auth_device_code" => {
            if let Some(code) = value("userCode") {
                lines.push(format!("设备码: {code}"));
                copy_text = Some(code);
            }
            if let Some(url) = value("verificationUri") {
                let line = format!("验证地址: {url}");
                link = Some(OverlayLink {
                    line: lines.len(),
                    label: url.clone(),
                    href: url,
                });
                lines.push(line);
            }
            for key in ["intervalSeconds", "expiresInSeconds"] {
                if let Some(number) = payload.get(key).and_then(serde_json::Value::as_u64) {
                    lines.push(format!("{key}: {number}"));
                }
            }
        }
        "auth_progress" | "auth_info" => {
            if let Some(message) = value("message") {
                lines.push(message);
            }
        }
        _ => {
            for key in ["message", "text", "status", "key"] {
                if let Some(message) = value(key) {
                    lines.push(format!("{key}: {message}"));
                }
            }
        }
    }
    if lines.is_empty() {
        lines.push("认证状态已更新".to_owned());
    }
    lines.truncate(LINE_LIMIT);
    DetailOverlay {
        title: title.to_owned(),
        lines,
        scroll: 0,
        status: if copy_text.is_some() {
            "c 复制设备码，Esc 返回".to_owned()
        } else {
            "Esc 返回".to_owned()
        },
        link,
        copy_text,
    }
}

pub(in super::super) fn apply_workbench_result(
    app: &mut AppState,
    title: String,
    result: serde_json::Value,
) {
    app.replace_overlay(OverlayState::Detail(DetailOverlay {
        title,
        lines: pretty_json_lines(&result),
        scroll: 0,
        status: "Esc 返回".to_owned(),
        link: None,
        copy_text: None,
    }));
}

pub(in super::super) fn apply_workbench_load(
    app: &mut AppState,
    target: WorkbenchTarget,
    selected_key: Option<String>,
    filter: String,
    result: serde_json::Value,
) -> Result<(), TuiError> {
    match target {
        WorkbenchTarget::Changes => {
            app.git_status = Some(parse_git_status(&result)?);
            app.replace_overlay(changes_overlay(app, selected_key.as_deref(), filter));
        }
        WorkbenchTarget::Skills => {
            app.skills = parse_skills(&result)?;
            app.replace_overlay(skills_overlay(&app.skills, selected_key.as_deref(), filter));
        }
        WorkbenchTarget::Trust => {
            app.trust = Some(parse_trust(&result)?);
            app.replace_overlay(trust_overlay(app));
        }
        WorkbenchTarget::InstructionsProject => {
            app.project_instructions = parse_instructions(&result)?;
            app.replace_overlay(instructions_overlay(
                &app.project_instructions,
                "项目",
                selected_key.as_deref(),
                filter,
            ));
        }
        WorkbenchTarget::InstructionsHost => {
            app.host_instructions = parse_instructions(&result)?;
            app.replace_overlay(instructions_overlay(
                &app.host_instructions,
                "本机",
                selected_key.as_deref(),
                filter,
            ));
        }
        WorkbenchTarget::Packages => {
            app.packages = parse_packages(&result)?;
            app.replace_overlay(packages_overlay(
                &app.packages,
                selected_key.as_deref(),
                filter,
            ));
        }
        WorkbenchTarget::Update => {
            app.update = Some(parse_update(&result)?);
            app.replace_overlay(update_overlay(app));
        }
        WorkbenchTarget::Subagents => {
            let parent_session_path = app.subagent_parent_path.clone().unwrap_or_default();
            app.subagents = parse_subagents(&result, &parent_session_path)?;
            app.replace_overlay(subagents_overlay(
                &app.subagents,
                selected_key.as_deref(),
                filter,
                app.active_session_path(),
            ));
        }
        WorkbenchTarget::Clipboard => {
            return Err(TuiError::InvalidResponse("剪贴板响应路由错误".to_owned()));
        }
        WorkbenchTarget::Settings => {
            app.settings = parse_settings(&result)?;
            app.replace_overlay(settings_overlay(
                &app.settings,
                selected_key.as_deref(),
                filter,
            ));
        }
        WorkbenchTarget::Model => {
            app.models = parse_models(&result)?;
            app.replace_overlay(model_overlay(app, selected_key.as_deref(), filter));
        }
        WorkbenchTarget::Thinking => {
            app.models = parse_models(&result)?;
            app.replace_overlay(thinking_overlay(app));
        }
        WorkbenchTarget::Login => {
            app.providers = parse_providers(&result)?;
            app.replace_overlay(login_overlay(
                &app.providers,
                selected_key.as_deref(),
                filter,
            ));
        }
        WorkbenchTarget::Tree => {
            app.tree = parse_tree(&result)?;
            app.replace_overlay(tree_overlay(
                &app.tree,
                selected_key.as_deref(),
                filter,
                app.tree_filter,
            ));
        }
        WorkbenchTarget::Sessions => {
            return Err(TuiError::InvalidResponse(
                "会话工作台响应路由错误".to_owned(),
            ));
        }
    }
    Ok(())
}

pub(in super::super) fn changes_tab_label(tab: ChangesTab) -> &'static str {
    match tab {
        ChangesTab::Staged => "已暂存",
        ChangesTab::Unstaged => "未暂存",
        ChangesTab::All => "全部",
    }
}

pub(in super::super) fn changes_overlay(
    app: &AppState,
    selected_key: Option<&str>,
    filter: String,
) -> OverlayState {
    let status = app.git_status.as_ref();
    let items = status
        .map(|status| {
            status
                .files
                .iter()
                .enumerate()
                .filter(|(_, file)| match app.changes_tab {
                    ChangesTab::Staged => file.staged,
                    ChangesTab::Unstaged => file.unstaged || file.untracked || file.conflicted,
                    ChangesTab::All => true,
                })
                .map(|(index, file)| {
                    let mut flags = format!(
                        "index:{} worktree:{}",
                        file.index_status, file.worktree_status
                    );
                    if file.conflicted {
                        flags.push_str(" 冲突");
                    } else if file.untracked {
                        flags.push_str(" 未跟踪");
                    }
                    OverlayItem {
                        label: file.path.clone(),
                        detail: flags,
                        action: format!("change:{index}"),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let selected = selected_key
        .and_then(|key| items.iter().position(|item| item.action == key))
        .unwrap_or(0);
    let detail = status.map_or_else(
        || "正在读取".to_owned(),
        |status| {
            format!(
                "{}  upstream:{}  ahead:{} behind:{}",
                status.branch.as_deref().unwrap_or("detached"),
                status.upstream.as_deref().unwrap_or("无"),
                status.ahead,
                status.behind
            )
        },
    );
    OverlayState::List(ListOverlay {
        title: format!("变更 [{}]", changes_tab_label(app.changes_tab)),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: format!("{detail}  Tab 切换  Enter 查看  r 刷新"),
    })
}

pub(in super::super) fn change_detail_overlay(app: &AppState) -> OverlayState {
    let diff = app.change_detail.as_ref().expect("change detail exists");
    let mut lines = vec![format!(
        "{}  {}  +{} -{}",
        diff.path.as_deref().unwrap_or("全部变更"),
        if diff.staged {
            "已暂存"
        } else {
            "未暂存"
        },
        diff.additions,
        diff.deletions
    )];
    if app.change_detail_expanded {
        lines.extend(diff.diff.lines().map(str::to_owned));
    } else if !diff.diff.is_empty() {
        lines.push("Diff 已摘要，按 Ctrl+O 展开".to_owned());
    }
    OverlayState::Detail(DetailOverlay {
        title: "变更详情".to_owned(),
        lines,
        scroll: 0,
        status: if app.change_detail_expanded {
            "Ctrl+O 摘要  Esc 返回".to_owned()
        } else {
            "Ctrl+O 展开  Esc 返回".to_owned()
        },
        link: None,
        copy_text: None,
    })
}

pub(in super::super) fn skills_overlay(
    skills: &[SkillDescriptor],
    selected_key: Option<&str>,
    filter: String,
) -> OverlayState {
    let items = skills
        .iter()
        .enumerate()
        .map(|(index, skill)| OverlayItem {
            label: skill.name.clone(),
            detail: format!(
                "{}  {}  {}  {}",
                skill.source,
                skill.scope,
                if skill.enabled {
                    "已启用"
                } else {
                    "已禁用"
                },
                skill.description
            ),
            action: if skill.eligible {
                format!("skill:{index}")
            } else {
                "disabled:临时 Skill 不支持修改启用状态".to_owned()
            },
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|key| items.iter().position(|item| item.action == key))
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: "技能".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: "Enter 选择作用域并切换，输入筛选，r 刷新".to_owned(),
    })
}

pub(in super::super) fn trust_overlay(app: &AppState) -> OverlayState {
    let trust = app.trust.as_ref();
    let trusted = trust.and_then(|value| value.trusted);
    let state = match trusted {
        Some(true) => "已信任",
        Some(false) => "不信任",
        None => "未选择",
    };
    let detail = trust.map_or_else(
        || "正在读取".to_owned(),
        |value| {
            format!(
                "{}  风险:{}  {}",
                value.cwd,
                if value.resource_risk { "有" } else { "无" },
                value.reason
            )
        },
    );
    OverlayState::List(ListOverlay {
        title: "项目信任".to_owned(),
        origin: OverlayOrigin::User,
        items: vec![OverlayItem {
            label: state.to_owned(),
            detail,
            action: "trust:toggle".to_owned(),
        }],
        selected: 0,
        filter: String::new(),
        status: "t 或 Enter 切换，需确认".to_owned(),
    })
}

pub(in super::super) fn instructions_overlay(
    instructions: &[InstructionDescriptor],
    scope: &str,
    selected_key: Option<&str>,
    filter: String,
) -> OverlayState {
    let scope_key = if scope == "项目" { "project" } else { "host" };
    let items = instructions
        .iter()
        .enumerate()
        .map(|(index, instruction)| OverlayItem {
            label: instruction.file_name.clone(),
            detail: format!(
                "{} {} {} {}",
                if instruction.exists {
                    "存在"
                } else {
                    "不存在"
                },
                if instruction.active {
                    "生效"
                } else {
                    "未生效"
                },
                if instruction.editable {
                    "可编辑"
                } else {
                    "只读"
                },
                instruction.path
            ),
            action: if instruction.editable {
                format!("instruction:{scope_key}:{index}")
            } else {
                "disabled:此指令文件不允许编辑".to_owned()
            },
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|key| items.iter().position(|item| item.action == key))
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: format!("指令 [{scope}]"),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: "Tab 切换项目/本机，Enter 完整编辑，r 刷新".to_owned(),
    })
}

pub(in super::super) fn packages_overlay(
    packages: &[PackageDescriptor],
    selected_key: Option<&str>,
    filter: String,
) -> OverlayState {
    let items = packages
        .iter()
        .enumerate()
        .map(|(index, package)| OverlayItem {
            label: package.source.clone(),
            detail: format!(
                "{}  {}  {}",
                package.scope,
                package.installed_path.as_deref().unwrap_or("未解析"),
                if package.filtered {
                    "已过滤"
                } else {
                    "已配置"
                }
            ),
            action: format!("package:{index}"),
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|key| items.iter().position(|item| item.action == key))
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: "包".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: "i 安装  d 删除  u 更新当前  U 更新全部  r 刷新".to_owned(),
    })
}

pub(in super::super) fn subagent_running(state: &str) -> bool {
    matches!(state, "queued" | "running" | "waiting")
}

pub(in super::super) fn subagents_overlay(
    snapshots: &[SubagentDescriptor],
    selected_key: Option<&str>,
    filter: String,
    active_session_path: Option<&str>,
) -> OverlayState {
    let items = snapshots
        .iter()
        .enumerate()
        .map(|(index, snapshot)| {
            let mut detail = format!(
                "run:{}  {}  {}  {}ms",
                snapshot.run_id, snapshot.source, snapshot.state, snapshot.elapsed_ms
            );
            if let Some(action) = &snapshot.current_action {
                detail.push_str(&format!("  {action}"));
            }
            OverlayItem {
                label: snapshot.name.clone(),
                detail,
                action: format!("subagent:{index}"),
            }
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|key| items.iter().position(|item| item.action == key))
        .unwrap_or(0);
    let controllable = snapshots.iter().any(|snapshot| {
        snapshot.parent_session_path == active_session_path.unwrap_or_default()
            && snapshot.controllable
            && (subagent_running(&snapshot.state) || snapshot.session_file.is_some())
    });
    OverlayState::List(ListOverlay {
        title: "Subagent".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: if controllable {
            "Enter 详情  a 停止运行项  c 继续已结束项  r 刷新".to_owned()
        } else {
            "Enter 详情  r 刷新".to_owned()
        },
    })
}

pub(in super::super) fn subagent_detail_overlay(snapshot: &SubagentDescriptor) -> OverlayState {
    let mut lines = vec![
        format!("runId: {}", snapshot.run_id),
        format!("agentId: {}", snapshot.agent_id),
        format!("名称: {}", snapshot.name),
        format!("来源: {}", snapshot.source),
        format!("状态: {}", snapshot.state),
        format!("任务: {}", bounded_text(&snapshot.task, 4096)),
        format!("更新时间: {}", snapshot.updated_at),
        format!("耗时: {}ms", snapshot.elapsed_ms),
    ];
    if let Some(action) = &snapshot.current_action {
        lines.push(format!("当前 Tool: {}", bounded_text(action, 4096)));
    }
    if let Some(cwd) = &snapshot.session_cwd {
        lines.push(format!("session cwd: {cwd}"));
    }
    if let Some(path) = &snapshot.session_file {
        lines.push(format!("session path: {path}"));
    } else {
        lines.push("未提供持久 Session，显示状态摘要".to_owned());
    }
    OverlayState::Detail(DetailOverlay {
        title: "Subagent 详情".to_owned(),
        lines,
        scroll: 0,
        status: if snapshot.session_file.is_some() {
            "Enter 查看嵌套 Subagent  v 只读记录  Esc 返回".to_owned()
        } else {
            "Esc 返回".to_owned()
        },
        link: None,
        copy_text: None,
    })
}

pub(in super::super) fn clipboard_preview(text: &str) -> String {
    bounded_text(text, 1024).replace('\n', "\\n")
}

pub(in super::super) fn clipboard_overlay(
    clipboard: &ClipboardDescriptor,
    image: Option<&ComposerAttachment>,
) -> OverlayState {
    let mut lines = vec![format!(
        "文本剪贴板: {}",
        if clipboard.capability {
            "支持"
        } else {
            "不支持"
        }
    )];
    lines.push(match image {
        Some(image) => format!(
            "图片剪贴板: {} {} B #{}",
            image.mime_type,
            image.byte_length,
            &image.content_hash[..image.content_hash.len().min(12)]
        ),
        None => "图片剪贴板: 没有图片".to_owned(),
    });
    lines.push(match &clipboard.text {
        Some(text) => format!("预览: {}", clipboard_preview(text)),
        None => "预览: 空或 Host 未返回文本".to_owned(),
    });
    OverlayState::Detail(DetailOverlay {
        title: "剪贴板".to_owned(),
        lines,
        scroll: 0,
        status: "i 插入输入框  w 写入输入框  c 复制预览  Esc 返回".to_owned(),
        link: None,
        copy_text: clipboard.text.clone(),
    })
}

pub(in super::super) fn update_overlay(app: &AppState) -> OverlayState {
    let update = app.update.as_ref().expect("update exists");
    let mut lines = vec![format!("当前: {}", update.current_version)];
    lines.push(format!(
        "最新: {}  状态: {}",
        update.latest_version.as_deref().unwrap_or("未知"),
        update.status
    ));
    if let Some(url) = &update.url {
        lines.push(format!("地址: {url}"));
    }
    if let Some(note) = &update.note {
        lines.push(format!("说明: {}", bounded_text(note, 1024)));
    }
    lines.push(format!("仅检查版本: {}", update.install_blocked_reason));
    OverlayState::Detail(DetailOverlay {
        title: "更新检查".to_owned(),
        lines,
        scroll: 0,
        status: "r 重新检查  Esc 返回".to_owned(),
        link: None,
        copy_text: None,
    })
}

pub(in super::super) fn bounded_text(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let mut output = String::new();
    for character in value.chars() {
        if output.len() + character.len_utf8() > max.saturating_sub(3) {
            break;
        }
        output.push(character);
    }
    format!("{output}...")
}

pub(in super::super) fn settings_overlay(
    settings: &[SettingDescriptor],
    selected_key: Option<&str>,
    filter: String,
) -> OverlayState {
    let items = settings
        .iter()
        .map(|setting| {
            let scope = if setting.scope == "global" {
                "全局"
            } else {
                "项目"
            };
            let mut detail = format!("{}  {}", setting.display_value, scope);
            if setting.restart_required {
                detail.push_str("  重启后生效");
            }
            if setting.read_only {
                detail.push_str("  只读");
            }
            let action = if setting.read_only {
                "disabled:此设置为只读".to_owned()
            } else {
                match setting.kind.as_str() {
                    "boolean" => format!("setting-toggle:{}", setting.id),
                    "enum" => format!("setting-enum:{}", setting.id),
                    "integer" | "string" => format!("setting-text:{}", setting.id),
                    _ => "disabled:不支持的设置类型".to_owned(),
                }
            };
            OverlayItem {
                label: setting.label.clone(),
                detail,
                action,
            }
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|id| settings.iter().position(|setting| setting.id == id))
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: "设置".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: "Enter 修改，输入筛选，Esc 返回".to_owned(),
    })
}

pub(in super::super) fn model_overlay(
    app: &AppState,
    selected_key: Option<&str>,
    filter: String,
) -> OverlayState {
    let current = app
        .snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.model.as_ref());
    let items = app
        .models
        .iter()
        .enumerate()
        .map(|(index, model)| {
            let current_marker = current.is_some_and(|selected| {
                selected.provider == model.provider && selected.id == model.id
            });
            let detail = format!(
                "{}/{}  输入:{}  上下文:{}  推理:{}  {}{}",
                model.provider,
                model.id,
                model.input.join("+"),
                model.context_window,
                if model.reasoning {
                    "支持"
                } else {
                    "不支持"
                },
                if model.configured {
                    "已认证"
                } else {
                    "未认证"
                },
                if current_marker { "  当前" } else { "" },
            );
            OverlayItem {
                label: model.name.clone(),
                detail,
                action: if model.configured {
                    format!("model:{index}")
                } else {
                    "disabled:该模型不可用，Provider 未完成认证".to_owned()
                },
            }
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|key| {
            app.models
                .iter()
                .position(|model| format!("{}/{}", model.provider, model.id) == key)
        })
        .or_else(|| {
            current.and_then(|selected| {
                app.models.iter().position(|model| {
                    model.provider == selected.provider && model.id == selected.id
                })
            })
        })
        .unwrap_or(0);
    let selected = if filter.is_empty()
        || items.get(selected).is_some_and(|item| {
            format!("{} {}", item.label, item.detail)
                .to_lowercase()
                .contains(&filter.to_lowercase())
        }) {
        selected
    } else {
        items
            .iter()
            .position(|item| {
                format!("{} {}", item.label, item.detail)
                    .to_lowercase()
                    .contains(&filter.to_lowercase())
            })
            .unwrap_or(0)
    };
    OverlayState::List(ListOverlay {
        title: "模型".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: "Enter 切换模型，输入筛选，Esc 返回".to_owned(),
    })
}

pub(in super::super) fn thinking_level_label(level: &str) -> &'static str {
    match level {
        "off" => "关闭",
        "minimal" => "极简",
        "low" => "低",
        "medium" => "中",
        "high" => "高",
        "xhigh" => "超高",
        "max" => "最大",
        _ => "未知",
    }
}

fn thinking_level_description(level: &str) -> &'static str {
    match level {
        "off" => "关闭思考",
        "minimal" => "约 1k tokens",
        "low" => "约 2k tokens",
        "medium" => "约 8k tokens",
        "high" => "约 16k tokens",
        "xhigh" => "约 32k tokens",
        "max" => "最大强度思考",
        _ => "未知强度",
    }
}

pub(in super::super) fn thinking_overlay(app: &AppState) -> OverlayState {
    let current = app
        .snapshot
        .as_ref()
        .map(|snapshot| snapshot.thinking_level.as_str())
        .unwrap_or("off");
    match app.model_supports_reasoning() {
        Ok(model) => OverlayState::List(ListOverlay {
            title: "思考".to_owned(),
            origin: OverlayOrigin::User,
            items: model
                .supported_thinking_levels
                .iter()
                .map(|level| OverlayItem {
                    label: thinking_level_label(level).to_owned(),
                    detail: if level == current {
                        format!("{}  当前", thinking_level_description(level))
                    } else {
                        thinking_level_description(level).to_owned()
                    },
                    action: format!("thinking:{level}"),
                })
                .collect(),
            selected: model
                .supported_thinking_levels
                .iter()
                .position(|level| level == current)
                .unwrap_or(0),
            filter: String::new(),
            status: "Enter 切换思考强度，Esc 返回".to_owned(),
        }),
        Err(reason) => OverlayState::List(ListOverlay {
            title: "思考".to_owned(),
            origin: OverlayOrigin::User,
            items: vec![OverlayItem {
                label: "当前模型不可用".to_owned(),
                detail: reason.clone(),
                action: format!("disabled:{reason}"),
            }],
            selected: 0,
            filter: String::new(),
            status: "Esc 返回".to_owned(),
        }),
    }
}

pub(in super::super) fn login_overlay(
    providers: &[ProviderDescriptor],
    selected_key: Option<&str>,
    filter: String,
) -> OverlayState {
    let items = providers
        .iter()
        .enumerate()
        .map(|(index, provider)| OverlayItem {
            label: provider.name.clone(),
            detail: format!(
                "{}  认证:{}  模型:{}{}",
                provider.id,
                if provider.configured {
                    "已配置"
                } else {
                    "未配置"
                },
                provider.model_count,
                if provider.auth_methods.is_empty() {
                    "  无认证方式".to_owned()
                } else {
                    format!("  {}", provider.auth_methods.join("/"))
                },
            ),
            action: if provider.auth_methods.is_empty() {
                "disabled:该 Provider 没有可用认证方式".to_owned()
            } else {
                format!("login-provider:{index}")
            },
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|id| providers.iter().position(|provider| provider.id == id))
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: "登录".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: "Enter 选择认证方式，d 退出登录，Esc 返回".to_owned(),
    })
}

pub(in super::super) fn session_overlay(
    sessions: &[SessionSummary],
    selected_path: Option<&str>,
    origin: OverlayOrigin,
) -> OverlayState {
    let selected = selected_path
        .and_then(|path| sessions.iter().position(|session| session.path == path))
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: "会话".to_owned(),
        origin,
        items: sessions
            .iter()
            .enumerate()
            .map(|(index, session)| OverlayItem {
                label: session
                    .name
                    .clone()
                    .unwrap_or_else(|| session.first_message.clone()),
                detail: format!(
                    "{}  {}  {}",
                    session.path, session.activity, session.updated_at
                ),
                action: format!("session:{index}"),
            })
            .collect(),
        selected,
        filter: String::new(),
        status: "n 新建  Enter 切换  v 只读  r 重命名  d 删除  f 分叉".to_owned(),
    })
}

pub(in super::super) fn tree_overlay(
    nodes: &[SessionTreeNode],
    selected_key: Option<&str>,
    filter: String,
    tree_filter: TreeFilter,
) -> OverlayState {
    let visible = nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| match tree_filter {
            TreeFilter::Default | TreeFilter::All => true,
            TreeFilter::NoTools => node.kind != "tool",
            TreeFilter::UserOnly => node.kind == "user",
            TreeFilter::LabeledOnly => node.label.is_some(),
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|id| visible.iter().position(|(_, node)| node.id == id))
        .or_else(|| visible.iter().position(|(_, node)| node.is_leaf))
        .unwrap_or(0);
    let mode = match tree_filter {
        TreeFilter::Default => "default",
        TreeFilter::NoTools => "no-tools",
        TreeFilter::UserOnly => "user-only",
        TreeFilter::LabeledOnly => "labeled-only",
        TreeFilter::All => "all",
    };
    OverlayState::List(ListOverlay {
        title: "分支树".to_owned(),
        origin: OverlayOrigin::User,
        items: visible
            .into_iter()
            .map(|(index, node)| OverlayItem {
                label: format!(
                    "{}{} {}",
                    "  ".repeat(node.depth),
                    if node.is_leaf { "*" } else { "-" },
                    node.label.as_deref().unwrap_or(&node.kind)
                ),
                detail: format!("{}  {}", node.timestamp, node.preview),
                action: format!("tree:{index}"),
            })
            .collect(),
        selected,
        filter,
        status: format!(
            "[{mode}] Ctrl+D 默认 Ctrl+T 无工具 Ctrl+U 用户 Ctrl+L 标签 Ctrl+A 全部  Enter 跳转 s 摘要 l 标签 f 分叉"
        ),
    })
}
