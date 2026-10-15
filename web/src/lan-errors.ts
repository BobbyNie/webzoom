// Keep stable native fault codes aligned with clients/chrome/messages.js.
export function lanErrorText(code: unknown): string {
 const messages:Record<string,string>={
 native_missing:'请先运行配套的 EXE 安装程序，再重新加入会议。',
 policy_invalid:'安装配置损坏，请用配套安装程序修复。',
 site_mismatch:'安装包与会议网站不匹配，请使用该网站的配套安装包。',
 version_mismatch:'插件与辅助程序版本不匹配，请一起更新。',
 network_unsupported:'获批网卡不可用或存在多个 IPv4 网卡，请联系 IT 检查网络选择，不要自行关闭公司 VPN。',
 port_unavailable:'UDP 端口被占用或受系统策略限制，请先退出其他 LAN 会议，并在插件中检查安装和网络。',
 adapter_changed:'网络发生变化，为避免发往错误网络已暂停。请检查安装并重新加入。',
 lease_expired:'会议授权连接中断，请重新连接会议；必要时重新登录。',
 udp_send_failed:'系统无法发送广播，请联系 IT 检查网卡和 UDP 策略。',
 invalid_message:'插件和辅助程序通信不兼容，请使用同一安装包更新。'
 };
 return typeof code==='string'&&Object.hasOwn(messages,code) ? messages[code] : '请点击 Chrome 插件里的「检查安装和网络」，按提示修复；不会自动改为直连。';
}
