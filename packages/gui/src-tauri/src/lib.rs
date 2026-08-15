use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{self, Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    ipc::{Channel, InvokeBody, InvokeResponseBody, Request},
    AppHandle, Manager, RunEvent, State,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const MAX_TRANSPORT_CHUNK: usize = 16 * 1024 * 1024 + 4;
const MAX_HOST_CONNECTIONS: usize = 4;
const MAX_DESKTOP_STATE_BYTES: usize = 1024 * 1024;
const MAX_SSH_STDERR_BYTES: usize = 64 * 1024;
const REMOTE_PREFACE: &[u8] = b"LYSTAR-GUI-HOST/1\n";
const HOST_PAYLOAD_HEADER: &[u8] = b"LYSTAR-GUI-BINARY/1\n";
const SSH_CREDENTIAL_SERVICE: &str = "com.lystar.code.ssh";

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TransportStatus {
    Closed,
    Error { message: String },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshConnectionOptions {
    target: String,
    user: Option<String>,
    port: Option<u16>,
    auth_method: Option<String>,
    identity_file: Option<String>,
    credential_id: Option<String>,
    platform: Option<String>,
    host_command: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SshProbeResult {
    target: String,
    connected: bool,
    platform: Option<String>,
    arch: Option<String>,
    host_installed: bool,
    host_status: Option<Value>,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshHostKeyStatus {
    host: String,
    port: u16,
    known: bool,
    fingerprints: Vec<String>,
    trust_token: Option<String>,
}

struct PendingHostKey {
    host: String,
    port: u16,
    lines: Vec<String>,
}

struct RemoteSystem {
    platform: String,
    arch: String,
}

struct SshChild {
    child: Child,
    stdin: ChildStdin,
}

enum ManagedConnection {
    Local(CommandChild),
    Ssh(SshChild),
}

impl ManagedConnection {
    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        match self {
            Self::Local(child) => child.write(bytes).map_err(|error| error.to_string()),
            Self::Ssh(child) => child
                .stdin
                .write_all(bytes)
                .map_err(|error| error.to_string()),
        }
    }

    fn kill(self) -> Result<(), String> {
        match self {
            Self::Local(child) => child.kill().map_err(|error| error.to_string()),
            Self::Ssh(mut child) => child.child.kill().map_err(|error| error.to_string()),
        }
    }
}

#[derive(Default)]
struct GuiHostState {
    next_connection_id: AtomicU64,
    children: Mutex<HashMap<String, ManagedConnection>>,
    local_host: Mutex<Option<PathBuf>>,
    ephemeral_credentials: Mutex<HashSet<String>>,
    pending_host_keys: Mutex<HashMap<String, PendingHostKey>>,
}

fn credential_entry(credential_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SSH_CREDENTIAL_SERVICE, credential_id).map_err(|error| error.to_string())
}

fn validate_credential_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 180
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err("SSH 凭据标识无效".into());
    }
    Ok(())
}

#[tauri::command]
fn store_ssh_password(
    state: State<'_, GuiHostState>,
    profile_id: String,
    password: String,
    remember: bool,
) -> Result<String, String> {
    validate_credential_id(&profile_id)?;
    if password.is_empty() || password.len() > 16 * 1024 {
        return Err("SSH 密码为空或超过长度上限".into());
    }
    let credential_id = if remember {
        format!("profile-{profile_id}")
    } else {
        format!(
            "session-{profile_id}-{}",
            state.next_connection_id.fetch_add(1, Ordering::Relaxed) + 1
        )
    };
    credential_entry(&credential_id)?
        .set_password(&password)
        .map_err(|error| format!("无法写入系统凭据库：{error}"))?;
    if !remember {
        state
            .ephemeral_credentials
            .lock()
            .unwrap()
            .insert(credential_id.clone());
    }
    Ok(credential_id)
}

#[tauri::command]
fn delete_ssh_password(
    state: State<'_, GuiHostState>,
    credential_id: String,
) -> Result<(), String> {
    validate_credential_id(&credential_id)?;
    state
        .ephemeral_credentials
        .lock()
        .unwrap()
        .remove(&credential_id);
    match credential_entry(&credential_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法删除系统凭据：{error}")),
    }
}

