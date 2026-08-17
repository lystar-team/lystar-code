use std::collections::HashMap;

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
pub struct LiveTool {
    pub name: String,
    pub summary: String,
    pub status: LiveToolStatus,
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
}

#[derive(Debug, Clone, Default)]
pub struct LiveTools {
    order: Vec<String>,
    tools: HashMap<String, LiveTool>,
}

impl LiveTools {
    pub fn start(&mut self, tool_call_id: String, name: String, summary: String) {
        self.upsert(tool_call_id, name, summary, LiveToolStatus::Running);
    }

    pub fn update(&mut self, tool_call_id: String, name: String, summary: String) {
        if let Some(tool) = self.tools.get_mut(&tool_call_id) {
            tool.name = name;
            tool.summary = summary;
            return;
        }
        self.upsert(tool_call_id, name, summary, LiveToolStatus::Pending);
    }

    pub fn finish(&mut self, tool_call_id: String, name: String, status: &str, summary: String) {
        self.upsert(
            tool_call_id,
            name,
            summary,
            LiveToolStatus::from_tool_end(status),
        );
    }

    pub fn settle_active(&mut self, status: LiveToolStatus) {
        for tool in self.tools.values_mut() {
            if tool.status.is_active() {
                tool.status = status;
            }
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

    fn upsert(
        &mut self,
        tool_call_id: String,
        name: String,
        summary: String,
        status: LiveToolStatus,
    ) {
        if let Some(tool) = self.tools.get_mut(&tool_call_id) {
            tool.name = name;
            tool.summary = summary;
            tool.status = status;
            return;
        }
        self.order.push(tool_call_id.clone());
        self.tools.insert(
            tool_call_id,
            LiveTool {
                name,
                summary,
                status,
            },
        );
    }
}
