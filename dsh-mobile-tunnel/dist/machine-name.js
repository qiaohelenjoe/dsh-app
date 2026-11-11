import os from 'node:os';
/**
 * 机器身份：直接使用计算机名称（老板要求，替代此前的机器短码）。
 *
 * - 用户认识计算机名，短码陌生；
 * - 名称仅作为设备身份的匹配键，界面上仍优先显示用户自己起的设备名。
 *
 * 取值：Windows 取 `COMPUTERNAME`，其它平台退 `os.hostname()`；统一转小写做比较。
 */
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
let cached;
/** 本机计算机名称（小写）；读不到或格式非法时返回 null。 */
export function computeMachineName() {
    if (cached !== undefined)
        return cached;
    const raw = (process.env.COMPUTERNAME ?? os.hostname() ?? '').trim();
    if (!NAME_PATTERN.test(raw)) {
        cached = null;
        return cached;
    }
    cached = raw.toLowerCase();
    return cached;
}
/** 测试用：注入/清空名称缓存。 */
export function __setMachineNameForTest(name) {
    cached = name;
}
/** 计算机名称格式校验（服务端同口径）。 */
export function isMachineName(value) {
    return NAME_PATTERN.test(value);
}
//# sourceMappingURL=machine-name.js.map