pub fn run_ssh_askpass() -> bool {
    let Ok(credential_id) = env::var("LYSTAR_SSH_ASKPASS_CREDENTIAL") else {
        return false;
    };
    let prompt = env::args().nth(1).unwrap_or_default().to_ascii_lowercase();
    if prompt.contains("yes/no") || prompt.contains("authenticity of host") {
        eprintln!("SSH Host key 尚未确认");
        return true;
    }
    let password = credential_entry(&credential_id).and_then(|entry| {
        entry
            .get_password()
            .map_err(|error| format!("无法读取系统凭据：{error}"))
    });
    match password {
        Ok(password) => {
            print!("{password}");
            true
        }
        Err(error) => {
            eprintln!("{error}");
            true
        }
    }
}

fn next_connection_id(state: &GuiHostState) -> String {
    format!(
        "gui-host-{}",
        state.next_connection_id.fetch_add(1, Ordering::Relaxed) + 1
    )
}

fn remove_connection(app: &AppHandle, connection_id: &str, kill: bool) {
    let state = app.state::<GuiHostState>();
    let child = state.children.lock().unwrap().remove(connection_id);
    if kill {
        if let Some(child) = child {
            let _ = child.kill();
        }
    }
}

fn close_all_connections(state: &GuiHostState) {
    drop(std::mem::take(&mut *state.children.lock().unwrap()));
}

fn assert_connection_limit(state: &GuiHostState) -> Result<(), String> {
    if state.children.lock().unwrap().len() >= MAX_HOST_CONNECTIONS {
        return Err("GUI 后台连接数已达上限".into());
    }
    Ok(())
}

fn materialize_host(source: &Path, destination: &Path) -> Result<(), String> {
    let mut input = File::open(source).map_err(|error| error.to_string())?;
    let mut header = vec![0_u8; HOST_PAYLOAD_HEADER.len()];
    input
        .read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    if header != HOST_PAYLOAD_HEADER {
        return Err(format!("GUI Host 载荷格式无效：{}", source.display()));
    }
    let expected_size = input.metadata().map_err(|error| error.to_string())?.len()
        - HOST_PAYLOAD_HEADER.len() as u64;
    let target_dir = destination
        .parent()
        .ok_or_else(|| "GUI Host 运行目录无效".to_string())?;
    fs::create_dir_all(target_dir).map_err(|error| error.to_string())?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "GUI Host 文件名无效".to_string())?;
    let temporary = target_dir.join(format!(".{file_name}.{}.tmp", process::id()));
    let mut output = File::create(&temporary).map_err(|error| error.to_string())?;
    io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&temporary, destination) {
        if destination
            .metadata()
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() == expected_size)
        {
            let _ = fs::remove_file(&temporary);
        } else {
            return Err(error.to_string());
        }
    }
    Ok(())
}

fn prepare_local_host(app: &AppHandle, state: &GuiHostState) -> Result<PathBuf, String> {
    let mut prepared = state.local_host.lock().unwrap();
    if let Some(path) = prepared.as_ref() {
        return Ok(path.clone());
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let source = resource_dir.join("local-host/lystar-gui-host.bin");
    let target_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("runtime")
        .join(env!("CARGO_PKG_VERSION"));
    let destination = target_dir.join(if cfg!(windows) {
        "lystar-gui-host.exe"
    } else {
        "lystar-gui-host"
    });
    materialize_host(&source, &destination)?;
    *prepared = Some(destination.clone());
    Ok(destination)
}

fn validate_ssh_target(target: &str) -> Result<(), String> {
    if target.is_empty()
        || target.starts_with('-')
        || target.len() > 255
        || !target
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._@%+-".contains(&byte))
    {
        return Err("SSH 目标只能使用 ~/.ssh/config 主机别名或 user@host".into());
    }
    Ok(())
}

fn ssh_config_destination(profile: &SshConnectionOptions) -> Result<(String, u16), String> {
    validate_ssh_target(&profile.target)?;
    let mut command = Command::new("ssh");
    command.arg("-G");
    if let Some(user) = profile.user.as_deref() {
        command.args(["-l", user]);
    }
    if let Some(port) = profile.port {
        command.args(["-p", &port.to_string()]);
    }
    let output = command
        .arg(&profile.target)
        .output()
        .map_err(|error| format!("无法读取 OpenSSH 配置：{error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let mut host = profile.target.clone();
    let mut port = profile.port.unwrap_or(22);
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some((key, value)) = line.split_once(' ') {
            match key {
                "hostname" if !value.trim().is_empty() => host = value.trim().to_string(),
                "port" => port = value.trim().parse().unwrap_or(port),
                "hostkeyalias" if !value.trim().is_empty() => host = value.trim().to_string(),
                _ => {}
            }
        }
    }
    Ok((host, port))
}

fn ssh_home_dir() -> Result<PathBuf, String> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| "无法确定用户主目录".to_string())
}

