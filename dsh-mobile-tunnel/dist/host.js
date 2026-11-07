/**
 * 宿主服务访问助手。
 *
 * `ctx.connection` / `ctx.webServer` / `ctx.settings` 等宿主服务未在插件 `inject` 中声明时
 * 直接属性访问会抛 `cannot get property "xxx" without inject`；而 `ctx.get(name)` 是 Cordis
 * 提供的免 inject 读取，某些版本只暴露 `ctx.reflect.get`。这里统一兜住两种形态。
 */
/** 免 inject 读取宿主服务；不存在或宿主 API 不同都返回 undefined。 */
export function getHostService(ctx, serviceName) {
    try {
        if (typeof ctx.get === 'function')
            return ctx.get(serviceName);
    }
    catch {
        // 某些 Cordis 版本只暴露 ctx.reflect.get
    }
    try {
        const reflect = ctx.reflect;
        if (typeof reflect?.get === 'function')
            return reflect.get(serviceName);
    }
    catch {
        // 忽略，按不可用处理
    }
    return undefined;
}
//# sourceMappingURL=host.js.map