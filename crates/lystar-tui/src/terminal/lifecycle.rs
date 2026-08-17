use super::*;

pub struct TerminalGuard {
    raw: bool,
    alternate: bool,
    mouse: bool,
    bracketed_paste: bool,
    cursor_hidden: bool,
}

impl TerminalGuard {
    pub fn enter(mode: TerminalMode) -> Result<Self, io::Error> {
        let mut guard = Self {
            raw: false,
            alternate: false,
            mouse: false,
            bracketed_paste: false,
            cursor_hidden: false,
        };
        enable_raw_mode()?;
        guard.raw = true;

        let setup = (|| -> Result<(), io::Error> {
            let mut stdout = io::stdout();
            if mode == TerminalMode::Fullscreen {
                execute!(stdout, EnterAlternateScreen)?;
                guard.alternate = true;
                execute!(stdout, EnableMouseCapture)?;
                guard.mouse = true;
            }
            execute!(stdout, EnableBracketedPaste)?;
            guard.bracketed_paste = true;
            execute!(stdout, Hide)?;
            guard.cursor_hidden = true;
            Ok(())
        })();
        if let Err(error) = setup {
            guard.restore();
            return Err(error);
        }
        Ok(guard)
    }

    fn restore(&mut self) {
        let mut stdout = io::stdout();
        if self.cursor_hidden {
            let _ = execute!(stdout, Show);
            self.cursor_hidden = false;
        }
        if self.bracketed_paste {
            let _ = execute!(stdout, DisableBracketedPaste);
            self.bracketed_paste = false;
        }
        if self.mouse {
            let _ = execute!(stdout, DisableMouseCapture);
            self.mouse = false;
        }
        if self.alternate {
            let _ = execute!(stdout, LeaveAlternateScreen);
            self.alternate = false;
        }
        if self.raw {
            let _ = disable_raw_mode();
            self.raw = false;
        }
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.restore();
    }
}

#[cfg(test)]
pub(super) fn enter_terminal<Enable, Enter, Restore>(
    enable_raw: Enable,
    enter_screen: Enter,
    restore_raw: Restore,
) -> Result<(), io::Error>
where
    Enable: FnOnce() -> Result<(), io::Error>,
    Enter: FnOnce() -> Result<(), io::Error>,
    Restore: FnOnce() -> Result<(), io::Error>,
{
    enable_raw()?;
    if let Err(error) = enter_screen() {
        let _ = restore_raw();
        return Err(error);
    }
    Ok(())
}
