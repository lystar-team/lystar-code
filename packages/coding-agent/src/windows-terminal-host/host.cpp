#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <shellapi.h>
#include <wrl.h>
#include <WebView2.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

#include "resource.h"

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

namespace {

constexpr wchar_t kWindowClass[] = L"LYStarTerminalWindow";
constexpr wchar_t kDefaultTitle[] = L"LYStar Code";
constexpr wchar_t kVirtualHost[] = L"lystar.local";
constexpr UINT kOutputMessage = WM_APP + 1;
constexpr UINT kChildExitMessage = WM_APP + 2;
constexpr UINT kSmokeCloseMessage = WM_APP + 3;
constexpr UINT_PTR kExitTimer = 1;

HWND g_window = nullptr;
ComPtr<ICoreWebView2Controller> g_controller;
ComPtr<ICoreWebView2> g_webview;
HPCON g_pseudoConsole = nullptr;
HANDLE g_inputWrite = INVALID_HANDLE_VALUE;
HANDLE g_outputRead = INVALID_HANDLE_VALUE;
HANDLE g_childProcess = nullptr;
HANDLE g_childThread = nullptr;
int g_columns = 120;
int g_rows = 36;
bool g_closing = false;
std::vector<std::wstring> g_childArgs;

std::wstring ModulePath() {
	std::vector<wchar_t> buffer(32768);
	const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
	return std::wstring(buffer.data(), length);
}

std::wstring DirectoryName(const std::wstring& path) {
	const auto separator = path.find_last_of(L"\\/");
	return separator == std::wstring::npos ? L"." : path.substr(0, separator);
}

bool FileExists(const std::wstring& path) {
	const DWORD attributes = GetFileAttributesW(path.c_str());
	return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

std::wstring GetEnvironment(const wchar_t* name) {
	const DWORD required = GetEnvironmentVariableW(name, nullptr, 0);
	if (required == 0) return {};
	std::vector<wchar_t> value(required);
	GetEnvironmentVariableW(name, value.data(), required);
	return value.data();
}

std::wstring QuoteArgument(const std::wstring& argument) {
	if (argument.empty()) return L"\"\"";
	if (argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) return argument;
	std::wstring result = L"\"";
	std::size_t backslashes = 0;
	for (const wchar_t character : argument) {
		if (character == L'\\') {
			backslashes++;
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

std::string WideToUtf8(const std::wstring& value) {
	if (value.empty()) return {};
	const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
	std::string result(size, '\0');
	WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
	return result;
}

std::wstring Base64(const std::uint8_t* data, std::size_t size) {
	static constexpr wchar_t alphabet[] = L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	std::wstring output;
	output.reserve(((size + 2) / 3) * 4);
	for (std::size_t index = 0; index < size; index += 3) {
		const std::uint32_t first = data[index];
		const std::uint32_t second = index + 1 < size ? data[index + 1] : 0;
		const std::uint32_t third = index + 2 < size ? data[index + 2] : 0;
		const std::uint32_t value = (first << 16) | (second << 8) | third;
		output.push_back(alphabet[(value >> 18) & 63]);
		output.push_back(alphabet[(value >> 12) & 63]);
		output.push_back(index + 1 < size ? alphabet[(value >> 6) & 63] : L'=');
		output.push_back(index + 2 < size ? alphabet[value & 63] : L'=');
	}
	return output;
}

void QueueBytes(const std::uint8_t* data, std::size_t size) {
	auto* message = new std::wstring(L"data:" + Base64(data, size));
	if (!PostMessageW(g_window, kOutputMessage, 0, reinterpret_cast<LPARAM>(message))) delete message;
}

void QueueText(const std::wstring& text) {
	const std::string utf8 = WideToUtf8(text);
	QueueBytes(reinterpret_cast<const std::uint8_t*>(utf8.data()), utf8.size());
}

std::wstring LastErrorText(DWORD error = GetLastError()) {
	wchar_t* message = nullptr;
	FormatMessageW(
		FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
		nullptr,
		error,
		MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
		reinterpret_cast<wchar_t*>(&message),
		0,
		nullptr);
	std::wstring result = message ? message : L"未知错误";
	if (message) LocalFree(message);
	return result;
}

void ResizeWebView() {
	if (!g_controller || !g_window) return;
	RECT bounds{};
	GetClientRect(g_window, &bounds);
	g_controller->put_Bounds(bounds);
}

void ResizePty(int columns, int rows) {
	g_columns = std::clamp(columns, 40, 500);
	g_rows = std::clamp(rows, 12, 200);
	if (g_pseudoConsole) ResizePseudoConsole(g_pseudoConsole, COORD{static_cast<SHORT>(g_columns), static_cast<SHORT>(g_rows)});
}

void WriteInput(const std::wstring& input) {
	if (g_inputWrite == INVALID_HANDLE_VALUE) return;
	const std::string utf8 = WideToUtf8(input);
	DWORD written = 0;
	WriteFile(g_inputWrite, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr);
}

void CloseHandleIfValid(HANDLE& handle) {
	if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
	handle = INVALID_HANDLE_VALUE;
}

void StopChild(bool terminate) {
	if (g_childProcess) {
		if (!terminate) {
			WriteInput(std::wstring(1, static_cast<wchar_t>(3)));
			if (WaitForSingleObject(g_childProcess, 1500) == WAIT_TIMEOUT) terminate = true;
		}
		if (terminate) TerminateProcess(g_childProcess, 1);
	}
	if (g_pseudoConsole) {
		ClosePseudoConsole(g_pseudoConsole);
		g_pseudoConsole = nullptr;
	}
	CloseHandleIfValid(g_inputWrite);
	CloseHandleIfValid(g_outputRead);
	CloseHandleIfValid(g_childThread);
	CloseHandleIfValid(g_childProcess);
}

DWORD WINAPI ReadPtyOutput(void*) {
	std::vector<std::uint8_t> buffer(32768);
	for (;;) {
		DWORD bytesRead = 0;
		if (!ReadFile(g_outputRead, buffer.data(), static_cast<DWORD>(buffer.size()), &bytesRead, nullptr) || bytesRead == 0) break;
		QueueBytes(buffer.data(), bytesRead);
	}
	return 0;
}

DWORD WINAPI WaitForChild(void*) {
	WaitForSingleObject(g_childProcess, INFINITE);
	DWORD exitCode = 1;
	GetExitCodeProcess(g_childProcess, &exitCode);
	PostMessageW(g_window, kChildExitMessage, exitCode, 0);
	return 0;
}

bool StartChild() {
	if (g_childProcess) return true;
	HANDLE inputRead = INVALID_HANDLE_VALUE;
	HANDLE outputWrite = INVALID_HANDLE_VALUE;
	if (!CreatePipe(&inputRead, &g_inputWrite, nullptr, 0) || !CreatePipe(&g_outputRead, &outputWrite, nullptr, 0)) {
		QueueText(L"\r\n\x1b[31mConPTY 管道创建失败：" + LastErrorText() + L"\x1b[0m\r\n");
		return false;
	}

	const HRESULT ptyResult = CreatePseudoConsole(
		COORD{static_cast<SHORT>(g_columns), static_cast<SHORT>(g_rows)}, inputRead, outputWrite, 0, &g_pseudoConsole);
	CloseHandleIfValid(inputRead);
	CloseHandleIfValid(outputWrite);
	if (FAILED(ptyResult)) {
		QueueText(L"\r\n\x1b[31mConPTY 创建失败，请确认系统为 Windows 10 1809 或更高版本。\x1b[0m\r\n");
		return false;
	}

	SIZE_T attributeSize = 0;
	InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
	auto* attributes = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, attributeSize));
	if (!attributes || !InitializeProcThreadAttributeList(attributes, 1, 0, &attributeSize) ||
		!UpdateProcThreadAttribute(
			attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, g_pseudoConsole, sizeof(g_pseudoConsole), nullptr, nullptr)) {
		if (attributes) HeapFree(GetProcessHeap(), 0, attributes);
		QueueText(L"\r\n\x1b[31mConPTY 子进程属性初始化失败。\x1b[0m\r\n");
		return false;
	}

	std::wstring codePath = GetEnvironment(L"LYSTAR_TERMINAL_CODE_PATH");
	if (codePath.empty()) codePath = DirectoryName(ModulePath()) + L"\\lc.exe";
	if (!FileExists(codePath)) {
		DeleteProcThreadAttributeList(attributes);
		HeapFree(GetProcessHeap(), 0, attributes);
		QueueText(L"\r\n\x1b[31m找不到 lc.exe：" + codePath + L"\x1b[0m\r\n");
		return false;
	}

	std::wstring commandLine = QuoteArgument(codePath) + L" --attached";
	for (const auto& argument : g_childArgs) commandLine += L" " + QuoteArgument(argument);
	std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
	mutableCommand.push_back(L'\0');
	SetEnvironmentVariableW(L"LYSTAR_TERMINAL_HOST", L"1");

	STARTUPINFOEXW startup{};
	startup.StartupInfo.cb = sizeof(startup);
	startup.lpAttributeList = attributes;
	PROCESS_INFORMATION process{};
	const BOOL created = CreateProcessW(
		codePath.c_str(),
		mutableCommand.data(),
		nullptr,
		nullptr,
		FALSE,
		EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
		nullptr,
		nullptr,
		&startup.StartupInfo,
		&process);
	DeleteProcThreadAttributeList(attributes);
	HeapFree(GetProcessHeap(), 0, attributes);
	if (!created) {
		QueueText(L"\r\n\x1b[31mlc.exe 启动失败：" + LastErrorText() + L"\x1b[0m\r\n");
		return false;
	}

	g_childProcess = process.hProcess;
	g_childThread = process.hThread;
	CloseHandle(CreateThread(nullptr, 0, ReadPtyOutput, nullptr, 0, nullptr));
	CloseHandle(CreateThread(nullptr, 0, WaitForChild, nullptr, 0, nullptr));
	return true;
}

bool IsAllowedExternalUrl(const std::wstring& url) {
	return url.rfind(L"https://", 0) == 0 || url.rfind(L"http://", 0) == 0;
}

void HandleWebMessage(const std::wstring& message) {
	if (message == L"ready") {
		StartChild();
		return;
	}
	if (message.rfind(L"input:", 0) == 0) {
		WriteInput(message.substr(6));
		return;
	}
	if (message.rfind(L"resize:", 0) == 0) {
		int columns = 0;
		int rows = 0;
		if (swscanf_s(message.c_str() + 7, L"%d,%d", &columns, &rows) == 2) ResizePty(columns, rows);
		return;
	}
	if (message.rfind(L"title:", 0) == 0) {
		const std::wstring title = message.substr(6);
		SetWindowTextW(g_window, title.empty() ? kDefaultTitle : title.c_str());
		return;
	}
	if (message.rfind(L"open:", 0) == 0) {
		const std::wstring url = message.substr(5);
		if (IsAllowedExternalUrl(url)) ShellExecuteW(g_window, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
	}
}

void ShowWebViewError(HRESULT result) {
	wchar_t message[512]{};
	swprintf_s(
		message,
		L"LYStar 独立终端启动失败（0x%08X）。请安装 Microsoft Edge WebView2 Runtime，或运行 lc --attached。",
		static_cast<unsigned>(result));
	MessageBoxW(g_window, message, kDefaultTitle, MB_OK | MB_ICONERROR);
	DestroyWindow(g_window);
}

void InitializeWebView() {
	std::wstring userData = GetEnvironment(L"LOCALAPPDATA");
	if (!userData.empty()) userData += L"\\LYStarAgent\\WebView2";
	const HRESULT result = CreateCoreWebView2EnvironmentWithOptions(
		nullptr,
		userData.empty() ? nullptr : userData.c_str(),
		nullptr,
		Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
			[](HRESULT environmentResult, ICoreWebView2Environment* environment) -> HRESULT {
				if (FAILED(environmentResult) || !environment) {
					ShowWebViewError(environmentResult);
					return S_OK;
				}
				return environment->CreateCoreWebView2Controller(
					g_window,
					Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
						[](HRESULT controllerResult, ICoreWebView2Controller* controller) -> HRESULT {
							if (FAILED(controllerResult) || !controller) {
								ShowWebViewError(controllerResult);
								return S_OK;
							}
							g_controller = controller;
							controller->get_CoreWebView2(&g_webview);
							ResizeWebView();
							controller->put_IsVisible(TRUE);

							ComPtr<ICoreWebView2Settings> settings;
							g_webview->get_Settings(&settings);
							settings->put_AreDevToolsEnabled(FALSE);
							settings->put_AreDefaultContextMenusEnabled(FALSE);
							settings->put_IsStatusBarEnabled(FALSE);

							ComPtr<ICoreWebView2_3> webview3;
							if (SUCCEEDED(g_webview.As(&webview3))) {
								const std::wstring terminalDir = DirectoryName(ModulePath()) + L"\\terminal";
								webview3->SetVirtualHostNameToFolderMapping(
									kVirtualHost, terminalDir.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
							}

							EventRegistrationToken webMessageToken{};
							g_webview->add_WebMessageReceived(
								Callback<ICoreWebView2WebMessageReceivedEventHandler>(
									[](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
										wchar_t* rawMessage = nullptr;
										if (SUCCEEDED(args->TryGetWebMessageAsString(&rawMessage)) && rawMessage) {
											HandleWebMessage(rawMessage);
											CoTaskMemFree(rawMessage);
										}
										return S_OK;
									})
									.Get(),
								&webMessageToken);

							EventRegistrationToken navigationToken{};
							g_webview->add_NavigationStarting(
								Callback<ICoreWebView2NavigationStartingEventHandler>(
									[](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
										wchar_t* rawUri = nullptr;
										if (SUCCEEDED(args->get_Uri(&rawUri)) && rawUri) {
											const std::wstring uri(rawUri);
											if (uri.rfind(L"https://lystar.local/", 0) != 0) args->put_Cancel(TRUE);
											CoTaskMemFree(rawUri);
										}
										return S_OK;
									})
									.Get(),
								&navigationToken);

							EventRegistrationToken navigationCompletedToken{};
							g_webview->add_NavigationCompleted(
								Callback<ICoreWebView2NavigationCompletedEventHandler>(
									[](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
										BOOL successful = FALSE;
										if (SUCCEEDED(args->get_IsSuccess(&successful)) && successful) StartChild();
										return S_OK;
									})
									.Get(),
								&navigationCompletedToken);

							EventRegistrationToken newWindowToken{};
							g_webview->add_NewWindowRequested(
								Callback<ICoreWebView2NewWindowRequestedEventHandler>(
									[](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
										args->put_Handled(TRUE);
										return S_OK;
									})
									.Get(),
								&newWindowToken);

							g_webview->Navigate(L"https://lystar.local/index.html");
							return S_OK;
						})
						.Get());
			})
			.Get());
	if (FAILED(result)) ShowWebViewError(result);
}

void SaveWindowBounds(HWND window) {
	if (IsIconic(window)) return;
	RECT bounds{};
	if (!GetWindowRect(window, &bounds)) return;
	HKEY key = nullptr;
	if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\LYStarAgent\\Terminal", 0, nullptr, 0, KEY_WRITE, nullptr, &key, nullptr) != ERROR_SUCCESS) return;
	const DWORD values[] = {
		static_cast<DWORD>(bounds.left),
		static_cast<DWORD>(bounds.top),
		static_cast<DWORD>(bounds.right - bounds.left),
		static_cast<DWORD>(bounds.bottom - bounds.top),
	};
	const wchar_t* names[] = {L"Left", L"Top", L"Width", L"Height"};
	for (int index = 0; index < 4; index++) RegSetValueExW(key, names[index], 0, REG_DWORD, reinterpret_cast<const BYTE*>(&values[index]), sizeof(DWORD));
	RegCloseKey(key);
}

RECT LoadWindowBounds() {
	RECT bounds{CW_USEDEFAULT, CW_USEDEFAULT, 1120, 760};
	HKEY key = nullptr;
	if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\LYStarAgent\\Terminal", 0, KEY_READ, &key) != ERROR_SUCCESS) return bounds;
	DWORD values[4]{};
	const wchar_t* names[] = {L"Left", L"Top", L"Width", L"Height"};
	bool complete = true;
	for (int index = 0; index < 4; index++) {
		DWORD size = sizeof(DWORD);
		complete &= RegQueryValueExW(key, names[index], nullptr, nullptr, reinterpret_cast<BYTE*>(&values[index]), &size) == ERROR_SUCCESS;
	}
	RegCloseKey(key);
	if (!complete || values[2] < 640 || values[3] < 400) return bounds;
	RECT saved{
		static_cast<LONG>(values[0]),
		static_cast<LONG>(values[1]),
		static_cast<LONG>(values[0] + values[2]),
		static_cast<LONG>(values[1] + values[3]),
	};
	if (!MonitorFromRect(&saved, MONITOR_DEFAULTTONULL)) return bounds;
	return saved;
}

LRESULT CALLBACK WindowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
	switch (message) {
		case WM_SIZE:
			ResizeWebView();
			return 0;
		case WM_GETMINMAXINFO: {
			auto* info = reinterpret_cast<MINMAXINFO*>(lParam);
			info->ptMinTrackSize = POINT{720, 480};
			return 0;
		}
		case kOutputMessage: {
			auto* output = reinterpret_cast<std::wstring*>(lParam);
			if (output && g_webview) g_webview->PostWebMessageAsString(output->c_str());
			delete output;
			return 0;
		}
		case kChildExitMessage:
			if (g_webview) {
				const std::wstring event = L"exit:" + std::to_wstring(static_cast<DWORD>(wParam));
				g_webview->PostWebMessageAsString(event.c_str());
			}
			SetTimer(window, kExitTimer, 250, nullptr);
			return 0;
		case kSmokeCloseMessage:
			if (std::find(g_childArgs.begin(), g_childArgs.end(), L"--windows-terminal-ui-smoke") != g_childArgs.end()) {
				DestroyWindow(window);
			}
			return 0;
		case WM_TIMER:
			if (wParam == kExitTimer) DestroyWindow(window);
			return 0;
		case WM_CLOSE:
			if (g_childProcess && WaitForSingleObject(g_childProcess, 0) == WAIT_TIMEOUT) {
				const int answer = MessageBoxW(window, L"当前 LYStar 会话仍在运行，确定关闭窗口吗？", kDefaultTitle, MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2);
				if (answer != IDYES) return 0;
			}
			g_closing = true;
			StopChild(false);
			DestroyWindow(window);
			return 0;
		case WM_DESTROY:
			SaveWindowBounds(window);
			if (!g_closing) StopChild(true);
			g_webview.Reset();
			g_controller.Reset();
			PostQuitMessage(0);
			return 0;
	}
	return DefWindowProcW(window, message, wParam, lParam);
}

int SmokeTest() {
	const std::wstring terminalIndex = DirectoryName(ModulePath()) + L"\\terminal\\index.html";
	if (!FileExists(terminalIndex)) return 2;
	wchar_t* version = nullptr;
	const HRESULT result = GetAvailableCoreWebView2BrowserVersionString(nullptr, &version);
	if (version) CoTaskMemFree(version);
	return SUCCEEDED(result) ? 0 : 3;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, wchar_t*, int showCommand) {
	SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
	if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;

	int argumentCount = 0;
	wchar_t** arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
	for (int index = 1; index < argumentCount; index++) {
		if (wcscmp(arguments[index], L"--smoke-test") == 0) {
			LocalFree(arguments);
			const int result = SmokeTest();
			CoUninitialize();
			return result;
		}
		g_childArgs.emplace_back(arguments[index]);
	}
	LocalFree(arguments);

	const HICON icon = static_cast<HICON>(LoadImageW(instance, MAKEINTRESOURCEW(IDI_LYSTAR), IMAGE_ICON, 0, 0, LR_DEFAULTSIZE));
	WNDCLASSEXW windowClass{};
	windowClass.cbSize = sizeof(windowClass);
	windowClass.style = CS_HREDRAW | CS_VREDRAW;
	windowClass.lpfnWndProc = WindowProcedure;
	windowClass.hInstance = instance;
	windowClass.hIcon = icon;
	windowClass.hIconSm = icon;
	windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
	windowClass.hbrBackground = reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
	windowClass.lpszClassName = kWindowClass;
	if (!RegisterClassExW(&windowClass)) {
		CoUninitialize();
		return 1;
	}

	const RECT bounds = LoadWindowBounds();
	const int x = bounds.left == CW_USEDEFAULT ? CW_USEDEFAULT : bounds.left;
	const int y = bounds.top == CW_USEDEFAULT ? CW_USEDEFAULT : bounds.top;
	const int width = bounds.left == CW_USEDEFAULT ? bounds.right : bounds.right - bounds.left;
	const int height = bounds.top == CW_USEDEFAULT ? bounds.bottom : bounds.bottom - bounds.top;
	g_window = CreateWindowExW(
		0,
		kWindowClass,
		kDefaultTitle,
		WS_OVERLAPPEDWINDOW,
		x,
		y,
		width,
		height,
		nullptr,
		nullptr,
		instance,
		nullptr);
	if (!g_window) {
		CoUninitialize();
		return 1;
	}

	ShowWindow(g_window, showCommand == SW_HIDE ? SW_SHOWNORMAL : showCommand);
	UpdateWindow(g_window);
	InitializeWebView();

	MSG message{};
	while (GetMessageW(&message, nullptr, 0, 0) > 0) {
		TranslateMessage(&message);
		DispatchMessageW(&message);
	}
	CoUninitialize();
	return static_cast<int>(message.wParam);
}