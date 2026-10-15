export const messages = Object.freeze({
 local_ready:'本机安装及端口检查通过。还需在会议中确认另一台电脑能收到广播；本次检查没有发送任何广播。',
 native_missing:'尚未安装辅助程序。请运行配套的 WebZoom-LAN-Setup.exe，再重新检查。',
 native_stopped:'辅助程序未能连接。请用配套安装程序修复，并确认公司允许此扩展运行。',
 policy_invalid:'安装配置不完整或损坏。请使用公司提供的安装包修复。',
 site_mismatch:'安装包对应的网站与当前会议不同。请获取该会议网站的配套安装包。',
 version_mismatch:'插件与辅助程序版本不匹配。请使用同一安装包更新两者。',
 network_unsupported:'找不到安装时选择的唯一网卡，或当前存在多个 IPv4 网卡。请让 IT 检查网络选择；不要自行关闭公司 VPN。',
 port_unavailable:'本地 UDP 端口无法使用，可能已被另一场 LAN 会议占用或被系统策略限制。请先退出其他 LAN 会议再检查；仍失败请联系 IT。',
 adapter_changed:'本机网络已改变，为避免发往错误网络，分流已暂停。请重新检查安装并重新加入会议。',
 lease_expired:'会议授权连接已中断，分流已停止。请重新连接会议；必要时重新登录。',
 udp_send_failed:'系统未能发送广播，分流已停止。请让 IT 检查获批网卡和 UDP 策略。',
 invalid_message:'客户端通信内容不兼容，分流已停止。请使用同一安装包更新插件与辅助程序。',
 diagnostic_timeout:'辅助程序没有及时响应。请关闭其他 LAN 会议后重试；仍失败请运行安装程序修复。',
 unconfigured:'此扩展尚未配置会议网站，请使用公司提供的配套安装包。'
});
export function messageFor(code) { return typeof code==='string' && Object.hasOwn(messages,code) ? messages[code] : messages.native_stopped; }
export function disconnectCode(error) {
 return /specified native messaging host not found|native messaging host not found/i.test(error?.message??'') ? 'native_missing' : 'native_stopped';
}
