//go:build windows

// WebZoom-LAN-Setup is a no-elevation, per-user installer with no background service.
//
//go:generate go run github.com/akavel/rsrc@v0.10.2 -arch amd64 -manifest setup.manifest -o rsrc_windows_amd64.syso
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"syscall"
	"unsafe"
	"webzoom/internal/lanhost"
	"webzoom/internal/lansetup"
)

var user32 = syscall.NewLazyDLL("user32.dll")
var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var gdi32 = syscall.NewLazyDLL("gdi32.dll")
var shell32 = syscall.NewLazyDLL("shell32.dll")
var createWindow = user32.NewProc("CreateWindowExW")
var setText = user32.NewProc("SetWindowTextW")
var messageBox = user32.NewProc("MessageBoxW")
var statusWindow, mainWindow uintptr
var installer *lansetup.Installer
var bundle *lansetup.Bundle
var font uintptr
var originWindow, portWindow uintptr

func textOf(hwnd uintptr) string {
	var buf [512]uint16
	user32.NewProc("GetWindowTextW").Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return syscall.UTF16ToString(buf[:])
}

func ptr(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }
func status(s string)      { setText.Call(statusWindow, uintptr(unsafe.Pointer(ptr(s)))) }
func dialog(s string, flags uintptr) uintptr {
	r, _, _ := messageBox.Call(mainWindow, uintptr(unsafe.Pointer(ptr(s))), uintptr(unsafe.Pointer(ptr("WebZoom 局域网分流"))), flags)
	return r
}
func diagnosticText(d lanhost.Diagnostic) string {
	switch d.Code {
	case "local_ready":
		return "本机检查通过：辅助程序配置、网卡和本地端口可用。\r\n注意：本次没有发送广播；是否能连接其他电脑，需要在会议中验证。"
	case "network_unsupported":
		return "网卡与安装配置不一致，或存在多个 IPv4 网卡。请联系 IT 检查，不要自行关闭公司 VPN。"
	case "port_unavailable":
		return "本地端口无法使用。请退出其他 LAN 会议后再检查；仍失败请联系 IT 检查系统策略。"
	default:
		return "安装配置无效，请重新安装或修复。"
	}
}
func handle(id uintptr) {
	switch id {
	case 1:
		if bundle.Config.TestOnly {
			status("这是本机演示包，不允许安装。请获取对应公司会议网站的候选包。")
			return
		}
		candidate := bundle
		if bundle.Config.ConfigureOnInstall {
			port, err := strconv.Atoi(textOf(portWindow))
			if err != nil {
				status("请填写 IT 批准的 UDP 端口（1024–65535）")
				return
			}
			candidate, err = bundle.Provision(textOf(originWindow), port)
			if err != nil {
				status(err.Error())
				return
			}
		}
		target, err := lansetup.NewInstaller(os.Getenv("LOCALAPPDATA"), lansetup.UserRegistry{}, candidate)
		if err != nil {
			status(err.Error())
			return
		}
		ip, err := lansetup.AutoInterface()
		if err != nil {
			status(err.Error())
			return
		}
		text := fmt.Sprintf("仅当 IT 已批准此软件及以下网络设置后继续。\r\n\r\n会议网站：%s\r\n本机 IPv4：%s\r\nUDP 端口：%d\r\n\r\n只安装到当前用户目录；不会修改防火墙、VPN、Chrome 策略或公司服务器。\r\n请先退出 LAN 会议。确认安装 / 修复？", candidate.Config.Origin, ip, candidate.Config.Port)
		if dialog(text, 0x24|0x100) != 6 {
			return
		}
		status("正在安装，请稍候…")
		dir, err := target.Install(ip)
		if err != nil {
			status("未完成安装：" + err.Error())
			return
		}
		status("① 辅助程序已安装。② 安装 Chrome 插件：若 IT 已统一下发，直接刷新会议网页；获批本地试点可点击下面两个按钮，在扩展页加载这个文件夹。③ 刷新网页，自动检查通过后启用分流。\r\n扩展文件夹：" + dir)
	case 2:
		p, _, err := installer.Installed()
		if err != nil {
			status(err.Error())
			return
		}
		status(diagnosticText(lanhost.Diagnose(p)) + "\r\n对应网站：" + p.Origin)
	case 3:
		_, dir, err := installer.Installed()
		if err != nil {
			status(err.Error())
			return
		}
		r, _, _ := shell32.NewProc("ShellExecuteW").Call(mainWindow, uintptr(unsafe.Pointer(ptr("open"))), uintptr(unsafe.Pointer(ptr(dir))), 0, 0, 1)
		if r <= 32 {
			status("无法打开扩展文件夹，请联系 IT 检查安装目录。")
		}
	case 7:
		r, _, _ := shell32.NewProc("ShellExecuteW").Call(mainWindow, uintptr(unsafe.Pointer(ptr("open"))), uintptr(unsafe.Pointer(ptr("chrome.exe"))), uintptr(unsafe.Pointer(ptr("chrome://extensions/"))), 0, 1)
		if r <= 32 {
			status("请在 Chrome 地址栏输入 chrome://extensions/ 。若公司策略不允许本地加载，请联系 IT 统一下发插件。")
		}
	case 4:
		if bundle.Config.TestOnly {
			status("演示包不会修改已有安装。")
			return
		}
		if dialog("请先退出所有 LAN 会议。\r\n卸载会移除当前用户的辅助程序注册和本程序的已知文件；Chrome 扩展需通过批准渠道另行移除。\r\n确认卸载？", 0x24|0x100) != 6 {
			return
		}
		if err := installer.Uninstall(); err != nil {
			status(err.Error())
		} else {
			status("辅助程序已卸载。请通过 IT 批准的方式移除 Chrome 扩展。不会修改服务器或防火墙。")
		}
	}
}

