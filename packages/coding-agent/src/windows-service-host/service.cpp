#include <windows.h>

#include <algorithm>
#include <cctype>
#include <cwchar>
#include <cwctype>
#include <map>
#include <string>
#include <vector>

namespace {

SERVICE_STATUS_HANDLE g_status_handle = nullptr;
SERVICE_STATUS g_status{};
HANDLE g_stop_event = nullptr;
HANDLE g_job = nullptr;
PROCESS_INFORMATION g_child{};
bool g_stopping = false;
std::wstring g_service_name;
std::wstring g_config_path;

std::wstring trim(const std::wstring& value) {
    const auto first = value.find_first_not_of(L" \t\r\n");
    if (first == std::wstring::npos) return L"";
    const auto last = value.find_last_not_of(L" \t\r\n");
    return value.substr(first, last - first + 1);
}

std::wstring last_error_text(DWORD error = GetLastError()) {
    wchar_t* buffer = nullptr;
    const DWORD length = FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr,
        error,
        0,
        reinterpret_cast<LPWSTR>(&buffer),
        0,
        nullptr
    );
    std::wstring result = length > 0 && buffer != nullptr ? std::wstring(buffer, length) : L"未知错误";
    if (buffer != nullptr) LocalFree(buffer);
    return trim(result);
}

void report_status(DWORD current_state, DWORD win32_exit_code = NO_ERROR, DWORD wait_hint = 0) {
    static DWORD checkpoint = 1;
    g_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
    g_status.dwCurrentState = current_state;
    g_status.dwWin32ExitCode = win32_exit_code;
    g_status.dwWaitHint = wait_hint;
    g_status.dwControlsAccepted = current_state == SERVICE_RUNNING
        ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
        : 0;
    g_status.dwCheckPoint = (current_state == SERVICE_START_PENDING || current_state == SERVICE_STOP_PENDING)
        ? checkpoint++
        : 0;
    if (g_status_handle != nullptr) SetServiceStatus(g_status_handle, &g_status);
}

bool read_utf8_file(const std::wstring& path, std::wstring& output) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file, &size) || size.QuadPart < 0 || size.QuadPart > 16 * 1024 * 1024) {
        CloseHandle(file);
        SetLastError(ERROR_FILE_TOO_LARGE);
        return false;
    }
    std::vector<char> bytes(static_cast<size_t>(size.QuadPart));
    DWORD read = 0;
    const bool ok = bytes.empty() || ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr);
    CloseHandle(file);
    if (!ok || read != bytes.size()) return false;
    const int byte_count = static_cast<int>(read);
    const int wide_count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), byte_count, nullptr, 0);
    if (wide_count <= 0) return false;
    output.resize(static_cast<size_t>(wide_count));
    return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), byte_count, output.data(), wide_count) == wide_count;
}

struct ServiceConfig {
    std::wstring program;
    std::wstring working_directory;
    std::wstring arguments;
    std::wstring log_path;
    std::map<std::wstring, std::wstring> environment;
};

bool read_config(const std::wstring& path, ServiceConfig& config) {
    std::wstring content;
    if (!read_utf8_file(path, content)) return false;
    if (!content.empty() && content.front() == L'\ufeff') content.erase(content.begin());
    std::wstring section;
    size_t start = 0;
    while (start <= content.size()) {
        const size_t end = content.find(L'\n', start);
        const std::wstring line = trim(content.substr(start, end == std::wstring::npos ? std::wstring::npos : end - start));
        start = end == std::wstring::npos ? content.size() + 1 : end + 1;
        if (line.empty() || line.front() == L';' || line.front() == L'#') continue;
        if (line.front() == L'[' && line.back() == L']') {
            section = trim(line.substr(1, line.size() - 2));
            continue;
        }
        const size_t separator = line.find(L'=');
        if (separator == std::wstring::npos) continue;
        const std::wstring key = trim(line.substr(0, separator));
        const std::wstring value = trim(line.substr(separator + 1));
        if (section == L"service") {
            if (key == L"program") config.program = value;
            else if (key == L"workingDirectory") config.working_directory = value;
            else if (key == L"arguments") config.arguments = value;
            else if (key == L"logPath") config.log_path = value;
        } else if (section == L"environment") {
            config.environment[key] = value;
        }
    }
    return !config.program.empty() && !config.working_directory.empty();
}

