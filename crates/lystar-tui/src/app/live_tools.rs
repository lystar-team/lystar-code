use std::collections::HashMap;

use lystar_protocol::ToolDiff;

use super::{
    live_bash::LiveBash,
    live_diff::{DiffLineKind, LiveDiff},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveToolStatus {
    Pending,
    Running,
    Success,
    Error,
    Cancelled,
}

impl LiveToolStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Pending => "等待中",
            Self::Running => "运行中",
            Self::Success => "已完成",
            Self::Error => "错误",
            Self::Cancelled => "已取消",
        }
    }

    pub fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::Running)
    }

    fn from_tool_end(status: &str) -> Self {
        match status {
            "success" => Self::Success,
            "cancelled" => Self::Cancelled,
            _ => Self::Error,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveToolLine {
    pub text: String,
    pub diff_kind: Option<DiffLineKind>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveTool {
    pub name: String,
    pub summary: String,
    pub status: LiveToolStatus,
    bash: Option<LiveBash>,
    diff: Option<LiveDiff>,
}

impl LiveTool {
    pub fn display(&self) -> String {
        if self.summary.is_empty() {
            format!("工具 {} {}", self.name, self.status.label())
        } else {
            format!(
                "工具 {} {}  {}",
                self.name,
                self.status.label(),
                self.summary
            )
        }
    }

    pub fn display_lines(&self) -> Vec<String> {
        self.rendered_lines()
            .into_iter()
            .map(|line| line.text)
            .collect()
    }

    pub fn rendered_lines(&self) -> Vec<LiveToolLine> {
        if let Some(bash) = &self.bash {
            return bash
                .display_lines(self.status)
                .into_iter()
                .map(|text| LiveToolLine {
                    text,
                    diff_kind: None,
                })
                .collect();
        }
        let mut lines = vec![LiveToolLine {
            text: self.display(),
            diff_kind: None,
        }];
        if let Some(diff) = &self.diff {
            lines.extend(diff.display_lines().into_iter().map(|line| LiveToolLine {
                text: line.text,
                diff_kind: Some(line.kind),
            }));
        }
        lines
    }

    #[cfg(test)]
    pub(crate) fn bash(&self) -> Option<&LiveBash> {
        self.bash.as_ref()
    }
}

#[derive(Debug, Clone, Default)]
pub struct LiveTools {
    order: Vec<String>,
    tools: HashMap<String, LiveTool>,
}

impl LiveTools {
    pub fn start(
        &mut self,
        tool_call_id: String,
        name: String,
        summary: String,
        diff: Option<ToolDiff>,
    ) {
        if name == "bash" {
            self.start_bash(tool_call_id, summary);
        } else {
            self.upsert(tool_call_id, name, summary, LiveToolStatus::Running, diff);
        }
    }

    pub fn update(
        &mut self,
        tool_call_id: String,
        name: String,
        summary: String,
        diff: Option<ToolDiff>,
    ) {
        if name == "bash" {
            self.update_bash(tool_call_id, summary);
            return;
        }
        if let Some(tool) = self.tools.get_mut(&tool_call_id) {
            tool.name = name;
            tool.summary = summary;
            if let Some(diff) = diff {
                tool.diff
                    .get_or_insert_with(LiveDiff::default)
                    .replace_snapshot(&diff);
            }
            return;
        }
        self.upsert(tool_call_id, name, summary, LiveToolStatus::Pending, diff);
    }

    pub fn finish(
        &mut self,
        tool_call_id: String,
        name: String,
        status: &str,
        summary: String,
        diff: Option<ToolDiff>,
    ) {
        if name == "bash" {
            self.finish_bash(tool_call_id, status, summary);
        } else {
            self.upsert(
                tool_call_id,
                name,
                summary,
                LiveToolStatus::from_tool_end(status),
                diff,
            );
        }
    }

    pub fn settle_active(&mut self, status: LiveToolStatus) {
        for tool in self.tools.values_mut() {
            if tool.status.is_active() {
                tool.status = status;
            }
        }
    }

    pub fn apply_bash_operation(
        &mut self,
        operation_id: String,
        command: String,
        output: String,
        status: LiveToolStatus,
    ) {
        if !self.tools.contains_key(&operation_id) {
            self.start_bash(operation_id.clone(), command);
        }
        self.update_bash(operation_id.clone(), output);
        if let Some(tool) = self.tools.get_mut(&operation_id) {
            tool.status = status;
        }
    }

    pub fn remove(&mut self, tool_call_id: &str) {
        self.tools.remove(tool_call_id);
        self.order.retain(|id| id != tool_call_id);
    }

    pub fn clear(&mut self) {
        self.order.clear();
        self.tools.clear();
    }

    pub fn get(&self, tool_call_id: &str) -> Option<&LiveTool> {
        self.tools.get(tool_call_id)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &LiveTool)> {
        self.order
            .iter()
            .filter_map(|id| self.tools.get(id).map(|tool| (id.as_str(), tool)))
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    pub fn toggle_output_expansion(&mut self) -> bool {
        let expanded = !self
            .order
            .iter()
            .rev()
            .filter_map(|id| self.tools.get(id))
            .find_map(|tool| {
                tool.bash
                    .as_ref()
                    .filter(|bash| bash.has_output())
                    .map(LiveBash::is_expanded)
                    .or_else(|| {
                        tool.diff
                            .as_ref()
                            .filter(|diff| diff.has_expandable_diff())
                            .map(LiveDiff::is_expanded)
                    })
            })
            .unwrap_or(false);
        let mut changed = false;
        for tool in self.tools.values_mut() {
            if let Some(bash) = &mut tool.bash {
                bash.set_expanded(expanded);
                changed = true;
            }
            if let Some(diff) = &mut tool.diff
                && diff.has_expandable_diff()
            {
                diff.set_expanded(expanded);
                changed = true;
            }
        }
        changed
    }

    fn start_bash(&mut self, tool_call_id: String, command: String) {
        if let Some(tool) = self.tools.get_mut(&tool_call_id) {
            tool.name = "bash".to_owned();
            tool.summary = command.clone();
            tool.status = LiveToolStatus::Running;
            tool.bash = Some(LiveBash::new(command));
            return;
        }
        self.order.push(tool_call_id.clone());
        self.tools.insert(
            tool_call_id,
            LiveTool {
                name: "bash".to_owned(),
                summary: command.clone(),
                status: LiveToolStatus::Running,
                bash: Some(LiveBash::new(command)),
                diff: None,
            },
        );
    }

    fn update_bash(&mut self, tool_call_id: String, output: String) {
        if !self.tools.contains_key(&tool_call_id) {
            self.start_bash(tool_call_id.clone(), String::new());
            if let Some(tool) = self.tools.get_mut(&tool_call_id) {
                tool.status = LiveToolStatus::Pending;
            }
        }
        if let Some(tool) = self.tools.get_mut(&tool_call_id) {
            tool.name = "bash".to_owned();
            tool.summary = output.clone();
            if let Some(bash) = &mut tool.bash {
                bash.replace_output(output);
            }
        }
    }

    fn finish_bash(&mut self, tool_call_id: String, status: &str, output: String) {
        self.update_bash(tool_call_id.clone(), output);
        if let Some(tool) = self.tools.get_mut(&tool_call_id) {
            tool.status = LiveToolStatus::from_tool_end(status);
        }
    }

    fn upsert(
        &mut self,
        tool_call_id: String,
        name: String,
        summary: String,
        status: LiveToolStatus,
        diff: Option<ToolDiff>,
    ) {
        if let Some(tool) = self.tools.get_mut(&tool_call_id) {
            tool.name = name;
            tool.summary = summary;
            tool.status = status;
            if let Some(diff) = diff {
                tool.diff
                    .get_or_insert_with(LiveDiff::default)
                    .replace_snapshot(&diff);
            }
            return;
        }
        let mut live_diff = None;
        if let Some(diff) = diff {
            let mut value = LiveDiff::default();
            value.replace_snapshot(&diff);
            live_diff = Some(value);
        }
        self.order.push(tool_call_id.clone());
        self.tools.insert(
            tool_call_id,
            LiveTool {
                name,
                summary,
                status,
                bash: None,
                diff: live_diff,
            },
        );
    }
}
