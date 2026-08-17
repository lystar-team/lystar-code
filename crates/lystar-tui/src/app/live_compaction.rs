#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionStatus {
    Running,
    Completed,
    Cancelled,
    Failed,
    WaitingRetry,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveCompaction {
    pub status: CompactionStatus,
    reason: String,
    error: Option<String>,
}

impl LiveCompaction {
    pub fn new(status: &str, reason: String, error: Option<String>) -> Self {
        Self {
            status: match status {
                "completed" => CompactionStatus::Completed,
                "cancelled" => CompactionStatus::Cancelled,
                "waiting_retry" => CompactionStatus::WaitingRetry,
                "failed" => CompactionStatus::Failed,
                _ => CompactionStatus::Running,
            },
            reason,
            error,
        }
    }

    pub fn display(&self) -> String {
        let reason = match self.reason.as_str() {
            "manual" => "手动",
            "threshold" => "达到上下文阈值",
            "overflow" => "上下文溢出",
            _ => "上下文管理",
        };
        let status = match self.status {
            CompactionStatus::Running => "正在压缩上下文",
            CompactionStatus::Completed => "上下文压缩完成",
            CompactionStatus::Cancelled => "上下文压缩已取消",
            CompactionStatus::Failed => "上下文压缩失败",
            CompactionStatus::WaitingRetry => "上下文压缩失败，等待重试",
        };
        self.error
            .as_deref()
            .filter(|error| !error.is_empty())
            .map_or_else(
                || format!("{status}  {reason}"),
                |error| format!("{status}  {reason}  {error}"),
            )
    }
}