fn known_hosts_lookup(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

#[tauri::command]
fn inspect_ssh_host_key(
    state: State<'_, GuiHostState>,
    profile: SshConnectionOptions,
) -> Result<SshHostKeyStatus, String> {
    let (host, port) = ssh_config_destination(&profile)?;
    let known_hosts = ssh_home_dir()?.join(".ssh").join("known_hosts");
    let lookup = known_hosts_lookup(&host, port);
    let known = known_hosts.is_file()
        && Command::new("ssh-keygen")
            .args(["-F", &lookup, "-f"])
            .arg(&known_hosts)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
    if known {
        return Ok(SshHostKeyStatus {
            host,
            port,
            known: true,
            fingerprints: Vec::new(),
            trust_token: None,
        });
    }

    let scan = Command::new("ssh-keyscan")
        .args(["-T", "10", "-p", &port.to_string(), &host])
        .output()
        .map_err(|error| format!("无法启动 ssh-keyscan：{error}"))?;
    let lines = String::from_utf8_lossy(&scan.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        let detail = String::from_utf8_lossy(&scan.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "未能读取远端 SSH Host key".into()
        } else {
            detail
        });
    }

    let mut fingerprint_process = Command::new("ssh-keygen")
        .args(["-lf", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 ssh-keygen：{error}"))?;
    fingerprint_process
        .stdin
        .take()
        .ok_or_else(|| "无法写入 ssh-keygen".to_string())?
        .write_all(format!("{}\n", lines.join("\n")).as_bytes())
        .map_err(|error| error.to_string())?;
    let fingerprints = String::from_utf8_lossy(
        &fingerprint_process
            .wait_with_output()
            .map_err(|error| error.to_string())?
            .stdout,
    )
    .lines()
    .map(str::to_string)
    .collect::<Vec<_>>();
    let trust_token = format!(
        "host-key-{}",
        state.next_connection_id.fetch_add(1, Ordering::Relaxed) + 1
    );
    state.pending_host_keys.lock().unwrap().insert(
        trust_token.clone(),
        PendingHostKey {
            host: host.clone(),
            port,
            lines,
        },
    );
    Ok(SshHostKeyStatus {
        host,
        port,
        known: false,
        fingerprints,
        trust_token: Some(trust_token),
    })
}

#[tauri::command]
fn trust_ssh_host_key(state: State<'_, GuiHostState>, trust_token: String) -> Result<(), String> {
    let pending = state
        .pending_host_keys
        .lock()
        .unwrap()
        .remove(&trust_token)
        .ok_or_else(|| "SSH Host key 确认已失效".to_string())?;
    let ssh_dir = ssh_home_dir()?.join(".ssh");
    fs::create_dir_all(&ssh_dir).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&ssh_dir, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let path = ssh_dir.join("known_hosts");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    writeln!(
        file,
        "# LYStar Code confirmed {}:{}",
        pending.host, pending.port
    )
    .map_err(|error| error.to_string())?;
    for line in pending.lines {
        writeln!(file, "{line}").map_err(|error| error.to_string())?;
    }
    file.sync_all().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn validate_host_command(command: &str) -> Result<(), String> {
    if command.is_empty()
        || command.len() > 512
        || !command
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._/~:%+-".contains(&byte))
    {
        return Err("远端 Host 命令包含不允许的字符".into());
    }
    Ok(())
}

fn host_command(profile: &SshConnectionOptions, platform: &str) -> Result<String, String> {
    let command = profile.host_command.clone().unwrap_or_else(|| {
        if platform == "windows" {
            "%USERPROFILE%/.local/share/lystar-gui-host/current/lystar-gui-host.exe".into()
        } else {
            "~/.local/bin/lystar-gui-host".into()
        }
    });
    validate_host_command(&command)?;
    Ok(command)
}

fn configure_password_askpass(command: &mut Command, profile: &SshConnectionOptions) -> Result<(), String> {
    let credential_id = profile
        .credential_id
        .as_deref()
        .ok_or_else(|| "密码认证需要先输入 SSH 密码".to_string())?;
    validate_credential_id(credential_id)?;
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    command
        .env("SSH_ASKPASS", executable)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("LYSTAR_SSH_ASKPASS_CREDENTIAL", credential_id);
    if env::var_os("DISPLAY").is_none() {
        command.env("DISPLAY", "lystar-ssh-askpass");
    }
    Ok(())
}

fn configure_ssh(command: &mut Command, profile: &SshConnectionOptions) -> Result<(), String> {
    validate_ssh_target(&profile.target)?;
    command.args([
        "-T",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
    ]);
    if let Some(user) = profile.user.as_deref() {
        if user.is_empty()
            || user.len() > 128
            || !user
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            return Err("SSH 用户名无效".into());
        }
        command.args(["-l", user]);
    }
    if let Some(port) = profile.port {
        command.args(["-p", &port.to_string()]);
    }
    if let Some(identity_file) = profile.identity_file.as_deref() {
        if identity_file.is_empty() || identity_file.len() > 4096 {
            return Err("SSH 密钥路径无效".into());
        }
        command.args(["-i", identity_file]);
    }
    match profile.auth_method.as_deref().unwrap_or("agent") {
        "agent" => {
            command.args(["-o", "BatchMode=yes"]);
        }
        "key" => {
            if profile.identity_file.is_none() {
                return Err("密钥认证需要选择私钥文件".into());
            }
            command.args(["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"]);
        }
        "password" => {
            command.args([
                "-o",
                "BatchMode=no",
                "-o",
                "NumberOfPasswordPrompts=1",
                "-o",
                "PubkeyAuthentication=no",
                "-o",
                "PreferredAuthentications=password,keyboard-interactive",
            ]);
            configure_password_askpass(command, profile)?;
        }
        _ => return Err("SSH 认证方式无效".into()),
    }
    command.arg(&profile.target);
    Ok(())
}

fn configure_scp(command: &mut Command, profile: &SshConnectionOptions) -> Result<String, String> {
    validate_ssh_target(&profile.target)?;
    command.args(["-r", "-q", "-o", "ConnectTimeout=10"]);
    if let Some(port) = profile.port {
        command.args(["-P", &port.to_string()]);
    }
    if let Some(identity_file) = profile.identity_file.as_deref() {
        command.args(["-i", identity_file]);
    }
    match profile.auth_method.as_deref().unwrap_or("agent") {
        "agent" => {
            command.args(["-o", "BatchMode=yes"]);
        }
        "key" => {
            if profile.identity_file.is_none() {
                return Err("密钥认证需要选择私钥文件".into());
            }
            command.args(["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"]);
        }
        "password" => {
            command.args([
                "-o",
                "BatchMode=no",
                "-o",
                "NumberOfPasswordPrompts=1",
                "-o",
                "PubkeyAuthentication=no",
                "-o",
                "PreferredAuthentications=password,keyboard-interactive",
            ]);
            configure_password_askpass(command, profile)?;
        }
        _ => return Err("SSH 认证方式无效".into()),
    }
    if let Some(user) = profile.user.as_deref() {
        if user.is_empty()
            || user.len() > 128
            || !user
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        {
            return Err("SSH 用户名无效".into());
        }
        Ok(format!("{user}@{}", profile.target))
    } else {
        Ok(profile.target.clone())
    }
}

fn ssh_remote_output(
    profile: &SshConnectionOptions,
    remote_args: &[&str],
) -> Result<std::process::Output, String> {
    let mut command = Command::new("ssh");
    configure_ssh(&mut command, profile)?;
    command
        .args(remote_args)
        .output()
        .map_err(|error| format!("无法启动 OpenSSH：{error}"))
}

fn normalize_arch(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" => "x64".into(),
        "aarch64" | "arm64" => "arm64".into(),
        other => other.into(),
    }
}

fn detect_remote_system(profile: &SshConnectionOptions) -> Result<RemoteSystem, String> {
    let uname = ssh_remote_output(profile, &["uname", "-s"])?;
    if uname.status.success() {
        let platform = match String::from_utf8_lossy(&uname.stdout)
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "linux" => "linux",
            "darwin" => "darwin",
            other => return Err(format!("不支持的远端系统：{other}")),
        };
        let arch = ssh_remote_output(profile, &["uname", "-m"])?;
        if !arch.status.success() {
            return Err(String::from_utf8_lossy(&arch.stderr).trim().to_string());
        }
        return Ok(RemoteSystem {
            platform: platform.into(),
            arch: normalize_arch(&String::from_utf8_lossy(&arch.stdout)),
        });
    }

    let windows = ssh_remote_output(profile, &["cmd.exe", "/d", "/c", "ver"])?;
    if windows.status.success()
        && String::from_utf8_lossy(&windows.stdout)
            .to_ascii_lowercase()
            .contains("windows")
    {
        let arch = ssh_remote_output(
            profile,
            &["cmd.exe", "/d", "/c", "echo", "%PROCESSOR_ARCHITECTURE%"],
        )?;
        return Ok(RemoteSystem {
            platform: "windows".into(),
            arch: if arch.status.success() {
                normalize_arch(&String::from_utf8_lossy(&arch.stdout))
            } else {
                "x64".into()
            },
        });
    }

    let detail = String::from_utf8_lossy(&uname.stderr).trim().to_string();
    Err(if detail.is_empty() {
        "无法识别远端系统".into()
    } else {
        detail
    })
}

