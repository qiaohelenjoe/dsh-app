export const LOGIN_PATH = '/login';

export type RequestHeaders = Record<string, string | string[] | undefined>;

/** 请求是否期望 JSON（fetch/XHR）而非浏览器页面。 */
export function wantsJson(headers: RequestHeaders): boolean {
  const accept = headers.accept;
  if (typeof accept === 'string' && accept.includes('application/json')) return true;
  const requestedWith = headers['x-requested-with'];
  return typeof requestedWith === 'string' && requestedWith.toLowerCase() === 'xmlhttprequest';
}

/** 未登录时的浏览器跳转地址（带 next 回跳）。 */
export function buildLoginRedirect(originalUrl: string): string {
  return `${LOGIN_PATH}?next=${encodeURIComponent(originalUrl)}`;
}
