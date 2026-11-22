// src/shared/qrPayload.ts —— 二维码载荷的展示与动作判定（纯函数，无状态）。
// 载荷形式决定后续动作：URL 可打开、WiFi 配置解出密码、其余复制全文。
// 打开永远是用户点的按钮，绝不自动打开（码的指向未知，先看清再行动）。

export interface QrView {
  /** 面板条目展示文本（WiFi 显示 SSID；超长载荷截断，复制仍取全文） */
  display: string;
  /** http(s) 载荷 → 可「打开」的地址；其余为 null */
  url: string | null;
  /** WiFi 配置载荷解出的密码 → 可「复制密码」；其余为 null */
  wifiPassword: string | null;
}

/** 行内展示上限：vCard 等长载荷会折行撑高整行（.extract-text 无高度截断），
 *  展示截断到 200 码点加省略号；动作与复制永远用完整载荷 */
const MAX_DISPLAY = 200;

/** 二维码载荷 → 面板展示与动作参数。解析只做宽松前缀判定，解析不出按原文展示 */
export function qrView(payload: string): QrView {
  const wifi = parseWifi(payload);
  if (wifi) {
    return {
      display: wifi.ssid ? `Wi-Fi ${wifi.ssid}` : "Wi-Fi",
      url: null,
      wifiPassword: wifi.password,
    };
  }
  const trimmed = payload.trim();
  const chars = [...payload];
  const display =
    chars.length > MAX_DISPLAY ? chars.slice(0, MAX_DISPLAY).join("") + "…" : payload;
  return {
    display,
    url: /^https?:\/\//i.test(trimmed) ? trimmed : null,
    wifiPassword: null,
  };
}

/**
 * 解析 WiFi 配置载荷（WIFI:T:WPA;S:名称;P:密码;;）。
 * WiFi 标准（google/wifi-analytics 规范）的字段顺序不固定、值可含转义
 * （\; \: \\ 与 \,），这里按转义感知切分逐段取 S/P；解析不出返回 null
 */
function parseWifi(payload: string): { ssid: string; password: string } | null {
  if (!payload.startsWith("WIFI:")) return null;
  const body = payload.slice(5);
  let ssid = "";
  let password = "";
  let buf = "";
  const fields: string[] = [];
  // 反斜杠转义感知的逐字符切分（\; 不结束字段）
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\" && i + 1 < body.length) {
      buf += body[i + 1];
      i++;
    } else if (c === ";") {
      fields.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf) fields.push(buf);
  for (const f of fields) {
    if (f.startsWith("S:")) ssid = f.slice(2);
    else if (f.startsWith("P:")) password = f.slice(2);
  }
  if (!ssid && !password) return null;
  return { ssid, password };
}