fn resolved_remote_platform(profile: &SshConnectionOptions) -> Result<String, String> {
    match profile.platform.as_deref() {
        Some(platform @ ("linux" | "darwin" | "windows")) => Ok(platform.into()),
        Some("auto") | None => Ok(detect_remote_system(profile)?.platform),
        Some(_) => Err("远端系统配置无效".into()),
    }
}

fn append_host_command(process: &mut Command, platform: &str, executable: &str, args: &[&str]) {
    if platform == "windows" {
        let executable = executable.replace("%USERPROFILE%", "$env:USERPROFILE");
        let script = powershell_encoded(&format!("& \"{executable}\" {}", args.join(" ")));
        process.args([
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &script,
        ]);
    } else {
        process.arg(executable).args(args);
    }
}

fn bounded_stderr(stderr: impl Read + Send + 'static) -> Arc<Mutex<VecDeque<u8>>> {
    let output = Arc::new(Mutex::new(VecDeque::with_capacity(MAX_SSH_STDERR_BYTES)));
    let task_output = output.clone();
    thread::spawn(move || {
        let mut reader = stderr;
        let mut buffer = [0_u8; 4096];
        while let Ok(length) = reader.read(&mut buffer) {
            if length == 0 {
                break;
            }
            let mut target = task_output.lock().unwrap();
            for byte in &buffer[..length] {
                if target.len() == MAX_SSH_STDERR_BYTES {
                    target.pop_front();
                }
                target.push_back(*byte);
            }
        }
    });
    output
}

