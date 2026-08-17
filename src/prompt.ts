/**
 * System-prompt guide section for the ESI plugin.
 *
 * The section is deliberately short: it explains the workflow (search → call →
 * materialize) without listing any of the 204 endpoints. The catalog stays out
 * of the prompt; `esi_endpoint_search` is the only way in.
 */

export const ESI_GUIDE_SECTION_NAME = 'esi:guide'

export const ESI_GUIDE = `<esi_guide>
本插件接入 EVE Online ESI 公开 API（204 个端点）。端点目录不在此列出，按以下流程使用：
1. 先用 esi_status 了解当前服务器（国服/世界服）、目录概况与已授权角色。
2. 用 esi_endpoint_search 按关键词或领域（tag，如 Character、Market、Industry、Fleets）查找目标端点，得到精确的 operationId 与必填参数。
3. 用 esi_call 调用任意端点：传 operation_id、path_params（路径模板 {占位符}）、query_params（查询参数）、body（需要时）。分页端点可用 pages="auto" 自动合并所有页，或 pages="first" 只取首页（响应 meta.pages 给出总页数）。
4. 若某端点会被反复使用，用 esi_endpoint_load 将其物化为原生工具 esi_<operationId>，获得逐参数校验；物化数量有上限（默认 30），用 unload 释放。
需要角色/公司私有数据的端点要求 EVE SSO 授权：用 esi_authorize 请求所需 scope（用户需打开返回的登录链接完成 EVE 登录）；esi_accounts 查看已授权角色，esi_deauthorize 撤销。
写入类操作（POST/PUT/DELETE）需要用户批准。
</esi_guide>`