std::wstring quote_windows_argument(const std::wstring& value) {
    if (value.empty()) return L"\"\"";
    if (value.find_first_of(L" \t\"\\") == std::wstring::npos) return value;
    std::wstring result = L"\"";
    size_t backslashes = 0;
    for (const wchar_t character : value) {
        if (character == L'\\') {
            ++backslashes;
            continue;
        }
        if (character == L'\"') {
            result.append(backslashes * 2 + 1, L'\\');
            result.push_back(L'\"');
            backslashes = 0;
            continue;
        }
        result.append(backslashes, L'\\');
        backslashes = 0;
        result.push_back(character);
    }
    result.append(backslashes * 2, L'\\');
    result.push_back(L'\"');
    return result;
}

bool has_extension(const std::wstring& path, const wchar_t* extension) {
    if (path.size() < wcslen(extension)) return false;
    std::wstring suffix = path.substr(path.size() - wcslen(extension));
    std::transform(suffix.begin(), suffix.end(), suffix.begin(), towlower);
    return suffix == extension;
}

std::vector<wchar_t> make_environment_block(const ServiceConfig& config) {
    std::map<std::wstring, std::wstring> values;
    LPWCH current = GetEnvironmentStringsW();
    if (current != nullptr) {
        for (LPWCH entry = current; *entry != L'\0'; entry += wcslen(entry) + 1) {
            const std::wstring value(entry);
            const size_t separator = value.find(L'=');
            if (separator != std::wstring::npos && separator > 0) {
                values[value.substr(0, separator)] = value.substr(separator + 1);
            }
        }
        FreeEnvironmentStringsW(current);
    }
    for (const auto& [key, value] : config.environment) values[key] = value;
    std::vector<wchar_t> block;
    for (const auto& [key, value] : values) {
        const std::wstring item = key + L"=" + value;
        block.insert(block.end(), item.begin(), item.end());
        block.push_back(L'\0');
    }
    block.push_back(L'\0');
    return block;
}

bool open_log(const ServiceConfig& config, HANDLE& handle) {
    if (config.log_path.empty()) {
        handle = GetStdHandle(STD_OUTPUT_HANDLE);
        return handle != nullptr && handle != INVALID_HANDLE_VALUE;
    }
    SECURITY_ATTRIBUTES security{};
    security.nLength = sizeof(security);
    security.bInheritHandle = TRUE;
    handle = CreateFileW(
        config.log_path.c_str(),
        FILE_APPEND_DATA | GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        &security,
        OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        nullptr
    );
    if (handle == INVALID_HANDLE_VALUE) return false;
    SetFilePointer(handle, 0, nullptr, FILE_END);
    return true;
}

bool start_child(const ServiceConfig& config) {
    HANDLE log = INVALID_HANDLE_VALUE;
    if (!open_log(config, log)) return false;

    SECURITY_ATTRIBUTES security{};
    security.nLength = sizeof(security);
    security.bInheritHandle = TRUE;
    HANDLE input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (input == INVALID_HANDLE_VALUE) {
        CloseHandle(log);
        return false;
    }

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = input;
    startup.hStdOutput = log;
    startup.hStdError = log;

    std::wstring application = config.program;
    std::wstring command_line;
    if (has_extension(config.program, L".cmd") || has_extension(config.program, L".bat")) {
        wchar_t comspec[MAX_PATH]{};
        const DWORD length = GetEnvironmentVariableW(L"ComSpec", comspec, MAX_PATH);
        application = length > 0 && length < MAX_PATH ? std::wstring(comspec, length) : L"C:\\Windows\\System32\\cmd.exe";
        command_line = L"/d /s /c \"" + quote_windows_argument(config.program);
        if (!config.arguments.empty()) command_line += L" " + config.arguments;
        command_line += L"\"";
    } else {
        command_line = quote_windows_argument(config.program);
        if (!config.arguments.empty()) command_line += L" " + config.arguments;
    }

    std::vector<wchar_t> environment = make_environment_block(config);
    std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
    mutable_command.push_back(L'\0');
    const BOOL created = CreateProcessW(
        application.c_str(),
        mutable_command.data(),
        nullptr,
        nullptr,
        TRUE,
        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
        environment.data(),
        config.working_directory.c_str(),
        &startup,
        &g_child
    );
    if (created) {
        HANDLE job = CreateJobObjectW(nullptr, nullptr);
        if (job != nullptr) {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits,
                    sizeof(limits)
                ) && AssignProcessToJobObject(job, g_child.hProcess)) {
                g_job = job;
            } else {
                CloseHandle(job);
            }
        }
    }
    CloseHandle(input);
    CloseHandle(log);
    return created == TRUE;
}