fn stderr_message(stderr: &Arc<Mutex<VecDeque<u8>>>) -> String {
    String::from_utf8_lossy(&stderr.lock().unwrap().iter().copied().collect::<Vec<_>>())
        .trim()
        .to_string()
}

#[tauri::command]
fn open_gui_host(
    app: AppHandle,
    state: State<'_, GuiHostState>,
    bytes: Channel<InvokeResponseBody>,
    status: Channel<TransportStatus>,
) -> Result<String, String> {
    assert_connection_limit(&state)?;
    let connection_id = next_connection_id(&state);
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let host_path = prepare_local_host(&app, &state)?;
    let (mut receiver, child) = app
        .shell()
        .command(host_path)
        .env("PI_GUI_HOST_VERSION", env!("CARGO_PKG_VERSION"))
        .env("PI_PACKAGE_DIR", &resource_dir)
        .env(
            "PI_PHOTON_WASM_PATH",
            resource_dir.join("photon_rs_bg.wasm"),
        )
        .set_raw_out(true)
        .spawn()
        .map_err(|error| error.to_string())?;

    state
        .children
        .lock()
        .unwrap()
        .insert(connection_id.clone(), ManagedConnection::Local(child));

    let task_app = app.clone();
    let task_connection_id = connection_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut kill = false;
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(chunk) => {
                    if chunk.len() > MAX_TRANSPORT_CHUNK {
                        kill = true;
                        let _ = status.send(TransportStatus::Error {
                            message: "GUI 后台输出超过传输上限".into(),
                        });
                        break;
                    }
                    if bytes.send(InvokeResponseBody::Raw(chunk)).is_err() {
                        kill = true;
                        break;
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("GUI Host: {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Error(message) => {
                    kill = true;
                    let _ = status.send(TransportStatus::Error { message });
                    break;
                }
                CommandEvent::Terminated(_) => {
                    let _ = status.send(TransportStatus::Closed);
                    break;
                }
                _ => {}
            }
        }
        remove_connection(&task_app, &task_connection_id, kill);
    });

    Ok(connection_id)
}

