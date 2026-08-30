import { describe, expect, it } from 'bun:test'
import { SignJWT } from 'jose'
import {
  createAuthProvider,
  createLocalAuthProvider,
  issueLocalToken,
  type LocalAuthProviderOptions,
  readBearerToken,
} from '../src/index.ts'

const options: LocalAuthProviderOptions = {
  signingKey: 'local-development-signing-key',
  issuer: 'newsdeck-local',
  audience: 'newsdeck',
}

const provider = createLocalAuthProvider(options)

describe('local provider: accepted credentials', () => {
  it('normalises a valid token into an AuthIdentity', async () => {
    const token = await issueLocalToken(options, {
      subject: 'local|reader',
      email: 'reader@example.test',
      displayName: 'Reader',
    })

    const identity = await provider.verifyToken(token)

    expect(identity).toEqual({
      provider: 'local',
      providerUserId: 'local|reader',
      email: 'reader@example.test',
      displayName: 'Reader',
    })
  })

  it('reports absent optional claims as null rather than undefined', async () => {
    const token = await issueLocalToken(options, { subject: 'local|minimal' })

    expect(await provider.verifyToken(token)).toEqual({
      provider: 'local',
      providerUserId: 'local|minimal',
      email: null,
      displayName: null,
    })
  })

  it('exposes no raw provider claims to the domain', async () => {
    const token = await issueLocalToken(options, { subject: 'local|reader' })
    const identity = await provider.verifyToken(token)

    expect(Object.keys(identity ?? {}).sort()).toEqual([
      'displayName',
      'email',
      'provider',
      'providerUserId',
    ])
  })
})

describe('local provider: rejected credentials', () => {
  it('rejects a token signed with a different key', async () => {
    const token = await issueLocalToken(
      { ...options, signingKey: 'a-different-key-entirely' },
      {
        subject: 'local|attacker',
      },
    )

    expect(await provider.verifyToken(token)).toBeNull()
  })

  it('rejects an expired token', async () => {
    const token = await issueLocalToken(options, {
      subject: 'local|reader',
      expiresInSeconds: -60,
    })

    expect(await provider.verifyToken(token)).toBeNull()
  })

  it('rejects a token minted for another issuer', async () => {
    const token = await issueLocalToken(
      { ...options, issuer: 'somewhere-else' },
      {
        subject: 'local|reader',
      },
    )

    expect(await provider.verifyToken(token)).toBeNull()
  })

  it('rejects a token minted for another audience', async () => {
    const token = await issueLocalToken(
      { ...options, audience: 'another-app' },
      {
        subject: 'local|reader',
      },
    )

    expect(await provider.verifyToken(token)).toBeNull()
  })

  it('rejects an unsigned token claiming alg "none"', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'local|attacker',
        iss: options.issuer,
        aud: options.audience,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url')

    expect(await provider.verifyToken(`${header}.${payload}.`)).toBeNull()
  })

  it('rejects a token without a subject', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(options.issuer)
      .setAudience(options.audience)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(options.signingKey))

    expect(await provider.verifyToken(token)).toBeNull()
  })

  it('rejects a token whose subject is blank', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('   ')
      .setIssuer(options.issuer)
      .setAudience(options.audience)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(options.signingKey))

    expect(await provider.verifyToken(token)).toBeNull()
  })

  it('rejects garbage', async () => {
    expect(await provider.verifyToken('not-a-jwt')).toBeNull()
    expect(await provider.verifyToken('')).toBeNull()
  })
})

describe('readBearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc.def.ghi', 'abc.def.ghi'],
    ['Bearer    abc.def.ghi   ', 'abc.def.ghi'],
  ])('extracts the token from %p', (header, expected) => {
    expect(readBearerToken(new Headers({ authorization: header }))).toBe(expected)
  })

  it.each([['Basic dXNlcjpwYXNz'], ['Bearer'], ['Bearer   ']])('returns null for %p', (header) => {
    expect(readBearerToken(new Headers({ authorization: header }))).toBeNull()
  })

  it('returns null when the header is absent', () => {
    expect(readBearerToken(new Headers())).toBeNull()
  })
})

describe('createAuthProvider', () => {
  it('builds the local provider from environment values', async () => {
    const built = createAuthProvider({
      AUTH_PROVIDER: 'local',
      AUTH_ISSUER: options.issuer,
      AUTH_AUDIENCE: options.audience,
      AUTH_LOCAL_SIGNING_KEY: options.signingKey,
    })

    expect(built.name).toBe('local')
    const token = await issueLocalToken(options, { subject: 'local|reader' })
    expect((await built.verifyToken(token))?.providerUserId).toBe('local|reader')
  })
})
