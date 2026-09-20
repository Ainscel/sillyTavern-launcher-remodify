import { invoke } from '@tauri-apps/api/core'

interface LanInterface {
  name?: string
  desc?: string
  is_up?: boolean
  is_virtual?: boolean
  ipv4?: string[]
}

/**
 * 取一个适合给局域网设备访问的本机 IPv4 地址。
 *
 * 优先挑「已启用、非虚拟网卡」的接口——虚拟机 / VPN / Docker 的虚拟网卡
 * 往往也带 IPv4，但它们对应的地址手机是连不上的。
 */
export async function getPreferredLanIpv4(): Promise<string | null> {
  try {
    const res = await invoke<{
      ipv4?: string[]
      ipv6?: string[]
      interfaces?: LanInterface[]
    }>('get_local_ip_addresses')

    // 后端已经按「默认路由所在网卡」挑出了地址，直接用它的结论。
    //
    // 前端不要再自己从网卡列表里挑一遍：那套启发式（非虚拟 / 已启用 / 名字里不含关键字）
    // 挡不住 WSL、Hyper-V、Docker、VPN 这些虚拟网卡，它们往往照样满足条件。
    // 再叠加接口列表来自 HashMap、每次启动顺序都不同，就会表现成
    // 「有时复制出 192.168.x.x，有时变成 10.0.0.1 / 172.30.x.x」。
    const recommended = res?.ipv4?.[0]
    if (recommended) return recommended

    // 兜底：后端没给结论时（例如暂时没有默认路由），再从网卡列表里找一个还算可信的
    const list = Array.isArray(res?.interfaces) ? res.interfaces : []
    const isUsable = (iface: LanInterface) => {
      const name = (iface.name || '').toLowerCase()
      const virtualByName = name.includes('虚拟') || name.includes('virtual')
      return !iface.is_virtual && iface.is_up !== false && !virtualByName && (iface.ipv4?.length ?? 0) > 0
    }
    const preferred = list.find(isUsable) ?? list.find(i => (i.ipv4?.length ?? 0) > 0)
    return preferred?.ipv4?.[0] ?? null
  } catch (e) {
    console.error('获取本机局域网地址失败:', e)
    return null
  }
}
