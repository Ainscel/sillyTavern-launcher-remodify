import { ref } from 'vue'

/**
 * 配置变更版本号。
 *
 * 托盘菜单会直接改写后端的 config.json（启动模式、几个快捷开关），
 * 而设置页持有自己的一份内存副本 `config`，它并不知道这件事。
 * 更麻烦的是设置页有个 `watch(config, ..., { deep: true })` 会全量回写——
 * 用户下次在设置页随便动一下别的开关，就会把托盘改的值覆盖回去。
 *
 * 因此后端改完配置会广播 `app-config-changed`，由 App.vue 自增这里的版本号，
 * 设置页监听它重新拉取配置，保证两边最终一致。
 */
export const configRevision = ref(0)

export const bumpConfigRevision = () => {
  configRevision.value += 1
}
