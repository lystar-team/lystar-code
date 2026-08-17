#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryStatus {
    Waiting,
    Running,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveRetry {
    pub status: RetryStatus,
    kind: String,
    attempt: Option<u64>,
    max_attempts: Option<u64>,
    delay_ms: Option<u64>,
    error: Option<String>,
}

impl LiveRetry {
    pub fn update(
        previous: Option<Self>,
        status: &str,
        kind: String,
        attempt: Option<u64>,
        max_attempts: Option<u64>,
        delay_ms: Option<u64>,
        error: Option<String>,
    ) -> Option<Self> {
        if status == "completed" {
            return None;
        }
        let previous = previous.as_ref();
        Some(Self {
            status: match status {
                "failed" => RetryStatus::Failed,
                "running" => RetryStatus::Running,
                _ => RetryStatus::Waiting,
            },
            kind,
            attempt: attempt.or_else(|| previous.and_then(|value| value.attempt)),
            max_attempts: max_attempts.or_else(|| previous.and_then(|value| value.max_attempts)),
            delay_ms: if status == "waiting" {
                delay_ms.or_else(|| previous.and_then(|value| value.delay_ms))
            } else {
                delay_ms
            },
            error: error.or_else(|| previous.and_then(|value| value.error.clone())),
        })
    }

    pub fn display(&self) -> String {
        let target = match self.kind.as_str() {
            "model" => "模型请求",
            "compaction" => "上下文压缩",
            "branch_summary" => "分支摘要",
            _ => "摘要生成",
        };
        let status = match self.status {
            RetryStatus::Waiting => format!("{target}重试中"),
            RetryStatus::Running => format!("正在重试{target}"),
            RetryStatus::Failed => format!("{target}重试失败"),
        };
        let attempt = match (self.attempt, self.max_attempts) {
            (Some(attempt), Some(max_attempts)) => format!("第 {attempt}/{max_attempts} 次"),
            (Some(attempt), None) => format!("第 {attempt} 次"),
            _ => String::new(),
        };
        let delay = self
            .delay_ms
            .filter(|delay| *delay > 0)
            .map_or(String::new(), |delay| {
                format!("等待 {:.1}s", delay as f64 / 1000.0)
            });
        [
            status,
            attempt,
            delay,
            self.error.clone().unwrap_or_default(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("  ")
    }
}