type point struct{ X, Y int32 }
type msg struct {
	Hwnd           uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	Pt             point
	Private        uint32
}
type windowClass struct {
	Size, Style                        uint32
	Proc                               uintptr
	ClassExtra, WindowExtra            int32
	Instance, Icon, Cursor, Background uintptr
	MenuName, ClassName                *uint16
	SmallIcon                          uintptr
}

func windowProc(hwnd uintptr, message uint32, wparam, lparam uintptr) uintptr {
	switch message {
	case 0x111:
		handle(wparam & 0xffff)
		return 0
	case 0x2:
		user32.NewProc("PostQuitMessage").Call(0)
		return 0
	}
	r, _, _ := user32.NewProc("DefWindowProcW").Call(hwnd, uintptr(message), wparam, lparam)
	return r
}
func control(class, text string, x, y, w, h int32, id uintptr) uintptr {
	styles := uintptr(0x50000000)
	if class == "EDIT" {
		styles |= 0x00810080
	} // border, tab stop, horizontal scrolling
	if class == "BUTTON" {
		styles |= 0x10000
	}
	hwnd, _, _ := createWindow.Call(0, uintptr(unsafe.Pointer(ptr(class))), uintptr(unsafe.Pointer(ptr(text))), styles, uintptr(x), uintptr(y), uintptr(w), uintptr(h), mainWindow, id, 0, 0)
	user32.NewProc("SendMessageW").Call(hwnd, 0x30, font, 1)
	return hwnd
}
func main() {
	runtime.LockOSThread()
	exe, err := os.Executable()
	if err == nil {
		bundle, err = lansetup.ReadBundle(exe)
	}
	if len(os.Args) == 2 && os.Args[1] == "--inspect" {
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		json.NewEncoder(os.Stdout).Encode(bundle.Config)
		return
	}
	if err != nil {
		dialog("安装包无法读取："+err.Error(), 0x10)
		return
	}
	installer, err = lansetup.NewInstaller(os.Getenv("LOCALAPPDATA"), lansetup.UserRegistry{}, bundle)
	if err != nil {
		dialog(err.Error(), 0x10)
		return
	}
	user32.NewProc("SetProcessDPIAware").Call()
	instance, _, _ := kernel32.NewProc("GetModuleHandleW").Call(0)
	cursor, _, _ := user32.NewProc("LoadCursorW").Call(0, 32512)
	icon, _, _ := user32.NewProc("LoadIconW").Call(0, 32516)
	class := windowClass{Proc: syscall.NewCallback(windowProc), Instance: instance, Cursor: cursor, Icon: icon, Background: 16, ClassName: ptr("WebZoomLANSetupV1")}
	class.Size = uint32(unsafe.Sizeof(class))
	if r, _, _ := user32.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&class))); r == 0 {
		dialog("无法创建安装窗口。", 0x10)
		return
	}
	// A fixed-size window keeps the short install flow keyboard accessible without a GUI runtime.
	mainWindow, _, _ = createWindow.Call(0, uintptr(unsafe.Pointer(class.ClassName)), uintptr(unsafe.Pointer(ptr("WebZoom 局域网分流 · 安装与检查"))), 0x00ca0000, 0x80000000, 0x80000000, 740, 560, 0, 0, instance, 0)
	if mainWindow == 0 {
		dialog("无法创建安装窗口。", 0x10)
		return
	}
	font, _, _ = gdi32.NewProc("CreateFontW").Call(18, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(ptr("Microsoft YaHei UI"))))
	defer gdi32.NewProc("DeleteObject").Call(font)
	heading := "WebZoom 局域网分流 · 当前用户安装"
	if bundle.Config.TestOnly {
		heading += "（演示包，禁止安装）"
	}
	control("STATIC", heading, 24, 20, 680, 30, 0)
	if bundle.Config.ConfigureOnInstall {
		origin, port := "", ""
		if p, _, e := installer.Installed(); e == nil {
			origin = p.Origin
			port = strconv.Itoa(p.Port)
		}
		control("STATIC", "会议网站（HTTPS，不含路径和结尾斜杠）：", 24, 56, 680, 24, 0)
		originWindow = control("EDIT", origin, 24, 82, 650, 26, 5)
		control("STATIC", "IT 批准的 UDP 端口：", 24, 119, 210, 24, 0)
		portWindow = control("EDIT", port, 244, 115, 150, 27, 6)
		user32.NewProc("SendMessageW").Call(originWindow, 0xc5, 500, 0)
		user32.NewProc("SendMessageW").Call(portWindow, 0xc5, 5, 0)
	} else {
		control("STATIC", fmt.Sprintf("对应网站：%s\r\nUDP 端口：%d\r\n辅助程序负责广播，Chrome 插件连接会议网页。两者必须配套。", bundle.Config.Origin, bundle.Config.Port), 24, 58, 680, 90, 0)
	}
	control("BUTTON", "安装 / 修复", 24, 162, 150, 38, 1)
	control("BUTTON", "检查本机", 186, 162, 150, 38, 2)
	control("BUTTON", "打开扩展文件夹", 348, 162, 165, 38, 3)
	control("BUTTON", "卸载", 525, 162, 150, 38, 4)
	control("BUTTON", "打开 Chrome 扩展页", 24, 210, 210, 34, 7)
	statusWindow = control("STATIC", "", 24, 256, 680, 175, 0)
	initial := "请先确认 IT 已批准使用此软件，再点击「安装 / 修复」。\r\n安装仅影响当前用户，不需要管理员权限，不修改公司网络安全策略。\r\n如果已经安装，可先点击「检查本机」。"
	if bundle.Config.TestOnly {
		initial = "此包仅用于本机开发验证，不能安装到公司电脑。\r\n公司候选包需要实际会议网站和 IT 批准的 UDP 端口。"
	}
	status(initial)
	control("STATIC", "开发候选版 · 尚未签名\r\n请仅从可信的批准渠道获取；不要关闭安全软件或绕过公司安装限制。", 24, 440, 680, 65, 0)
	user32.NewProc("ShowWindow").Call(mainWindow, 1)
	user32.NewProc("UpdateWindow").Call(mainWindow)
	var m msg
	for {
		r, _, _ := user32.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		handled, _, _ := user32.NewProc("IsDialogMessageW").Call(mainWindow, uintptr(unsafe.Pointer(&m)))
		if handled == 0 {
			user32.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&m)))
			user32.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&m)))
		}
	}
}
