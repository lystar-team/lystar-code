use std::{collections::BTreeMap, time::Instant};

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
    widgets::Widget,
};
use unicode_width::UnicodeWidthStr;

use crate::rich_text::plain_ansi_line;

use super::AppState;
use super::transcript::{put_ansi_line, put_line};
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionWidget {
    pub key: String,
    pub placement: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionComponentOverlayOptions {
    pub width: Option<String>,
    pub max_height: Option<String>,
    pub anchor: Option<String>,
    pub row: Option<String>,
    pub column: Option<String>,
    pub overlay: bool,
}

impl Default for ExtensionComponentOverlayOptions {
    fn default() -> Self {
        Self {
            width: None,
            max_height: None,
            anchor: None,
            row: None,
            column: None,
            overlay: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionComponentState {
    pub component_id: String,
    pub generation: u64,
    pub revision: u64,
    pub placement: String,
    pub visible: bool,
    pub lines: Vec<String>,
    pub cursor: Option<(u16, u16)>,
    pub hit_regions: Vec<(u16, u16, u16)>,
    pub desired_size: Option<(u16, u16)>,
    pub overlay_options: ExtensionComponentOverlayOptions,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingComponentInput {
    pub component_id: String,
    pub generation: u64,
    pub data: String,
    pub started_at: Instant,
}

impl ExtensionComponentState {
    fn accepts(&self, generation: u64, revision: u64) -> bool {
        self.generation == generation && revision >= self.revision
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionUiState {
    pub revision: u64,
    pub statuses: BTreeMap<String, String>,
    pub widgets: Vec<ExtensionWidget>,
    pub working_message: Option<String>,
    pub working_visible: bool,
    pub working_frames: Vec<String>,
    pub working_interval_ms: u64,
    pub hidden_thinking_label: Option<String>,
    pub title: Option<String>,
    pub terminal_input_listener_count: u64,
    pub components: BTreeMap<String, ExtensionComponentState>,
}

impl Default for ExtensionUiState {
    fn default() -> Self {
        Self {
            revision: 0,
            statuses: BTreeMap::new(),
            widgets: Vec::new(),
            working_message: None,
            working_visible: true,
            working_frames: vec![
                "-".to_owned(),
                "\\".to_owned(),
                "|".to_owned(),
                "/".to_owned(),
            ],
            working_interval_ms: 120,
            hidden_thinking_label: None,
            title: None,
            terminal_input_listener_count: 0,
            components: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingTerminalInput {
    pub data: String,
    pub started_at: Instant,
}

impl AppState {
    pub fn composer_height(&self, total_height: u16) -> u16 {
        let base: u16 = if total_height <= 8 { 4 } else { 6 };
        base.saturating_add(self.extension_widget_budget(total_height))
    }

    pub fn extension_widget_budget(&self, total_height: u16) -> u16 {
        if total_height <= 8 {
            return 0;
        }
        let lines = self
            .extension_ui
            .widgets
            .iter()
            .map(|widget| widget.lines.len())
            .sum::<usize>()
            + self.extension_component_lines("widget_above").len()
            + self.extension_component_lines("widget_below").len();
        u16::try_from(lines.min(8))
            .unwrap_or(8)
            .min(total_height.saturating_sub(8))
    }

    pub fn extension_widget_lines(&self, budget: usize) -> (Vec<&str>, Vec<&str>, usize) {
        let total = self
            .extension_ui
            .widgets
            .iter()
            .map(|widget| widget.lines.len())
            .sum::<usize>()
            + self.extension_component_lines("widget_above").len()
            + self.extension_component_lines("widget_below").len();
        let visible_budget = budget.saturating_sub(usize::from(total > budget));
        let mut above = Vec::new();
        let mut below = Vec::new();
        for placement in ["above", "below"] {
            for widget in self
                .extension_ui
                .widgets
                .iter()
                .filter(|widget| widget.placement == placement)
            {
                for line in &widget.lines {
                    if above.len().saturating_add(below.len()) >= visible_budget {
                        return (above, below, total.saturating_sub(visible_budget));
                    }
                    if placement == "above" {
                        above.push(line.as_str());
                    } else {
                        below.push(line.as_str());
                    }
                }
            }
        }
        for component_placement in ["widget_above", "widget_below"] {
            let target = if component_placement == "widget_above" {
                "above"
            } else {
                "below"
            };
            for line in self.extension_component_lines(component_placement) {
                if above.len().saturating_add(below.len()) >= visible_budget {
                    return (above, below, total.saturating_sub(visible_budget));
                }
                if target == "above" {
                    above.push(line);
                } else {
                    below.push(line);
                }
            }
        }
        (above, below, 0)
    }

    pub fn extension_component_lines(&self, placement: &str) -> Vec<&str> {
        self.extension_ui
            .components
            .values()
            .filter(|component| component.visible && component.placement == placement)
            .flat_map(|component| component.lines.iter().map(String::as_str))
            .collect()
    }

    pub fn active_extension_editor(&self) -> Option<&ExtensionComponentState> {
        self.extension_ui
            .components
            .values()
            .find(|component| component.visible && component.placement == "editor")
    }

    pub fn apply_extension_component_mount(&mut self, component: ExtensionComponentState) -> bool {
        if self
            .extension_ui
            .components
            .get(&component.component_id)
            .is_some_and(|current| current.generation >= component.generation)
        {
            return false;
        }
        self.extension_ui
            .components
            .insert(component.component_id.clone(), component);
        true
    }

    pub fn apply_extension_component_frame(
        &mut self,
        component_id: &str,
        generation: u64,
        revision: u64,
        lines: Vec<String>,
        cursor: Option<(u16, u16)>,
        hit_regions: Vec<(u16, u16, u16)>,
    ) -> bool {
        let Some(component) = self.extension_ui.components.get_mut(component_id) else {
            return false;
        };
        if !component.accepts(generation, revision) {
            return false;
        }
        component.revision = revision;
        component.lines = lines;
        component.cursor = cursor;
        component.hit_regions = hit_regions;
        true
    }

    pub fn component_hit(
        &self,
        component_id: &str,
        generation: u64,
        row: u16,
        column: u16,
    ) -> bool {
        self.extension_ui
            .components
            .get(component_id)
            .is_some_and(|component| {
                component.generation == generation
                    && component.visible
                    && component
                        .hit_regions
                        .iter()
                        .any(|(region_row, region_column, width)| {
                            row == *region_row
                                && column >= *region_column
                                && column < region_column.saturating_add(*width)
                        })
            })
    }

    pub fn apply_extension_component_visibility(
        &mut self,
        component_id: &str,
        generation: u64,
        visible: bool,
    ) -> bool {
        let Some(component) = self.extension_ui.components.get_mut(component_id) else {
            return false;
        };
        if component.generation != generation {
            return false;
        }
        component.visible = visible;
        true
    }

    pub fn remove_extension_component(&mut self, component_id: &str, generation: u64) -> bool {
        if self
            .extension_ui
            .components
            .get(component_id)
            .is_some_and(|component| component.generation == generation)
        {
            self.extension_ui.components.remove(component_id);
            return true;
        }
        false
    }

    pub fn active_extension_overlay(&self) -> Option<&ExtensionComponentState> {
        self.extension_ui
            .components
            .values()
            .find(|component| component.visible && component.placement == "custom_overlay")
    }

    pub fn extension_header_lines(&self, budget: usize) -> Vec<&str> {
        self.extension_component_lines("header")
            .into_iter()
            .take(budget)
            .collect()
    }

    pub fn extension_footer_line(&self) -> Option<String> {
        self.extension_component_lines("footer")
            .into_iter()
            .next()
            .map(plain_ansi_line)
    }

    pub fn apply_extension_ui_snapshot(&mut self, state: ExtensionUiState) -> bool {
        if state.revision < self.extension_ui.revision {
            return false;
        }
        self.extension_ui = state;
        true
    }

    pub fn apply_extension_editor_action(
        &mut self,
        action: &str,
        text: &str,
        revision: u64,
    ) -> bool {
        if revision < self.extension_ui.revision || text.len() > crate::editor::MAX_EDITOR_BYTES {
            return false;
        }
        if action == "paste" {
            self.editor.insert(text);
        } else if action == "set" {
            self.editor.replace(text);
        } else {
            return false;
        }
        self.extension_ui.revision = revision;
        self.synced_editor_text.clear();
        self.synced_editor_cursor = usize::MAX;
        true
    }

    pub fn take_editor_state_update(&mut self) -> Option<(String, usize, u64)> {
        let text = self.editor.text();
        let cursor = self.editor.cursor();
        if text == self.synced_editor_text && cursor == self.synced_editor_cursor {
            return None;
        }
        self.editor_generation = self.editor_generation.saturating_add(1);
        self.synced_editor_text = text.to_owned();
        self.synced_editor_cursor = cursor;
        Some((text.to_owned(), cursor, self.editor_generation))
    }

    pub fn is_active_operation(&self) -> bool {
        self.snapshot.as_ref().is_some_and(|snapshot| {
            matches!(snapshot.activity.as_str(), "running" | "waiting_for_input")
                || matches!(
                    snapshot.phase.as_str(),
                    "turn" | "compaction" | "branch_summary" | "retry" | "waiting_for_input"
                )
        }) || self.operation.as_ref().is_some_and(|operation| {
            matches!(
                operation.status.as_str(),
                "accepted" | "running" | "waiting_for_input"
            )
        })
    }

    pub fn composer_width(&self) -> u16 {
        self.composer_width
    }

    pub fn prepare_composer(&mut self, area: Rect) {
        self.composer_width = area.width;
        if self.active_extension_editor().is_none() {
            self.editor
                .ensure_cursor_visible(area.width, area.height.saturating_sub(3).max(1));
        }
    }

    pub fn footer_status(&self) -> String {
        if let Some(footer) = self.extension_footer_line() {
            return footer;
        }
        let Some(snapshot) = &self.snapshot else {
            return "未获取会话租约".to_owned();
        };
        let model = snapshot
            .model
            .as_ref()
            .map_or("无模型".to_owned(), |model| {
                format!("{}/{}", model.provider, model.id)
            });
        let extension_status = self
            .extension_ui
            .statuses
            .values()
            .filter(|value| !value.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join(" | ");
        format!(
            "{} 队列 {}/{} {} 思考 {} {}{}",
            snapshot.phase,
            snapshot.queued_steer_count,
            snapshot.queued_follow_up_count,
            model,
            snapshot.thinking_level,
            snapshot.cwd,
            if extension_status.is_empty() {
                String::new()
            } else {
                format!(" | {extension_status}")
            }
        )
    }
}

pub struct ExtensionComponentOverlayView<'a> {
    state: &'a AppState,
    component: &'a ExtensionComponentState,
    area: Rect,
}

impl<'a> ExtensionComponentOverlayView<'a> {
    pub fn new(state: &'a AppState, component: &'a ExtensionComponentState, area: Rect) -> Self {
        Self {
            state,
            component,
            area,
        }
    }
}

pub fn extension_component_rect(
    state: &AppState,
    component: &ExtensionComponentState,
    area: Rect,
) -> Rect {
    let widget_budget = state.extension_widget_budget(area.height);
    let workspace = transcript_area_with_widget_budget(area, widget_budget);
    if !component.overlay_options.overlay {
        return workspace;
    }
    let requested_width = component
        .overlay_options
        .width
        .as_deref()
        .and_then(|value| component_dimension(value, workspace.width));
    let requested_height = component
        .overlay_options
        .max_height
        .as_deref()
        .and_then(|value| component_dimension(value, workspace.height));
    let width = requested_width
        .or_else(|| component.desired_size.map(|size| size.0))
        .unwrap_or(
            component
                .lines
                .iter()
                .map(|line| UnicodeWidthStr::width(plain_ansi_line(line).as_str()) as u16)
                .max()
                .unwrap_or(1)
                .saturating_add(2),
        )
        .clamp(1, workspace.width.max(1));
    let height = requested_height
        .or_else(|| component.desired_size.map(|size| size.1))
        .unwrap_or(
            u16::try_from(component.lines.len())
                .unwrap_or(u16::MAX)
                .saturating_add(2),
        )
        .clamp(1, workspace.height.max(1));
    let mut x = workspace.x + workspace.width.saturating_sub(width) / 2;
    let mut y = workspace.y + workspace.height.saturating_sub(height) / 2;
    match component.overlay_options.anchor.as_deref() {
        Some("top") => y = workspace.y,
        Some("bottom") => y = workspace.y + workspace.height.saturating_sub(height),
        Some("left") => x = workspace.x,
        Some("right") => x = workspace.x + workspace.width.saturating_sub(width),
        Some("top-left") => {
            x = workspace.x;
            y = workspace.y;
        }
        Some("top-right") => {
            x = workspace.x + workspace.width.saturating_sub(width);
            y = workspace.y;
        }
        Some("bottom-left") => {
            x = workspace.x;
            y = workspace.y + workspace.height.saturating_sub(height);
        }
        Some("bottom-right") => {
            x = workspace.x + workspace.width.saturating_sub(width);
            y = workspace.y + workspace.height.saturating_sub(height);
        }
        _ => {}
    }
    if let Some(column) = component
        .overlay_options
        .column
        .as_deref()
        .and_then(|value| component_dimension(value, workspace.width))
    {
        x = workspace
            .x
            .saturating_add(column)
            .min(workspace.x + workspace.width.saturating_sub(width));
    }
    if let Some(row) = component
        .overlay_options
        .row
        .as_deref()
        .and_then(|value| component_dimension(value, workspace.height))
    {
        y = workspace
            .y
            .saturating_add(row)
            .min(workspace.y + workspace.height.saturating_sub(height));
    }
    Rect::new(x, y, width, height)
}

fn component_dimension(value: &str, available: u16) -> Option<u16> {
    if let Some(percent) = value
        .strip_suffix('%')
        .and_then(|value| value.parse::<u16>().ok())
    {
        return Some(available.saturating_mul(percent.min(100)) / 100);
    }
    value.parse::<u16>().ok()
}

impl Widget for ExtensionComponentOverlayView<'_> {
    fn render(self, _area: Rect, buffer: &mut Buffer) {
        let rect = extension_component_rect(self.state, self.component, self.area);
        let framed = self.component.overlay_options.overlay && rect.width >= 2 && rect.height >= 3;
        if framed {
            for row in 0..rect.height {
                let edge = row == 0 || row == rect.height.saturating_sub(1);
                let border = if edge {
                    "─".repeat(usize::from(rect.width))
                } else {
                    format!(
                        "│{}│",
                        " ".repeat(usize::from(rect.width.saturating_sub(2)))
                    )
                };
                put_line(
                    buffer,
                    rect.x,
                    rect.y + row,
                    &border,
                    usize::from(rect.width),
                    Style::default().fg(Color::Cyan),
                );
            }
        }
        let x = rect.x.saturating_add(u16::from(framed));
        let y = rect.y.saturating_add(u16::from(framed));
        let width = rect.width.saturating_sub(u16::from(framed) * 2);
        let height = rect.height.saturating_sub(u16::from(framed) * 2);
        let visible = usize::from(height);
        for (index, line) in self.component.lines.iter().take(visible).enumerate() {
            put_ansi_line(
                buffer,
                x,
                y + u16::try_from(index).unwrap_or(u16::MAX),
                line,
                usize::from(width),
            );
        }
        if self.component.lines.len() > visible && height > 0 {
            put_line(
                buffer,
                x,
                y + height.saturating_sub(1),
                "… 内容已裁切",
                usize::from(width),
                Style::default().fg(Color::DarkGray),
            );
        }
    }
}

pub fn transcript_area_with_widget_budget(area: Rect, widget_budget: u16) -> Rect {
    let base: u16 = if area.height <= 8 { 4 } else { 6 };
    Rect::new(
        area.x,
        area.y,
        area.width,
        area.height
            .saturating_sub(base.saturating_add(widget_budget)),
    )
}

pub fn composer_area_with_widget_budget(area: Rect, widget_budget: u16) -> Rect {
    let transcript = transcript_area_with_widget_budget(area, widget_budget);
    Rect::new(
        area.x,
        area.y + transcript.height,
        area.width,
        area.height.saturating_sub(transcript.height),
    )
}

pub fn transcript_area(state: &AppState, area: Rect) -> Rect {
    transcript_area_with_widget_budget(area, state.extension_widget_budget(area.height))
}

pub fn composer_area(state: &AppState, area: Rect) -> Rect {
    composer_area_with_widget_budget(area, state.extension_widget_budget(area.height))
}
