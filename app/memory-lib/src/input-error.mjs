// ATOMICWRITE-1 —— 输入校验错误：**调用方的参数问题**，不是服务端故障。
//
// 为什么单独抽出来：同一个仓库里两条入口对非法日期给了不同的东西 ——
// `/v1/date/resolve` 正确地回 422 + 精确 reason，而 `/v1/search` 让异常冒到全局
// catch，回成 `500 INTERNAL`。500 是"我坏了"的意思：它会污染监控、让调用方以为该重试，
// 而真正该做的是修参数。把错误形状收敛到一处，两个入口就不会再漂。
//
// 用法：校验失败时抛 `inputError(code, message)`；服务端最外层 catch 按 `error.status`
// 回状态码，`error.code` 回错误码。

export function inputError(code, message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { code, status, isInputError: true, ...extra });
}

// 常见校验错误的构造器（状态码固定 400：参数不对就是参数不对）。
export const invalidCalendarDate = (value) => inputError(
  "INVALID_CALENDAR_DATE",
  `calendarDate must be a real date in YYYY-MM-DD form, got: ${value}`,
);

export const invalidCalendarTimezone = (value) => inputError(
  "INVALID_CALENDAR_TIMEZONE",
  `calendarTimezone must be an IANA time zone name such as Asia/Shanghai, got: ${value}`,
);