#[tauri::command]
fn open_ssh_host(
    app: AppHandle,
    state: State<'_, GuiHostState>,
    profile: SshConnectionOptions,
    bytes: Channel<InvokeResponseBody>,
    status: Channel<TransportStatus>,
) -> Result<String, String> {
    assert_connection_limit(&state)?;
    validate_ssh_target(&profile.target)?;
    let platform = resolved_remote_platform(&profile)?;
    let command = host_command(&profile, &platform)?;
    let connection_id = next_connection_id(&state);
    let mut process = Command::new("ssh");
    configure_ssh(&mut process, &profile)?;
    append_host_command(&mut process, &platform, &command, &["connect", "--stdio"]);
    process
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = process
        .spawn()
        .map_err(|error| format!("无法启动 OpenSSH：{error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法打开 SSH 标准输入".to_string())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法打开 SSH 标准输出".to_string())?;
    let stderr = bounded_stderr(
        child
            .stderr
            .take()
            .ok_or_else(|| "无法打开 SSH 错误输出".to_string())?,
    );

    state.children.lock().unwrap().insert(
        connection_id.clone(),
        ManagedConnection::Ssh(SshChild { child, stdin }),
    );

    let task_app = app.clone();
    let task_connection_id = connection_id.clone();
    thread::spawn(move || {
        let mut preface = vec![0_u8; REMOTE_PREFACE.len()];
        if let Err(error) = stdout.read_exact(&mut preface) {
            let detail = stderr_message(&stderr);
            let message = if detail.is_empty() {
                format!("SSH 连接在握手前关闭：{error}")
            } else {
                detail
            };
            let _ = status.send(TransportStatus::Error { message });
            remove_connection(&task_app, &task_connection_id, true);
            return;
        }
        if preface != REMOTE_PREFACE {
            let _ = status.send(TransportStatus::Error {
                message: "远端返回了无效的 LYStar GUI Host 握手".into(),
            });
            remove_connection(&task_app, &task_connection_id, true);
            return;
        }
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => {
                    let detail = stderr_message(&stderr);
                    if detail.is_empty() {
                        let _ = status.send(TransportStatus::Closed);
                    } else {
                        let _ = status.send(TransportStatus::Error { message: detail });
                    }
                    remove_connection(&task_app, &task_connection_id, false);
                    return;
                }
                Ok(length) => {
                    if bytes
                        .send(InvokeResponseBody::Raw(buffer[..length].to_vec()))
                        .is_err()
                    {
                        remove_connection(&task_app, &task_connection_id, true);
                        return;
                    }
                }
                Err(error) => {
                    let _ = status.send(TransportStatus::Error {
                        message: format!("读取 SSH 输出失败：{error}"),
                    });
                    remove_connection(&task_app, &task_connection_id, true);
                    return;
                }
            }
        }
    });

    Ok(connection_id)
}

#[tauri::command]
fn write_gui_host(state: State<'_, GuiHostState>, request: Request<'_>) -> Result<(), String> {
    let connection_id = request
        .headers()
        .get("x-lystar-connection-id")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "缺少 GUI 后台连接 ID".to_string())?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("GUI 后台输入必须是原始字节".into()),
    };
    if bytes.len() > MAX_TRANSPORT_CHUNK {
        return Err("GUI 后台输入超过传输上限".into());
    }
    state
        .children
        .lock()
        .unwrap()
        .get_mut(connection_id)
        .ok_or_else(|| "GUI 后台连接不存在".to_string())?
        .write(bytes)
}

#[tauri::command]
fn close_gui_host(state: State<'_, GuiHostState>, connection_id: String) -> Result<(), String> {
    state.children.lock().unwrap().remove(&connection_id);
    Ok(())
}

fn host_output(
    profile: &SshConnectionOptions,
    platform: &str,
    remote_args: &[&str],
) -> Result<std::process::Output, String> {
    let executable = host_command(profile, platform)?;
    let mut command = Command::new("ssh");
    configure_ssh(&mut command, profile)?;
    append_host_command(&mut command, platform, &executable, remote_args);
    command
        .output()
        .map_err(|error| format!("无法启动 OpenSSH：{error}"))
}

