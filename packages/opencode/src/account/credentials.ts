import { Clock, Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { AccountRepo } from "./repo"
import { normalizeServerUrl } from "./url"
import {
  AccountID,
  AccountServiceError,
  AccountTransportError,
  CredentialsAuthResponse,
  CredentialsEnvelope,
  CredentialsError,
  CredentialsLogin,
  CredentialsRefresh,
  CredentialsRegister,
  CredentialsTokenPair,
  PollSuccess,
  RefreshToken,
  type AccountError,
} from "./schema"

// ============================================================
// PunkcodeAI sub2api credentials 协议适配
// ============================================================
// 这里把 sub2api 的 `/api/v1/cli/{register,login,refresh}` 系列接口接进 opencode
// 的账号存储层。和 device flow 平行存在，不替换它——只新增 3 个 helper：
//   - register(server, { email, password, nickname })
//   - login(server, { email, password })
//   - refresh(server, accountID, refreshToken)
//
// 设计要点：
//   1. 不暴露 Layer / Service，而是导出一个 `makeCredentials({ http, repo })`
//      工厂——这样 account.ts 的 Layer 闭包可以直接把已构造的 HttpClient + repo
//      注入进来，避免在 credentials.ts 里重复装配 layer。
//   2. AccountID 由 `${url}:${email}` 拼接 brand 而成，**不依赖** sub2api 的 int64 id。
//      sub2api 重建数据库或 id 重排时账号本地还能识别同一人，比把远端 id 当主键稳。
//   3. sub2api 返回的是 envelope: `{ code, message, data }`。这里实现了
//      `callApi(schema, request)`，HTTP 层先解 envelope，code != 0 → CredentialsError，
//      code === 0 → 用业务 schema 解 data。
//   4. 错误并集是 `AccountError | CredentialsError`：传输/解码故障落 AccountError，
//      业务（密码错、邮箱占用等）落 CredentialsError。
// ============================================================

const credentialsErrorFromCause = (cause: unknown, message: string): AccountError => {
  if (cause instanceof AccountServiceError || cause instanceof AccountTransportError) {
    return cause
  }

  if (HttpClientError.isHttpClientError(cause)) {
    switch (cause.reason._tag) {
      case "TransportError": {
        return AccountTransportError.fromHttpClientError(cause.reason)
      }
      default: {
        return new AccountServiceError({ message, cause })
      }
    }
  }

  return new AccountServiceError({ message, cause })
}

const mapToAccountError =
  (message = "Credentials request failed") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AccountError, R> =>
    effect.pipe(Effect.mapError((cause) => credentialsErrorFromCause(cause, message)))

export interface CredentialsService {
  readonly register: (
    server: string,
    input: { email: string; password: string; nickname: string },
  ) => Effect.Effect<PollSuccess, AccountError | CredentialsError>
  readonly login: (
    server: string,
    input: { email: string; password: string },
  ) => Effect.Effect<PollSuccess, AccountError | CredentialsError>
  readonly refresh: (
    server: string,
    accountID: AccountID,
    refreshToken: RefreshToken,
  ) => Effect.Effect<void, AccountError | CredentialsError>
}

/**
 * 用 url + email 拼出本地稳定的 AccountID。
 *
 * 不依赖远端 int64 id 的理由：
 *  - sub2api 重建库后 id 会变；用 `${url}:${email}` 拼，本地账号绑定的是"人"
 *    而不是远端临时 id。
 *  - 同一邮箱在多个 sub2api 实例（自部署 / 官方）注册时不会撞库。
 */
const buildAccountID = (url: string, email: string): AccountID => AccountID.make(`${url}:${email}`)

export const makeCredentials = (deps: {
  http: HttpClient.HttpClient
  repo: AccountRepo.Interface
}): CredentialsService => {
  const { http, repo } = deps

  /**
   * 调 sub2api 的某个 endpoint，先解 envelope，再按 data schema 解码。
   *
   * - HTTP 错误（network / 5xx / 4xx 不返 envelope）→ AccountError
   * - HTTP 200 但 envelope.code != 0 → CredentialsError
   * - HTTP 200 且 code == 0 但 data 不符 schema → AccountServiceError（解码失败）
   */
  const callApi = <A, I>(
    schema: Schema.Codec<A, I, never, never>,
    request: HttpClientRequest.HttpClientRequest,
    label: string,
  ): Effect.Effect<A, AccountError | CredentialsError> =>
    Effect.gen(function* () {
      // 注意：不走 filterStatusOk——envelope 在 200 / 400 都可能出现。
      const response = yield* http.execute(request).pipe(mapToAccountError(`${label}: HTTP request failed`))

      const envelope = yield* HttpClientResponse.schemaBodyJson(CredentialsEnvelope)(response).pipe(
        mapToAccountError(`${label}: Failed to decode envelope`),
      )

      if (envelope.code !== 0) {
        return yield* Effect.fail(new CredentialsError({ code: envelope.code, message: envelope.message }))
      }

      return yield* Schema.decodeUnknownEffect(schema)(envelope.data).pipe(
        mapToAccountError(`${label}: Failed to decode response data`),
      )
    })

  /**
   * 拿到 sub2api 返回的 access/refresh/user，写入本地 SQLite 并返回 PollSuccess。
   * register / login 共用。
   */
  const persistAuth = Effect.fnUntraced(function* (server: string, auth: CredentialsAuthResponse) {
    const now = yield* Clock.currentTimeMillis
    const expiry = now + Duration.toMillis(Duration.seconds(auth.expires_in))
    const url = normalizeServerUrl(server)
    const accountID = buildAccountID(url, auth.user.email)

    yield* repo
      .persistAccount({
        id: accountID,
        email: auth.user.email,
        url,
        accessToken: auth.access_token,
        refreshToken: auth.refresh_token,
        expiry,
        // sub2api credentials flow 没有 org 概念，留空。
        orgID: Option.none(),
      })
      .pipe(mapToAccountError("persistAccount failed"))

    return new PollSuccess({ email: auth.user.email })
  })

  const register: CredentialsService["register"] = Effect.fn("Credentials.register")(function* (
    server: string,
    input: { email: string; password: string; nickname: string },
  ) {
    const url = normalizeServerUrl(server)

    const request = yield* HttpClientRequest.post(`${url}/api/v1/cli/register`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.schemaBodyJson(CredentialsRegister)(
        new CredentialsRegister({
          email: input.email,
          password: input.password,
          nickname: input.nickname,
        }),
      ),
      mapToAccountError("Credentials.register: failed to encode body"),
    )

    const auth = yield* callApi(CredentialsAuthResponse, request, "Credentials.register")
    return yield* persistAuth(url, auth)
  })

  const login: CredentialsService["login"] = Effect.fn("Credentials.login")(function* (
    server: string,
    input: { email: string; password: string },
  ) {
    const url = normalizeServerUrl(server)

    const request = yield* HttpClientRequest.post(`${url}/api/v1/cli/login`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.schemaBodyJson(CredentialsLogin)(
        new CredentialsLogin({
          email: input.email,
          password: input.password,
        }),
      ),
      mapToAccountError("Credentials.login: failed to encode body"),
    )

    const auth = yield* callApi(CredentialsAuthResponse, request, "Credentials.login")
    return yield* persistAuth(url, auth)
  })

  const refresh: CredentialsService["refresh"] = Effect.fn("Credentials.refresh")(function* (
    server: string,
    accountID: AccountID,
    refreshToken: RefreshToken,
  ) {
    const url = normalizeServerUrl(server)

    const request = yield* HttpClientRequest.post(`${url}/api/v1/cli/refresh`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.schemaBodyJson(CredentialsRefresh)(
        new CredentialsRefresh({ refresh_token: refreshToken }),
      ),
      mapToAccountError("Credentials.refresh: failed to encode body"),
    )

    const pair = yield* callApi(CredentialsTokenPair, request, "Credentials.refresh")

    const now = yield* Clock.currentTimeMillis
    const expiry = Option.some(now + Duration.toMillis(Duration.seconds(pair.expires_in)))

    yield* repo
      .persistToken({
        accountID,
        accessToken: pair.access_token,
        refreshToken: pair.refresh_token,
        expiry,
      })
      .pipe(mapToAccountError("Credentials.refresh: persistToken failed"))
  })

  return {
    register,
    login,
    refresh,
  }
}

export * as Credentials from "./credentials"
