export interface AccountCardState {
  status: 'logged-out' | 'logging-in' | 'online' | 'offline' | 'error';
  deviceName: string;
  accountEmail?: string;
  userCode?: string;
  message?: string;
}

/** 供 DSH 设置页「账号」卡片渲染的纯文本状态（宿主无关）。 */
export function describeAccountCard(state: AccountCardState): string {
  switch (state.status) {
    case 'logged-out':
      return `账号：未登录（设备 ${state.deviceName}）`;
    case 'logging-in':
      return state.userCode
        ? `账号：等待浏览器确认（用户码 ${state.userCode}）`
        : '账号：正在登录…';
    case 'online':
      return `账号：已登录 · 在线${state.accountEmail ? `（${state.accountEmail}）` : ''}`;
    case 'offline':
      return `账号：已登录 · 离线${state.accountEmail ? `（${state.accountEmail}）` : ''}`;
    case 'error':
      return `账号：异常${state.message ? `（${state.message}）` : ''}`;
  }
}

/** 最小 HTML 片段：宿主可把它挂进设置页卡片容器。 */
export function renderAccountCardHtml(state: AccountCardState): string {
  const escaped = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const actions: string[] = [];
  if (state.status === 'logged-out' || state.status === 'error') {
    actions.push('<button data-action="login">登录</button>');
  } else {
    actions.push('<button data-action="logout">登出</button>');
  }
  return [
    '<section class="dsh-mobile-account-card">',
    `  <h3>账号</h3>`,
    `  <p data-status="${escaped(state.status)}">${escaped(describeAccountCard(state))}</p>`,
    `  <p class="device-name">设备：${escaped(state.deviceName)}</p>`,
    `  <div class="actions">${actions.join('')}</div>`,
    '</section>',
  ].join('\n');
}