void stop_child() {
    if (g_child.hProcess == nullptr) return;
    g_stopping = true;
    if (WaitForSingleObject(g_child.hProcess, 3000) == WAIT_TIMEOUT) {
        if (g_job != nullptr) {
            CloseHandle(g_job);
            g_job = nullptr;
        }
        if (WaitForSingleObject(g_child.hProcess, 0) == WAIT_TIMEOUT) TerminateProcess(g_child.hProcess, 0);
    }
}

void close_child_handles() {
    if (g_job != nullptr) CloseHandle(g_job);
    g_job = nullptr;
    if (g_child.hThread != nullptr) CloseHandle(g_child.hThread);
    if (g_child.hProcess != nullptr) CloseHandle(g_child.hProcess);
    g_child = {};
}

void WINAPI service_handler(DWORD control) {
    if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) {
        if (g_status.dwCurrentState == SERVICE_RUNNING) {
            report_status(SERVICE_STOP_PENDING, NO_ERROR, 5000);
            SetEvent(g_stop_event);
        }
    }
}

void WINAPI service_main(DWORD, LPWSTR*) {
    g_status_handle = RegisterServiceCtrlHandlerW(g_service_name.c_str(), service_handler);
    if (g_status_handle == nullptr) return;
    report_status(SERVICE_START_PENDING, NO_ERROR, 10000);

    ServiceConfig config;
    if (!read_config(g_config_path, config)) {
        report_status(SERVICE_STOPPED, ERROR_BAD_CONFIGURATION);
        return;
    }
    g_stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (g_stop_event == nullptr || !start_child(config)) {
        const DWORD error = GetLastError();
        if (g_stop_event != nullptr) CloseHandle(g_stop_event);
        report_status(SERVICE_STOPPED, error == NO_ERROR ? ERROR_GEN_FAILURE : error);
        return;
    }

    report_status(SERVICE_RUNNING);
    HANDLE waits[] = { g_stop_event, g_child.hProcess };
    const DWORD result = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
    DWORD exit_code = 0;
    if (result == WAIT_OBJECT_0) {
        stop_child();
        exit_code = 0;
    } else if (result == WAIT_OBJECT_0 + 1) {
        GetExitCodeProcess(g_child.hProcess, &exit_code);
        if (exit_code == STILL_ACTIVE) exit_code = ERROR_PROCESS_ABORTED;
    } else {
        exit_code = GetLastError();
    }
    close_child_handles();
    CloseHandle(g_stop_event);
    g_stop_event = nullptr;
    report_status(SERVICE_STOPPED, g_stopping ? NO_ERROR : exit_code == 0 ? ERROR_PROCESS_ABORTED : exit_code);
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    for (int index = 1; index < argc; ++index) {
        const std::wstring argument = argv[index];
        if (argument == L"--service-name" && index + 1 < argc) g_service_name = argv[++index];
        else if (argument == L"--config" && index + 1 < argc) g_config_path = argv[++index];
    }
    if (g_service_name.empty() || g_config_path.empty()) return ERROR_INVALID_PARAMETER;

    SERVICE_TABLE_ENTRYW table[] = {
        { const_cast<LPWSTR>(g_service_name.c_str()), service_main },
        { nullptr, nullptr },
    };
    if (!StartServiceCtrlDispatcherW(table)) return static_cast<int>(GetLastError());
    return 0;
}
