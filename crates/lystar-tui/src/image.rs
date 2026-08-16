use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    io::{self, Write},
};

pub const IMAGE_CACHE_ENTRIES: usize = 16;
pub const IMAGE_CACHE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalImageProtocol {
    Kitty,
    Iterm2,
    Unknown,
}

pub fn terminal_image_protocol(env: &impl Fn(&str) -> Option<String>) -> TerminalImageProtocol {
    if env("TERM").is_some_and(|value| value.contains("kitty")) || env("KITTY_WINDOW_ID").is_some()
    {
        TerminalImageProtocol::Kitty
    } else if env("TERM_PROGRAM").is_some_and(|value| value == "iTerm.app") {
        TerminalImageProtocol::Iterm2
    } else {
        TerminalImageProtocol::Unknown
    }
}

pub fn current_terminal_image_protocol() -> TerminalImageProtocol {
    terminal_image_protocol(&|key| env::var(key).ok())
}

#[derive(Debug, Clone)]
pub struct CachedImage {
    pub content_ref: String,
    pub mime_type: String,
    pub byte_length: usize,
    pub base64: String,
}

#[derive(Debug, Default)]
pub struct ImageCache {
    entries: HashMap<String, CachedImage>,
    lru: VecDeque<String>,
    bytes: usize,
}

impl ImageCache {
    pub fn get(&self, content_ref: &str) -> Option<&CachedImage> {
        self.entries.get(content_ref)
    }

    pub fn insert(&mut self, image: CachedImage) {
        let key = image.content_ref.clone();
        if let Some(previous) = self.entries.remove(&key) {
            self.bytes = self.bytes.saturating_sub(previous.base64.len());
            self.lru.retain(|candidate| candidate != &key);
        }
        self.bytes = self.bytes.saturating_add(image.base64.len());
        self.entries.insert(key.clone(), image);
        self.lru.push_back(key);
        while self.entries.len() > IMAGE_CACHE_ENTRIES || self.bytes > IMAGE_CACHE_BYTES {
            let Some(oldest) = self.lru.pop_front() else {
                break;
            };
            if let Some(image) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(image.base64.len());
            }
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.lru.clear();
        self.bytes = 0;
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

pub fn image_placeholder(mime_type: &str, byte_length: u64) -> String {
    format!("[图片 {mime_type} {byte_length}]")
}

pub struct ImageSidecar {
    protocol: TerminalImageProtocol,
    drawn: HashSet<String>,
}

impl ImageSidecar {
    pub fn new(protocol: TerminalImageProtocol) -> Self {
        Self {
            protocol,
            drawn: HashSet::new(),
        }
    }

    pub fn protocol(&self) -> TerminalImageProtocol {
        self.protocol
    }

    pub fn draw_after_frame(
        &mut self,
        writer: &mut impl Write,
        visible: impl IntoIterator<Item = CachedImage>,
        tmux: bool,
    ) -> io::Result<()> {
        let visible = visible.into_iter().collect::<Vec<_>>();
        let visible_ids = visible
            .iter()
            .map(|image| image.content_ref.clone())
            .collect::<HashSet<_>>();
        for stale in self.drawn.difference(&visible_ids) {
            self.delete(writer, stale, tmux)?;
        }
        for image in visible {
            match self.protocol {
                TerminalImageProtocol::Kitty => write_sequence(writer, &kitty_draw(&image), tmux)?,
                TerminalImageProtocol::Iterm2 => write_sequence(writer, &iterm_draw(&image), tmux)?,
                TerminalImageProtocol::Unknown => {}
            }
        }
        writer.flush()?;
        self.drawn = visible_ids;
        Ok(())
    }

    pub fn clear(&mut self, writer: &mut impl Write, tmux: bool) -> io::Result<()> {
        for content_ref in self.drawn.clone() {
            self.delete(writer, &content_ref, tmux)?;
        }
        writer.flush()?;
        self.drawn.clear();
        Ok(())
    }

    fn delete(&self, writer: &mut impl Write, content_ref: &str, tmux: bool) -> io::Result<()> {
        if self.protocol == TerminalImageProtocol::Kitty {
            write_sequence(
                writer,
                &format!("\x1b_Ga=d,d=i,i={};\x1b\\", image_id(content_ref)),
                tmux,
            )?;
        }
        Ok(())
    }
}

fn kitty_draw(image: &CachedImage) -> String {
    format!(
        "\x1b_Ga=T,f=100,i={};{}\x1b\\",
        image_id(&image.content_ref),
        image.base64
    )
}

fn iterm_draw(image: &CachedImage) -> String {
    format!(
        "\x1b]1337;File=inline=1;size={};{}\x07",
        image.byte_length, image.base64
    )
}

fn image_id(content_ref: &str) -> u32 {
    let mut hash = 2_166_136_261_u32;
    for byte in content_ref.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    hash.max(1)
}

fn write_sequence(writer: &mut impl Write, sequence: &str, tmux: bool) -> io::Result<()> {
    if tmux {
        writer.write_all(b"\x1bPtmux;\x1b")?;
        writer.write_all(sequence.replace("\x1b", "\x1b\x1b").as_bytes())?;
        writer.write_all(b"\x1b\\")
    } else {
        writer.write_all(sequence.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_terminal_capabilities_and_writes_tmux_wrapped_kitty_delete() {
        assert_eq!(
            terminal_image_protocol(&|key| (key == "TERM").then(|| "xterm-kitty".to_owned())),
            TerminalImageProtocol::Kitty
        );
        assert_eq!(
            terminal_image_protocol(&|key| (key == "TERM_PROGRAM").then(|| "iTerm.app".to_owned())),
            TerminalImageProtocol::Iterm2
        );
        assert_eq!(
            terminal_image_protocol(&|_| None),
            TerminalImageProtocol::Unknown
        );
        let mut sidecar = ImageSidecar::new(TerminalImageProtocol::Kitty);
        let mut bytes = Vec::new();
        sidecar
            .draw_after_frame(
                &mut bytes,
                [CachedImage {
                    content_ref: "ref".to_owned(),
                    mime_type: "image/png".to_owned(),
                    byte_length: 1,
                    base64: "YQ==".to_owned(),
                }],
                true,
            )
            .unwrap();
        sidecar.draw_after_frame(&mut bytes, [], true).unwrap();
        let output = String::from_utf8(bytes).unwrap();
        assert!(output.contains("tmux"));
        assert!(output.contains("a=d"));
    }
}
