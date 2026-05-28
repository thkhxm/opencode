import { Schema } from "effect"
import type * as HttpClientError from "effect/unstable/http/HttpClientError"

export const AccountID = Schema.String.pipe(Schema.brand("AccountID"))
export type AccountID = Schema.Schema.Type<typeof AccountID>

export const OrgID = Schema.String.pipe(Schema.brand("OrgID"))
export type OrgID = Schema.Schema.Type<typeof OrgID>

export const AccessToken = Schema.String.pipe(Schema.brand("AccessToken"))
export type AccessToken = Schema.Schema.Type<typeof AccessToken>

export const RefreshToken = Schema.String.pipe(Schema.brand("RefreshToken"))
export type RefreshToken = Schema.Schema.Type<typeof RefreshToken>

export const DeviceCode = Schema.String.pipe(Schema.brand("DeviceCode"))
export type DeviceCode = Schema.Schema.Type<typeof DeviceCode>

export const UserCode = Schema.String.pipe(Schema.brand("UserCode"))
export type UserCode = Schema.Schema.Type<typeof UserCode>

export class Info extends Schema.Class<Info>("Account")({
  id: AccountID,
  email: Schema.String,
  url: Schema.String,
  active_org_id: Schema.NullOr(OrgID),
}) {}

export class Org extends Schema.Class<Org>("Org")({
  id: OrgID,
  name: Schema.String,
}) {}

export class AccountRepoError extends Schema.TaggedErrorClass<AccountRepoError>()("AccountRepoError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class AccountServiceError extends Schema.TaggedErrorClass<AccountServiceError>()("AccountServiceError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class AccountTransportError extends Schema.TaggedErrorClass<AccountTransportError>()("AccountTransportError", {
  method: Schema.String,
  url: Schema.String,
  description: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect),
}) {
  static fromHttpClientError(error: HttpClientError.TransportError): AccountTransportError {
    return new AccountTransportError({
      method: error.request.method,
      url: error.request.url,
      description: error.description,
      cause: error.cause,
    })
  }

  override get message(): string {
    return [
      `Could not reach ${this.method} ${this.url}.`,
      `This failed before the server returned an HTTP response.`,
      this.description,
      `Check your network, proxy, or VPN configuration and try again.`,
    ]
      .filter(Boolean)
      .join("\n")
  }
}

export type AccountError = AccountRepoError | AccountServiceError | AccountTransportError

export class Login extends Schema.Class<Login>("Login")({
  code: DeviceCode,
  user: UserCode,
  url: Schema.String,
  server: Schema.String,
  expiry: Schema.Duration,
  interval: Schema.Duration,
}) {}

export class PollSuccess extends Schema.TaggedClass<PollSuccess>()("PollSuccess", {
  email: Schema.String,
}) {}

export class PollPending extends Schema.TaggedClass<PollPending>()("PollPending", {}) {}

export class PollSlow extends Schema.TaggedClass<PollSlow>()("PollSlow", {}) {}

export class PollExpired extends Schema.TaggedClass<PollExpired>()("PollExpired", {}) {}

export class PollDenied extends Schema.TaggedClass<PollDenied>()("PollDenied", {}) {}

export class PollError extends Schema.TaggedClass<PollError>()("PollError", {
  cause: Schema.Defect,
}) {}

export const PollResult = Schema.Union([PollSuccess, PollPending, PollSlow, PollExpired, PollDenied, PollError])
export type PollResult = Schema.Schema.Type<typeof PollResult>

// ============================================================
// PunkcodeAI 桌面端 credentials login 协议
// ============================================================
// 调用 sub2api 的 /api/v1/cli/{register,login,refresh,me} 系列接口完成账号登录。
// 与 device flow 平行存在；桌面端默认走 credentials，命令行 console login 仍走 device flow。

/** 注册请求 */
export class CredentialsRegister extends Schema.Class<CredentialsRegister>("CredentialsRegister")({
  email: Schema.String,
  password: Schema.String,
  nickname: Schema.String,
}) {}

/** 密码登录请求 */
export class CredentialsLogin extends Schema.Class<CredentialsLogin>("CredentialsLogin")({
  email: Schema.String,
  password: Schema.String,
}) {}

/** 刷新 token 请求 */
export class CredentialsRefresh extends Schema.Class<CredentialsRefresh>("CredentialsRefresh")({
  refresh_token: RefreshToken,
}) {}

/** sub2api 返回的 user 字段子集（仅取桌面端要用的字段） */
export class CredentialsUser extends Schema.Class<CredentialsUser>("CredentialsUser")({
  id: Schema.Number,
  email: Schema.String,
  nickname: Schema.String,
  balance_usd: Schema.Number,
}) {}

/**
 * sub2api 注册 / 登录的成功响应（包裹在 BaseResponse.data 里，由 HTTP 层解包后传给 schema）。
 *
 * 注意：CredentialsUser.id 是 int64，opencode 内部 AccountID 是 brand string。
 * persistAccount 时需 String(id) 后 brand 成 AccountID。
 */
export class CredentialsAuthResponse extends Schema.Class<CredentialsAuthResponse>("CredentialsAuthResponse")({
  access_token: AccessToken,
  refresh_token: RefreshToken,
  expires_in: Schema.Number,
  token_type: Schema.String,
  user: CredentialsUser,
}) {}

/** /cli/refresh 仅返 token，没有 user 字段 */
export class CredentialsTokenPair extends Schema.Class<CredentialsTokenPair>("CredentialsTokenPair")({
  access_token: AccessToken,
  refresh_token: RefreshToken,
  expires_in: Schema.Number,
  token_type: Schema.String,
}) {}

/** /cli/me 返回结构 */
export class CredentialsMe extends Schema.Class<CredentialsMe>("CredentialsMe")({
  id: Schema.Number,
  email: Schema.String,
  nickname: Schema.String,
  balance_usd: Schema.Number,
  used_today_usd: Schema.Number,
  used_month_usd: Schema.Number,
}) {}

/**
 * sub2api 的 envelope 响应包装：{ code, message, data }
 *
 * code === 0 表示成功；非 0 时 message 是错误描述，data 通常为空对象或 null。
 */
export class CredentialsEnvelope<T> extends Schema.Class<CredentialsEnvelope<unknown>>("CredentialsEnvelope")({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.Unknown,
}) {}

/** 业务错误（sub2api 返 code != 0） */
export class CredentialsError extends Schema.TaggedErrorClass<CredentialsError>()("CredentialsError", {
  code: Schema.Number,
  message: Schema.String,
}) {}
