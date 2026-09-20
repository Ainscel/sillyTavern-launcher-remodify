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
    const res = await invoke<{ interfaces?: LanInterface[] }>('get_local_ip_addresses')
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