#[tauri::command]
fn probe_ssh_connection(profile: SshConnectionOptions) -> Result<SshProbeResult, String> {
    let system = match detect_remote_system(&profile) {
        Ok(system) => system,
        Err(message) => {
            return Ok(SshProbeResult {
                target: profile.target,
                connected: false,
                platform: None,
                arch: None,
                host_installed: false,
                host_status: None,
                message: Some(message),
            });
        }
    };
    let output = host_output(&profile, &system.platform, &["status"])?;
    if !output.status.success() {
        return Ok(SshProbeResult {
            target: profile.target,
            connected: true,
            platform: Some(system.platform),
            arch: Some(system.arch),
            host_installed: false,
            host_status: None,
            message: Some(format!(
                "SSH 可达，远端后台不可用：{}",
                command_error(&output.stderr)
            )),
        });
    }
    let status: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("无法解析远端后台状态：{error}"))?;
    Ok(SshProbeResult {
        target: profile.target,
        connected: true,
        platform: Some(system.platform),
        arch: Some(system.arch),
        host_installed: status
            .get("installed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        host_status: Some(status.clone()),
        message: status
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn command_error(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr).trim().to_string();
    for line in text.lines().rev() {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if let Some(message) = value.get("error").and_then(Value::as_str) {
                return message.to_string();
            }
        }
    }
    text
}

fn run_ssh_fixed(profile: &SshConnectionOptions, remote_args: &[&str]) -> Result<(), String> {
    let output = ssh_remote_output(profile, remote_args)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(&output.stderr))
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(ALPHABET[((value >> 18) & 63) as usize] as char);
        output.push(ALPHABET[((value >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn powershell_encoded(script: &str) -> String {
    let bytes = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    base64_encode(&bytes)
}

fn bundled_remote_host(app: &AppHandle, system: &RemoteSystem) -> Result<PathBuf, String> {
    let name = if system.platform == "windows" {
        "lystar-gui-host.exe"
    } else {
        "lystar-gui-host"
    };
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let source = resource_dir
        .join("remote-hosts")
        .join(format!("{}-{}", system.platform, system.arch))
        .join("lystar-gui-host.bin");
    if !source.is_file() {
        return Err(format!(
            "未找到匹配远端系统的后台安装包：{}",
            source.display()
        ));
    }
    let destination = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("runtime")
        .join(env!("CARGO_PKG_VERSION"))
        .join("remote-hosts")
        .join(format!("{}-{}", system.platform, system.arch))
        .join(name);
    materialize_host(&source, &destination)?;
    Ok(destination)
}

fn remote_runtime_sources(app: &AppHandle, host: PathBuf) -> Result<Vec<PathBuf>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let mut sources = vec![host];
    for name in [
        "package.json",
        "gui-host-package.json",
        "README.md",
        "CHANGELOG.md",
        "LICENSE",
        "THIRD_PARTY_LICENSES.md",
        "docs",
        "examples",
        "skills",
        "export-html",
        "theme",
        "assets",
        "photon_rs_bg.wasm",
    ] {
        let path = resource_dir.join(name);
        if !path.exists() {
            return Err(format!("GUI 安装资源缺失：{}", path.display()));
        }
        sources.push(path);
    }
    Ok(sources)
}

fn scp_runtime(
    profile: &SshConnectionOptions,
    sources: &[PathBuf],
    destination: &str,
) -> Result<(), String> {
    let mut command = Command::new("scp");
    let target = configure_scp(&mut command, profile)?;
    command.args(sources);
    let output = command
        .arg(format!("{target}:{destination}/"))
        .output()
        .map_err(|error| format!("无法启动 SCP：{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn install_ssh_host(
    app: AppHandle,
    profile: SshConnectionOptions,
    source_path: Option<String>,
) -> Result<SshProbeResult, String> {
    validate_ssh_target(&profile.target)?;
    if profile.host_command.is_some() {
        return Err("自定义远端后台命令不能自动安装，请清空该字段后使用默认安装位置".into());
    }
    let system = detect_remote_system(&profile)?;
    let host = source_path
        .map(PathBuf::from)
        .map_or_else(|| bundled_remote_host(&app, &system), Ok)?;
    if !host.is_file() {
        return Err("所选远端后台安装包不存在".into());
    }
    let expected_name = if system.platform == "windows" {
        "lystar-gui-host.exe"
    } else {
        "lystar-gui-host"
    };
    if host.file_name().and_then(|name| name.to_str()) != Some(expected_name) {
        return Err(format!("远端后台二进制文件名必须为 {expected_name}"));
    }
    let sources = remote_runtime_sources(&app, host)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();

    if system.platform == "windows" {
        let stage = format!(".local/share/lystar-gui-host/staging-{stamp}");
        let prepare = powershell_encoded(&format!(
            "$p=Join-Path $env:USERPROFILE '{stage}'; Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $p | Out-Null"
        ));
        run_ssh_fixed(
            &profile,
            &[
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &prepare,
            ],
        )?;
        scp_runtime(&profile, &sources, &stage)?;
        let activate = powershell_encoded(&format!(
            "$root=Join-Path $env:USERPROFILE '.local/share/lystar-gui-host'; $stage=Join-Path $env:USERPROFILE '{stage}'; $current=Join-Path $root 'current'; $previous=Join-Path $root 'previous'; $old=Join-Path $current 'lystar-gui-host.exe'; if (Test-Path $old) {{ & $old stop; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }} }}; Remove-Item -Recurse -Force $previous -ErrorAction SilentlyContinue; if (Test-Path $current) {{ Move-Item $current $previous }}; Move-Item $stage $current; $new=Join-Path $current 'lystar-gui-host.exe'; & $new install; $code=$LASTEXITCODE; if ($code -ne 0) {{ Remove-Item -Recurse -Force $current -ErrorAction SilentlyContinue; if (Test-Path $previous) {{ Move-Item $previous $current; $rollback=Join-Path $current 'lystar-gui-host.exe'; & $rollback install }}; exit $code }}; Remove-Item -Recurse -Force $previous -ErrorAction SilentlyContinue"
        ));
        run_ssh_fixed(
            &profile,
            &[
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &activate,
            ],
        )?;
        return probe_ssh_connection(profile);
    }

    let stage = format!("~/.local/share/lystar-gui-host/staging-{stamp}");
    run_ssh_fixed(&profile, &["mkdir", "-p", &stage])?;
    scp_runtime(&profile, &sources, &stage)?;
    let activate = format!(
        "'root=~/.local/share/lystar-gui-host; stage={stage}; current=$root/current; previous=$root/previous; if [ -x ~/.local/bin/lystar-gui-host ]; then ~/.local/bin/lystar-gui-host stop || exit $?; fi; rm -rf $previous; if [ -e $current ]; then mv $current $previous; fi; mv $stage $current; mkdir -p ~/.local/bin; ln -sfn $current/lystar-gui-host ~/.local/bin/lystar-gui-host; chmod 700 $current/lystar-gui-host; if ! ~/.local/bin/lystar-gui-host install; then if [ -e $previous ]; then rm -f ~/.local/bin/lystar-gui-host; rm -rf $current; mv $previous $current; ln -sfn $current/lystar-gui-host ~/.local/bin/lystar-gui-host; ~/.local/bin/lystar-gui-host install; fi; exit 1; fi; rm -rf $previous'"
    );
    run_ssh_fixed(&profile, &["sh", "-c", &activate])?;
    probe_ssh_connection(profile)
}

fn desktop_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("desktop-state.json"))
}

#[tauri::command]
fn load_desktop_state(app: AppHandle) -> Result<Value, String> {
    let path = desktop_state_path(&app)?;
    if !path.exists() {
        return Ok(serde_json::json!({"version": 1, "connections": [], "projects": []}));
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_DESKTOP_STATE_BYTES {
        return Err("桌面配置文件超过大小上限".into());
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("桌面配置文件损坏：{error}"))
}

fn sync_parent(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0x1 | 0x8) };
    if result == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn save_desktop_state(app: AppHandle, state: Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&state).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_DESKTOP_STATE_BYTES {
        return Err("桌面配置文件超过大小上限".into());
    }
    let path = desktop_state_path(&app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "桌面配置目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".desktop-state.{}.{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    replace_file(&temporary, &path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })?;
    sync_parent(parent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn materializes_valid_host_payload_and_rejects_invalid_header() {
        let root = std::env::temp_dir().join(format!(
            "lystar-gui-host-payload-{}-{}",
            process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("host.bin");
        let destination = root.join("runtime/lystar-gui-host");
        let mut payload = HOST_PAYLOAD_HEADER.to_vec();
        payload.extend_from_slice(b"host-bytes");
        fs::write(&source, payload).unwrap();

        materialize_host(&source, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"host-bytes");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }

        fs::write(&source, b"invalid").unwrap();
        assert!(materialize_host(&source, &destination).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(GuiHostState::default())
        .setup(|app| {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            let Some(window) = app.get_webview_window("main") else { return Ok(()) };
            #[cfg(target_os = "macos")]
            let _ = window_vibrancy::apply_vibrancy(
                &window,
                window_vibrancy::NSVisualEffectMaterial::Sidebar,
                Some(window_vibrancy::NSVisualEffectState::FollowsWindowActiveState),
                None,
            );
            #[cfg(target_os = "windows")]
            let _ = window_vibrancy::apply_mica(&window, None);
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_gui_host,
            open_ssh_host,
            write_gui_host,
            close_gui_host,
            probe_ssh_connection,
            install_ssh_host,
            inspect_ssh_host_key,
            trust_ssh_host_key,
            store_ssh_password,
            delete_ssh_password,
            load_desktop_state,
            save_desktop_state
        ])
        .build(tauri::generate_context!())
        .expect("failed to build LYStar Code GUI");

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            let state = app.state::<GuiHostState>();
            close_all_connections(state.inner());
            for credential_id in state.ephemeral_credentials.lock().unwrap().drain() {
                let _ = credential_entry(&credential_id).and_then(|entry| {
                    entry
                        .delete_credential()
                        .map_err(|error| error.to_string())
                });
            }
        }
    });
}
