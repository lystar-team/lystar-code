use std::panic;

use lystar_tui::terminal::{self, ExitOutput, RunOptions, TerminalMode};

fn parse_run_options(args: &[String]) -> Result<RunOptions, terminal::TuiError> {
    let mut options = RunOptions::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].as_str();
        index += 1;
        let option = args
            .get(index)
            .ok_or_else(|| terminal::TuiError::InvalidResponse(format!("{value} 缺少参数")))?;
        match value {
            "--mode" => {
                options.mode = TerminalMode::parse(option).ok_or_else(|| {
                    terminal::TuiError::InvalidResponse(
                        "--mode 仅支持 auto、fullscreen 或 regular".to_owned(),
                    )
                })?;
            }
            "--exit-output" => {
                options.exit_output = ExitOutput::parse(option).ok_or_else(|| {
                    terminal::TuiError::InvalidResponse(
                        "--exit-output 仅支持 transcript 或 resume-hint".to_owned(),
                    )
                })?;
            }
            "--reduce-motion" => {
                options.reduce_motion = match option.as_str() {
                    "true" => true,
                    "false" => false,
                    _ => {
                        return Err(terminal::TuiError::InvalidResponse(
                            "--reduce-motion 仅支持 true 或 false".to_owned(),
                        ));
                    }
                };
            }
            _ => {
                return Err(terminal::TuiError::InvalidResponse(format!(
                    "未知参数：{value}"
                )));
            }
        }
        index += 1;
    }
    Ok(options)
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let result = panic::catch_unwind(|| match args.first().map(String::as_str) {
        Some("--run") | Some("run") => {
            let session_path = args.get(1).ok_or_else(|| {
                terminal::TuiError::InvalidResponse("缺少 Session 路径".to_owned())
            })?;
            terminal::run_with_options(session_path, parse_run_options(&args[2..])?)
        }
        Some("--pipe-handshake-hold") => {
            terminal::handshake_inherited_pipes()?;
            let hold_ms = args.get(1).cloned().unwrap_or_else(|| "1200".to_owned());
            std::thread::sleep(std::time::Duration::from_millis(hold_ms.parse().unwrap()));
            Ok(())
        }
        Some("--pipe-handshake") => terminal::handshake_inherited_pipes(),
        Some("--shell") => terminal::run_shell(false, false),
        Some("--shell-pipe") => terminal::run_shell(true, false),
        Some("--shell-panic") => terminal::run_shell(false, true),
        Some("--shell-regular") => {
            terminal::run_shell_with_mode(false, false, TerminalMode::Regular)
        }
        Some("--shell-pipe-regular") => {
            terminal::run_shell_with_mode(true, false, TerminalMode::Regular)
        }
        Some("--shell-panic-regular") => {
            terminal::run_shell_with_mode(false, true, TerminalMode::Regular)
        }
        _ => Ok(()),
    });
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            eprintln!("lystar-tui: {error}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("lystar-tui: panic recovered after terminal cleanup");
            std::process::exit(101);
        }
    }
}
